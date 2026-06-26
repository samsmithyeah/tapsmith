//! Capture and restore an Android app's granted runtime permissions as part of
//! `saveAppState` / `restoreAppState`.
//!
//! Runtime permissions (POST_NOTIFICATIONS, CAMERA, …) live in the system
//! package database, NOT in `/data/data`, and are reset by `pm clear` and by a
//! fresh install. So a permission a test granted once — e.g. dismissing the
//! Android 13+ notification prompt during auth setup — is lost the moment any
//! `pm clear` runs between save and restore, and the app re-prompts on the
//! restored screen. Users reasonably expect to dismiss that dialog once and
//! have it stay dismissed.
//!
//! This captures the app's GRANTED runtime permissions at save time into a
//! reserved archive member ([`PERMISSIONS_ARCHIVE_MEMBER`]) and re-grants them
//! at restore time, so the restored state matches what was saved — prompts
//! included.
//!
//! Gated on root by the caller for parity with the keystore capture (the member
//! is written into the app's data dir, which needs root/run-as). Best-effort:
//! capture failures leave the archive valid; per-permission grant failures on
//! restore are logged and skipped.

use anyhow::{Context, Result};
use tracing::{debug, warn};

use crate::adb;

/// Reserved archive member holding the newline-separated list of granted
/// runtime permissions. Written into the data dir, read and removed on restore.
pub const PERMISSIONS_ARCHIVE_MEMBER: &str = ".tapsmith-android-permissions.txt";

/// Capture the app's granted runtime permissions into a member file in the data
/// dir (picked up by the data-dir tar). Returns whether a member was written.
pub async fn capture_into_data_dir(serial: &str, pkg: &str, data_dir: &str) -> Result<bool> {
    let dump = match adb::shell(serial, &format!("dumpsys package {pkg}")).await {
        Ok(d) => d,
        Err(e) => {
            warn!(%pkg, error = %e, "Failed to read package dump; runtime permissions not captured");
            return Ok(false);
        }
    };
    let granted = parse_granted_runtime_permissions(&dump);
    if granted.is_empty() {
        return Ok(false);
    }

    let member_path = format!("{data_dir}/{PERMISSIONS_ARCHIVE_MEMBER}");
    adb::push_text(serial, &granted.join("\n"), &member_path)
        .await
        .context("write permissions member into data dir")?;
    debug!(%pkg, count = granted.len(), "Captured granted runtime permissions into archive member");
    Ok(true)
}

/// Re-grant the captured runtime permissions after the archive is extracted.
/// Returns whether a member was present.
pub async fn restore_from_data_dir(serial: &str, pkg: &str, data_dir: &str) -> Result<bool> {
    let member_path = format!("{data_dir}/{PERMISSIONS_ARCHIVE_MEMBER}");
    let exists = adb::shell_lenient(serial, &format!("test -f {member_path} && echo yes"))
        .await
        .map(|o| o.trim() == "yes")
        .unwrap_or(false);
    if !exists {
        return Ok(false);
    }

    let body = adb::shell_lenient(serial, &format!("cat {member_path}"))
        .await
        .unwrap_or_default();
    for perm in body.lines().map(str::trim).filter(|l| !l.is_empty()) {
        // Defense-in-depth: the name is interpolated into a root `pm grant` shell
        // command, so reject anything that isn't a bare permission identifier in
        // case the on-device archive was tampered with.
        if !is_valid_permission_name(perm) {
            warn!(%pkg, %perm, "Skipping restore of malformed permission name");
            continue;
        }
        // Lenient: a permission may not be grantable in the app's current state
        // (e.g. since removed from the manifest); one failure must not abort the
        // rest. `pm grant` prints to stderr but still exits 0 on some errors, so
        // we don't inspect the result beyond logging transport failures.
        if let Err(e) = adb::shell(serial, &format!("pm grant {pkg} {perm}")).await {
            debug!(%pkg, %perm, error = %e, "Could not re-grant runtime permission");
        }
    }

    let _ = adb::shell_lenient(serial, &format!("rm -f {member_path}")).await;
    debug!(%pkg, "Restored granted runtime permissions from archive member");
    Ok(true)
}

/// Extract the GRANTED runtime permission names from `dumpsys package` output.
///
/// Runtime permission lines carry a `flags=[...]` suffix
/// (`<name>: granted=true, flags=[…]`) that install-time permissions
/// (`<name>: granted=true` alone) lack — matching on that suffix is how we keep
/// to permissions `pm grant` can actually grant.
fn parse_granted_runtime_permissions(dump: &str) -> Vec<String> {
    let mut perms: Vec<String> = Vec::new();
    for line in dump.lines() {
        let line = line.trim();
        if !line.contains("granted=true, flags=[") {
            continue;
        }
        if let Some((name, _)) = line.split_once(": granted=true") {
            let name = name.trim();
            // The name is later interpolated into a root `pm grant` command;
            // only accept bare permission identifiers so a malicious app can't
            // smuggle shell metacharacters in via a custom permission.
            if is_valid_permission_name(name) && !perms.iter().any(|p| p == name) {
                perms.push(name.to_string());
            }
        }
    }
    perms
}

/// A permission name safe to pass to `pm grant`: a non-empty bare identifier of
/// ASCII alphanumerics, dots and underscores (no shell metacharacters).
fn is_valid_permission_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_only_granted_runtime_permissions() {
        // Real-world shape: a granted runtime perm (has flags), a denied runtime
        // perm, and install-time perms (granted=true, no flags) that must NOT be
        // captured because `pm grant` can't grant them.
        let dump = "\
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED]
        android.permission.CAMERA: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED]
        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET]
      install permissions:
        android.permission.INTERNET: granted=true
        android.permission.VIBRATE: granted=true
";
        let perms = parse_granted_runtime_permissions(dump);
        assert_eq!(
            perms,
            vec![
                "android.permission.POST_NOTIFICATIONS".to_string(),
                "android.permission.RECORD_AUDIO".to_string(),
            ]
        );
    }

    #[test]
    fn empty_when_nothing_granted() {
        let dump = "\
      runtime permissions:
        android.permission.CAMERA: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED]
      install permissions:
        android.permission.INTERNET: granted=true
";
        assert!(parse_granted_runtime_permissions(dump).is_empty());
    }

    #[test]
    fn rejects_permission_names_with_shell_metacharacters() {
        // A custom permission whose name carries a shell injection payload must
        // not be captured (it would otherwise reach a root `pm grant`).
        let dump = "\
        com.evil.perm; rm -rf /: granted=true, flags=[ USER_SET]
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET]
";
        assert_eq!(
            parse_granted_runtime_permissions(dump),
            vec!["android.permission.POST_NOTIFICATIONS".to_string()]
        );
    }

    #[test]
    fn dedupes_repeated_permissions() {
        // Multi-user dumps can list the same perm under more than one user.
        let dump = "\
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET]
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET]
";
        assert_eq!(
            parse_granted_runtime_permissions(dump),
            vec!["android.permission.POST_NOTIFICATIONS".to_string()]
        );
    }
}
