//! Capture and restore an Android app's AndroidKeyStore (keystore2) keys as
//! part of `saveAppState` / `restoreAppState`.
//!
//! Firebase Auth (and other SDKs) persist credentials *inside* the app data dir
//! encrypted with a Tink keyset that is itself wrapped by an AndroidKeyStore key
//! (e.g. `firebear_main_key_id_for_storage_crypto`). That key lives in
//! keystore2's database at [`KEYSTORE_DB`], OUTSIDE the data dir, and is
//! destroyed by `pm clear`. Archiving only `/data/data` therefore captures the
//! ciphertext but not the key — so once any `pm clear` runs between save and
//! restore (e.g. a sibling login project resetting the app), the restored
//! credentials can't be decrypted and the app comes back signed out.
//!
//! This module captures the app's keystore2 rows at save time into a portable
//! SQL re-insert script, stored as a reserved member ([`KEYSTORE_ARCHIVE_MEMBER`])
//! inside the state archive, and re-inserts them at restore time so the saved
//! credentials decrypt again — regardless of intervening `pm clear`s.
//!
//! Constraints (the same ones the in-place data clear already lives with):
//!  - ROOT only: keystore2's database is not reachable via `run-as`.
//!  - SAME-DEVICE only: the key blobs are wrapped by a per-device super key
//!    that never leaves the device, so the archive is not portable across
//!    devices (exactly like the encrypted app data it complements).
//!
//! All failures are non-fatal on the save path (the archive stays valid, just
//! without keystore state) and surfaced on the restore path (a silent failure
//! would reproduce the signed-out bug this exists to fix).

use anyhow::{bail, Context, Result};
use std::time::Duration;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::adb;

/// Reserved archive member holding the captured keystore re-insert script.
/// Stored at the root of the data-dir archive; read and removed on restore.
pub const KEYSTORE_ARCHIVE_MEMBER: &str = ".tapsmith-android-keystore.sql";

/// keystore2's on-device database.
const KEYSTORE_DB: &str = "/data/misc/keystore/persistent.sqlite";

/// Placeholder for the app uid, substituted at restore time. The uid can change
/// if the app was reinstalled between save and restore, so the script binds the
/// rows to whatever uid the app has when the state is restored.
const UID_PLACEHOLDER: &str = "__TAPSMITH_UID__";

const SQLITE_TIMEOUT: Duration = Duration::from_secs(30);

/// Resolve the app's Linux uid (keystore2 namespaces app keys by uid).
async fn app_uid(serial: &str, data_dir: &str) -> Option<String> {
    let out = adb::shell_lenient(serial, &format!("stat -c '%u' {data_dir}"))
        .await
        .ok()?;
    let uid = out.trim().to_string();
    if !uid.is_empty() && uid.chars().all(|c| c.is_ascii_digit()) {
        Some(uid)
    } else {
        None
    }
}

/// True if `sqlite3` is available on the device.
async fn has_sqlite3(serial: &str) -> bool {
    adb::shell_lenient(serial, "which sqlite3")
        .await
        .map(|s| s.trim().contains("sqlite3"))
        .unwrap_or(false)
}

/// Run a SQL script (provided as text) against [`KEYSTORE_DB`] and return
/// stdout. The script is delivered as a pushed file so SQL parentheses and
/// quotes are parsed by sqlite3, not the device shell.
async fn run_sqlite(serial: &str, sql: &str) -> Result<String> {
    let remote = format!("/data/local/tmp/tapsmith-ks-{}.sql", Uuid::new_v4());
    // Guard removes the pushed script even if this future is cancelled/panics.
    let mut guard = adb::DeviceFileGuard::new(serial);
    guard.track(&remote);
    adb::push_text(serial, sql, &remote).await?;
    let result = adb::shell_with_timeout(
        serial,
        &format!("sqlite3 {KEYSTORE_DB} < {remote}"),
        SQLITE_TIMEOUT,
    )
    .await;
    result.context("run sqlite3")
}

/// Capture the app's keystore2 rows and, if any exist, write a re-insert script
/// to `{data_dir}/{KEYSTORE_ARCHIVE_MEMBER}` so the subsequent `tar` of the data
/// dir embeds it in the archive. Returns whether a member was written.
///
/// Caller must have verified root access (keystore2's DB is root-only). The app
/// must be force-stopped already (the save path does this).
pub async fn capture_into_data_dir(serial: &str, pkg: &str, data_dir: &str) -> Result<bool> {
    let Some(uid) = app_uid(serial, data_dir).await else {
        debug!(%pkg, "Could not resolve app uid; skipping keystore capture");
        return Ok(false);
    };
    if !has_sqlite3(serial).await {
        warn!(%pkg, "sqlite3 not found on device; keystore state will not be captured");
        return Ok(false);
    }

    // Pull every column via quote() so the output is uniformly NULL-safe and
    // type-preserving (ints stay bare, blobs become X'..', NULL becomes NULL),
    // tagged per source table with a '|' separator that none of those forms
    // contain. Dependent rows are scoped to the app's keyentries by namespace.
    let query = format!(
        r#".mode list
.separator |
PRAGMA busy_timeout=5000;
SELECT 'KE',quote(id),quote(key_type),quote(domain),quote(state),quote(alias),quote(km_uuid) FROM keyentry WHERE namespace={uid};
SELECT 'BE',quote(be.id),quote(be.subcomponent_type),quote(be.keyentryid),quote(be.blob) FROM blobentry be JOIN keyentry ke ON be.keyentryid=ke.id WHERE ke.namespace={uid};
SELECT 'BM',quote(bm.blobentryid),quote(bm.tag),quote(bm.data) FROM blobmetadata bm JOIN blobentry be ON bm.blobentryid=be.id JOIN keyentry ke ON be.keyentryid=ke.id WHERE ke.namespace={uid};
SELECT 'KP',quote(kp.keyentryid),quote(kp.tag),quote(kp.data),quote(kp.security_level) FROM keyparameter kp JOIN keyentry ke ON kp.keyentryid=ke.id WHERE ke.namespace={uid};
SELECT 'KM',quote(km.keyentryid),quote(km.tag),quote(km.data) FROM keymetadata km JOIN keyentry ke ON km.keyentryid=ke.id WHERE ke.namespace={uid};
"#
    );

    let rows = match run_sqlite(serial, &query).await {
        Ok(out) => out,
        Err(e) => {
            warn!(%pkg, error = %e, "Failed to read keystore DB; archive will not include keystore state");
            return Ok(false);
        }
    };

    let Some(script) = build_restore_script(&rows) else {
        debug!(%pkg, "No AndroidKeyStore keys for app; nothing to capture");
        return Ok(false);
    };

    let member_path = format!("{data_dir}/{KEYSTORE_ARCHIVE_MEMBER}");
    adb::push_text(serial, &script, &member_path)
        .await
        .context("write keystore member into data dir")?;
    debug!(%pkg, "Captured AndroidKeyStore state into archive member");
    Ok(true)
}

/// Split a `quote()`-tagged output line on `separator`, ignoring separators that
/// fall inside single-quoted SQL string literals.
///
/// `quote()` emits text aliases as quoted strings (`'…'`), and an alias can
/// legitimately contain the `|` separator — a naive `split('|')` would shatter
/// such a row into too many parts and silently drop it. SQLite escapes embedded
/// quotes by doubling them (`''`), which toggles `in_quotes` twice and so leaves
/// the state correct; blob (`X'..'`), integer and `NULL` forms never contain
/// `|` and pass through unchanged.
fn split_quoted(line: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for c in line.chars() {
        if c == '\'' {
            in_quotes = !in_quotes;
            current.push(c);
        } else if c == separator && !in_quotes {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    parts
}

/// Build the SQL re-insert script from the tagged `quote()` rows produced by the
/// capture query. Returns `None` when there are no keyentry rows.
///
/// keyentry ids are kept verbatim (keystore2 assigns random 64-bit ids, so they
/// don't collide), and `namespace` is bound to [`UID_PLACEHOLDER`]. blobentry
/// ids — sequential rowids that *could* collide — are reassigned by sqlite on
/// insert; a temp `_be_map` carries old→new so blobmetadata can find its parent.
fn build_restore_script(rows: &str) -> Option<String> {
    let mut keyentry: Vec<Vec<String>> = Vec::new();
    let mut blobentry: Vec<Vec<String>> = Vec::new();
    let mut blobmetadata: Vec<Vec<String>> = Vec::new();
    let mut keyparameter: Vec<Vec<String>> = Vec::new();
    let mut keymetadata: Vec<Vec<String>> = Vec::new();

    for line in rows.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let parts = split_quoted(line, '|');
        match parts[0].as_str() {
            "KE" if parts.len() == 7 => keyentry.push(parts[1..].to_vec()),
            "BE" if parts.len() == 5 => blobentry.push(parts[1..].to_vec()),
            "BM" if parts.len() == 4 => blobmetadata.push(parts[1..].to_vec()),
            "KP" if parts.len() == 5 => keyparameter.push(parts[1..].to_vec()),
            "KM" if parts.len() == 4 => keymetadata.push(parts[1..].to_vec()),
            _ => {}
        }
    }

    if keyentry.is_empty() {
        return None;
    }

    let mut s = String::new();
    // busy_timeout: `stop keystore2` is async, so the service may still hold a
    // lock on the DB when sqlite3 runs — wait for it rather than failing fast.
    s.push_str("PRAGMA foreign_keys=OFF;\nPRAGMA busy_timeout=5000;\nBEGIN;\n");
    s.push_str("CREATE TEMP TABLE _be_map(old INTEGER PRIMARY KEY, new INTEGER);\n");

    // Purge any pre-existing rows for this namespace so a re-insert can't hit a
    // UNIQUE(alias) conflict (e.g. if the app regenerated a key since the clear).
    let ns = format!("(SELECT id FROM keyentry WHERE namespace={UID_PLACEHOLDER})");
    s.push_str(&format!(
        "DELETE FROM blobmetadata WHERE blobentryid IN (SELECT id FROM blobentry WHERE keyentryid IN {ns});\n"
    ));
    s.push_str(&format!(
        "DELETE FROM blobentry WHERE keyentryid IN {ns};\n"
    ));
    s.push_str(&format!(
        "DELETE FROM keyparameter WHERE keyentryid IN {ns};\n"
    ));
    s.push_str(&format!(
        "DELETE FROM keymetadata WHERE keyentryid IN {ns};\n"
    ));
    s.push_str(&format!(
        "DELETE FROM keyentry WHERE namespace={UID_PLACEHOLDER};\n"
    ));

    // keyentry: cols = id, key_type, domain, state, alias, km_uuid (namespace
    // is bound to the live uid, not the captured one).
    for r in &keyentry {
        s.push_str(&format!(
            "INSERT INTO keyentry(id,key_type,domain,namespace,alias,state,km_uuid) VALUES({},{},{},{},{},{},{});\n",
            r[0], r[1], r[2], UID_PLACEHOLDER, r[4], r[3], r[5]
        ));
    }

    // blobentry: cols = id(orig), subcomponent_type, keyentryid, blob. Insert
    // without id so sqlite assigns a fresh rowid, then record old→new.
    for r in &blobentry {
        s.push_str(&format!(
            "INSERT INTO blobentry(subcomponent_type,keyentryid,blob) VALUES({},{},{});\n",
            r[1], r[2], r[3]
        ));
        s.push_str(&format!(
            "INSERT INTO _be_map(old,new) VALUES({},last_insert_rowid());\n",
            r[0]
        ));
    }

    // blobmetadata: cols = blobentryid(orig), tag, data → remap via _be_map.
    for r in &blobmetadata {
        s.push_str(&format!(
            "INSERT INTO blobmetadata(blobentryid,tag,data) VALUES((SELECT new FROM _be_map WHERE old={}),{},{});\n",
            r[0], r[1], r[2]
        ));
    }

    // keyparameter: cols = keyentryid, tag, data, security_level.
    for r in &keyparameter {
        s.push_str(&format!(
            "INSERT INTO keyparameter(keyentryid,tag,data,security_level) VALUES({},{},{},{});\n",
            r[0], r[1], r[2], r[3]
        ));
    }

    // keymetadata: cols = keyentryid, tag, data.
    for r in &keymetadata {
        s.push_str(&format!(
            "INSERT INTO keymetadata(keyentryid,tag,data) VALUES({},{},{});\n",
            r[0], r[1], r[2]
        ));
    }

    s.push_str("COMMIT;\n");
    Some(s)
}

/// After the data archive has been extracted into `data_dir`, re-insert any
/// captured keystore rows. Returns whether a keystore member was present (and
/// thus restored). Errors are returned so the caller can fail the restore — a
/// silent failure would reproduce the signed-out bug this feature fixes.
///
/// Caller must have root (checked by the restore path's `is_root`).
pub async fn restore_from_data_dir(serial: &str, pkg: &str, data_dir: &str) -> Result<bool> {
    let member_path = format!("{data_dir}/{KEYSTORE_ARCHIVE_MEMBER}");
    let exists = adb::shell_lenient(serial, &format!("test -f {member_path} && echo yes"))
        .await
        .map(|o| o.trim() == "yes")
        .unwrap_or(false);
    if !exists {
        return Ok(false);
    }

    // Clean up the member from the data dir regardless of how we exit — it must
    // not linger inside the app's files, even if this future is cancelled.
    let mut guard = adb::DeviceFileGuard::new(serial);
    guard.track(&member_path);

    let Some(uid) = app_uid(serial, data_dir).await else {
        bail!("could not resolve app uid for keystore restore");
    };

    // Bind the captured rows to the live uid.
    if let Err(e) = adb::shell(
        serial,
        &format!("sed -i 's/{UID_PLACEHOLDER}/{uid}/g' {member_path}"),
    )
    .await
    {
        bail!("failed to bind keystore rows to uid {uid}: {e}");
    }

    // Critical section: once keystore2 is stopped it MUST be restarted, or the
    // device's crypto services stay broken. Run it in a detached task so that if
    // *this* future is cancelled (client disconnect, restore timeout) the
    // stop→edit→start sequence still runs to completion rather than leaving
    // keystore2 down.
    let serial_owned = serial.to_string();
    let member_owned = member_path.clone();
    let critical = tokio::spawn(async move {
        let serial = serial_owned.as_str();
        let member_path = member_owned.as_str();

        // keystore2 holds the DB open and caches it, so edit it while the
        // service is stopped, then restart so it reads the re-inserted rows.
        let stop = adb::shell(serial, "stop keystore2").await;

        // `stop keystore2` returns before the service has actually stopped, so
        // wait (best effort) for its init status to flip to `stopped` before
        // touching the DB. This avoids editing while keystore2 still holds it
        // open; the PRAGMA busy_timeout in the script backstops any residual
        // lock contention if the poll can't confirm a stop (e.g. a shell without
        // fractional sleep, where the loop just falls through immediately).
        if stop.is_ok() {
            let _ = adb::shell_lenient(
                serial,
                "for i in $(seq 1 50); do \
                 [ \"$(getprop init.svc.keystore2)\" = stopped ] && break; sleep 0.1; done",
            )
            .await;
        }

        // Only touch the DB if keystore2 actually stopped — editing it while the
        // service still holds it open risks corruption.
        let edit = if stop.is_ok() {
            run_member_script(serial, member_path).await
        } else {
            Err(anyhow::anyhow!("skipped re-insert: keystore2 did not stop"))
        };

        // Keep ownership/SELinux context correct for keystore2 to reopen the DB.
        // The glob covers the -wal/-shm/-journal sidecars sqlite3 may create as
        // root; left root-owned, keystore2 (the `keystore` user) can't open them
        // and crashes on restart.
        let _ = adb::shell_lenient(
            serial,
            &format!("chown keystore:keystore {KEYSTORE_DB}*; restorecon {KEYSTORE_DB}*"),
        )
        .await;

        // Always attempt to restart keystore2 — even if stop or the edit failed —
        // so a half-finished restore never leaves the service down.
        let start = adb::shell(serial, "start keystore2").await;

        stop.map_err(|e| anyhow::anyhow!("failed to stop keystore2: {e}"))?;
        edit?;
        start.context("failed to restart keystore2")?;
        Ok::<(), anyhow::Error>(())
    });

    let outcome = critical.await;
    // `guard` removes the member on drop (here, or on cancellation above).

    match outcome {
        Ok(Ok(())) => {
            debug!(%pkg, "Restored AndroidKeyStore state from archive member");
            Ok(true)
        }
        Ok(Err(e)) => Err(e),
        Err(join_err) => bail!("keystore restore task panicked: {join_err}"),
    }
}

/// Run the (uid-substituted) member script against the keystore DB and verify
/// sqlite reported no error.
async fn run_member_script(serial: &str, member_path: &str) -> Result<()> {
    let out = adb::shell_with_timeout(
        serial,
        &format!("sqlite3 {KEYSTORE_DB} < {member_path} 2>&1; echo TAPSMITH_RC=$?"),
        SQLITE_TIMEOUT,
    )
    .await
    .context("run keystore re-insert script")?;

    let rc_ok = out
        .lines()
        .find_map(|l| l.trim().strip_prefix("TAPSMITH_RC="))
        .map(|rc| rc == "0")
        .unwrap_or(false);
    // sqlite3 prints errors to stderr (merged via 2>&1) and a non-zero rc.
    let had_error = out
        .lines()
        .any(|l| l.contains("Error:") || l.to_lowercase().contains("sql error"));

    if !rc_ok || had_error {
        bail!("keystore re-insert failed: {}", out.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_without_keyentries() {
        // Dependent rows but no keyentry → nothing to restore.
        assert!(build_restore_script("BE|5|1|123|X'00'\n").is_none());
        assert!(build_restore_script("").is_none());
    }

    #[test]
    fn builds_reinsert_script_with_uid_binding_and_blob_remap() {
        // One keyentry (random id kept), one blobentry (id remapped) with two
        // blobmetadata rows, plus a keyparameter and keymetadata.
        let rows = "\
KE|7733|2|0|1|X'6669726562656172'|X'abcd'
BE|555|1|7733|X'deadbeef'
BM|555|100|X'00'
BM|555|101|42
KP|7733|200|X'11'|1
KM|7733|300|NULL
";
        let script = build_restore_script(rows).expect("script");

        // keyentry: original id preserved, namespace bound to the placeholder
        // (not the captured namespace), columns in the right order.
        assert!(script.contains(
            "INSERT INTO keyentry(id,key_type,domain,namespace,alias,state,km_uuid) \
             VALUES(7733,2,0,__TAPSMITH_UID__,X'6669726562656172',1,X'abcd');"
        ));
        // Purge existing rows for the namespace before re-insert.
        assert!(script.contains("DELETE FROM keyentry WHERE namespace=__TAPSMITH_UID__;"));
        // blobentry inserted without an id (fresh rowid) and mapped old→new.
        assert!(script.contains(
            "INSERT INTO blobentry(subcomponent_type,keyentryid,blob) VALUES(1,7733,X'deadbeef');"
        ));
        assert!(script.contains("INSERT INTO _be_map(old,new) VALUES(555,last_insert_rowid());"));
        // blobmetadata resolves its parent through the map, not the stale id.
        assert!(script.contains(
            "INSERT INTO blobmetadata(blobentryid,tag,data) \
             VALUES((SELECT new FROM _be_map WHERE old=555),100,X'00');"
        ));
        assert!(script.contains(
            "INSERT INTO blobmetadata(blobentryid,tag,data) \
             VALUES((SELECT new FROM _be_map WHERE old=555),101,42);"
        ));
        // keyparameter / keymetadata keyed by the (kept) keyentry id; NULL safe.
        assert!(script.contains(
            "INSERT INTO keyparameter(keyentryid,tag,data,security_level) VALUES(7733,200,X'11',1);"
        ));
        assert!(
            script.contains("INSERT INTO keymetadata(keyentryid,tag,data) VALUES(7733,300,NULL);")
        );
        // Wrapped in a transaction.
        assert!(script.trim_start().starts_with("PRAGMA foreign_keys=OFF;"));
        assert!(script.trim_end().ends_with("COMMIT;"));
    }

    #[test]
    fn alias_containing_separator_is_not_shattered() {
        // An alias quoted by sqlite that legitimately contains the '|' separator
        // must still parse as a single 7-column keyentry row.
        let rows = "KE|1|2|0|1|'we|ird'|X'bb'\n";
        let script = build_restore_script(rows).expect("script");
        assert!(script.contains(
            "INSERT INTO keyentry(id,key_type,domain,namespace,alias,state,km_uuid) \
             VALUES(1,2,0,__TAPSMITH_UID__,'we|ird',1,X'bb');"
        ));
    }

    #[test]
    fn split_quoted_handles_doubled_quotes() {
        // SQLite escapes an embedded quote by doubling it; the separator inside
        // such a literal must still be ignored.
        assert_eq!(
            split_quoted("a|'x''|y'|b", '|'),
            vec!["a".to_string(), "'x''|y'".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn ignores_malformed_lines() {
        // A short/garbled line for a tag is skipped, but the keyentry still
        // yields a script.
        let rows = "KE|1|2|0|1|X'aa'|X'bb'\nBE|broken\nrandom noise\n";
        let script = build_restore_script(rows).expect("script");
        assert!(script.contains("INSERT INTO keyentry"));
        assert!(!script.contains("INSERT INTO blobentry"));
    }
}
