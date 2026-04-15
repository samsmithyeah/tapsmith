use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, instrument};

/// Locate the `xcrun` binary on PATH.
pub async fn find_xcrun() -> Result<PathBuf> {
    let output = Command::new("which")
        .arg("xcrun")
        .output()
        .await
        .context("Failed to execute `which xcrun`")?;

    if !output.status.success() {
        bail!("xcrun not found on PATH. Xcode Command Line Tools are required for iOS support.");
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(PathBuf::from(path))
}

/// Parsed iOS device/simulator entry.
#[derive(Debug, Clone)]
pub struct IosDevice {
    pub udid: String,
    pub name: String,
    pub state: String,
    pub is_simulator: bool,
    /// Physical-only: whether devicectl reports this device as paired. Always
    /// true for simulators (they have no pairing concept).
    #[allow(dead_code)]
    pub is_paired: bool,
    /// Physical-only: whether devicectl reports Developer Disk Image services
    /// as available. Required for XCUITest runs. Always true for simulators.
    #[allow(dead_code)]
    pub ddi_services_available: bool,
    /// Physical-only: iOS version string (e.g. "18.2"). Empty for simulators
    /// (runtime is stored separately for those).
    #[allow(dead_code)]
    pub os_version: String,
}

impl IosDevice {
    pub fn is_booted(&self) -> bool {
        self.state == "Booted"
    }
}

/// List available iOS simulators.
#[instrument]
pub async fn list_simulators() -> Result<Vec<IosDevice>> {
    let output = Command::new("xcrun")
        .args(["simctl", "list", "devices", "--json"])
        .output()
        .await
        .context("Failed to run xcrun simctl list devices")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("xcrun simctl list devices failed: {stderr}");
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value =
        serde_json::from_str(&json_str).context("Failed to parse simctl JSON output")?;

    let mut devices = Vec::new();

    if let Some(device_map) = value.get("devices").and_then(|d| d.as_object()) {
        for (runtime, device_list) in device_map {
            // Runtime key looks like `com.apple.CoreSimulator.SimRuntime.iOS-18-1`;
            // produce a user-facing "18.1". Non-iOS runtimes (watchOS, tvOS)
            // just fall through with an empty version — we don't surface them
            // in list-devices today.
            let runtime_version = parse_simctl_runtime_version(runtime);
            if let Some(list) = device_list.as_array() {
                for device in list {
                    let udid = device
                        .get("udid")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = device
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let state = device
                        .get("state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Shutdown")
                        .to_string();
                    let is_available = device
                        .get("isAvailable")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    if !udid.is_empty() && is_available {
                        devices.push(IosDevice {
                            udid,
                            name,
                            state,
                            is_simulator: true,
                            is_paired: true,
                            ddi_services_available: true,
                            os_version: runtime_version.clone(),
                        });
                    }
                }
            }
        }
    }

    debug!(count = devices.len(), "Listed iOS simulators");
    Ok(devices)
}

/// Parse a simctl runtime identifier (e.g.
/// `com.apple.CoreSimulator.SimRuntime.iOS-18-1`) into a human-friendly
/// version string (`18.1`). Returns an empty string for non-iOS runtimes
/// or when the identifier doesn't match the expected shape.
fn parse_simctl_runtime_version(runtime: &str) -> String {
    let Some(tail) = runtime.strip_prefix("com.apple.CoreSimulator.SimRuntime.iOS-") else {
        return String::new();
    };
    tail.replace('-', ".")
}

/// List connected physical iOS devices via devicectl.
///
/// Writes devicectl JSON output to a scratch file rather than `/dev/stdout`
/// because devicectl intermixes provisioning warnings on stdout when the
/// device is unpaired or DDI services are unavailable, which breaks naive
/// stdout parsing.
pub async fn list_physical_devices() -> Result<Vec<IosDevice>> {
    let json_path =
        std::env::temp_dir().join(format!("pilot-devicectl-list-{}.json", std::process::id()));
    let json_path_str = json_path.to_string_lossy().to_string();

    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "list",
            "devices",
            "--json-output",
            &json_path_str,
        ])
        .output()
        .await;

    // Read the JSON file regardless of whether stdout parsing succeeded —
    // devicectl sometimes writes warnings to stderr but still produces valid
    // JSON in the output file.
    let result = match output {
        Ok(_) => match tokio::fs::read_to_string(&json_path).await {
            Ok(json_str) => parse_devicectl_devices(&json_str),
            Err(e) => {
                debug!("devicectl JSON file not readable: {e}");
                Ok(Vec::new())
            }
        },
        Err(e) => {
            debug!("devicectl not available, skipping physical device listing: {e}");
            Ok(Vec::new())
        }
    };

    // Best-effort cleanup of the scratch file
    let _ = tokio::fs::remove_file(&json_path).await;

    result
}

fn parse_devicectl_devices(json_str: &str) -> Result<Vec<IosDevice>> {
    let value: serde_json::Value =
        serde_json::from_str(json_str).context("Failed to parse devicectl JSON output")?;

    let mut devices = Vec::new();
    let Some(device_list) = value
        .get("result")
        .and_then(|r| r.get("devices"))
        .and_then(|d| d.as_array())
    else {
        return Ok(devices);
    };

    for device in device_list {
        // Only include iOS devices. devicectl also lists paired Apple Watches,
        // Apple TVs, etc. — filter to iOS-family devices so downstream code
        // can assume iOS semantics.
        let platform = device
            .pointer("/hardwareProperties/platform")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if platform != "iOS" {
            continue;
        }

        let udid = device
            .pointer("/hardwareProperties/udid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = device
            .pointer("/deviceProperties/name")
            .and_then(|v| v.as_str())
            .or_else(|| device.get("name").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        let pairing_state = device
            .pointer("/connectionProperties/pairingState")
            .and_then(|v| v.as_str())
            .unwrap_or("unpaired");
        let ddi_services_available = device
            .pointer("/deviceProperties/ddiServicesAvailable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let os_version = device
            .pointer("/deviceProperties/osVersionNumber")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let boot_state = device
            .pointer("/deviceProperties/bootState")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        if udid.is_empty() {
            continue;
        }

        devices.push(IosDevice {
            udid,
            name,
            // Use the same "Booted"/"Shutdown" capitalization as simulators
            // so `is_booted()` works uniformly.
            state: if boot_state == "booted" {
                "Booted".to_string()
            } else {
                "Shutdown".to_string()
            },
            is_simulator: false,
            is_paired: pairing_state == "paired",
            ddi_services_available,
            os_version,
        });
    }
    Ok(devices)
}

/// List all iOS devices (simulators + physical).
/// Physical device listing failures are non-fatal (devicectl may not be available).
pub async fn list_all_devices() -> Result<Vec<IosDevice>> {
    let (sims, physical) = tokio::join!(list_simulators(), list_physical_devices());
    let mut all = sims?;
    // Physical device listing is best-effort — devicectl may fail
    if let Ok(phys) = physical {
        all.extend(phys);
    }
    Ok(all)
}

/// Install an app bundle on a simulator.
#[allow(dead_code)]
#[instrument(skip(app_path))]
pub async fn install_app(udid: &str, app_path: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "install", udid, app_path])
        .output()
        .await
        .context("Failed to run xcrun simctl install")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to install app on simulator {udid}: {stderr}");
    }

    info!(udid, app_path, "App installed on simulator");
    Ok(())
}

/// Install an app bundle on a physical iOS device via `xcrun devicectl`.
///
/// The `.app` path may point at an unsigned simulator build or a signed
/// device build — devicectl will accept the latter and reject the former
/// with a signing error. Callers are responsible for passing the correct
/// bundle for the target device.
#[instrument(skip(app_path))]
pub async fn install_app_on_device(udid: &str, app_path: &str) -> Result<()> {
    let json_path = scratch_json_path("install-app");
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "install",
            "app",
            "--device",
            udid,
            "--json-output",
            &json_path.to_string_lossy(),
            app_path,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device install app")?;

    // Best-effort cleanup — we only read JSON if we want to surface details.
    let json_body = tokio::fs::read_to_string(&json_path).await.ok();
    let _ = tokio::fs::remove_file(&json_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = extract_devicectl_error_hint(json_body.as_deref());
        bail!(
            "Failed to install app on physical device {udid}: {stderr}{}",
            hint.map(|h| format!("\n  hint: {h}")).unwrap_or_default()
        );
    }

    info!(udid, app_path, "App installed on physical device");
    Ok(())
}

/// Launch an app on a physical iOS device via devicectl and return the PID.
///
/// devicectl's launch is asynchronous-ish — it returns once the remote
/// process has spawned, but the returned PID can be used to later terminate
/// the app via `terminate_process_on_device`.
#[allow(dead_code)]
#[instrument]
pub async fn launch_app_on_device(udid: &str, bundle_id: &str) -> Result<u32> {
    let json_path = scratch_json_path("launch-app");
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            udid,
            "--json-output",
            &json_path.to_string_lossy(),
            bundle_id,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device process launch")?;

    let json_body = tokio::fs::read_to_string(&json_path).await.ok();
    let _ = tokio::fs::remove_file(&json_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = extract_devicectl_error_hint(json_body.as_deref());
        bail!(
            "Failed to launch {bundle_id} on physical device {udid}: {stderr}{}",
            hint.map(|h| format!("\n  hint: {h}")).unwrap_or_default()
        );
    }

    let pid = json_body
        .as_deref()
        .and_then(|body| {
            serde_json::from_str::<serde_json::Value>(body)
                .ok()?
                .pointer("/result/process/processIdentifier")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "devicectl launch succeeded but no PID returned for {bundle_id} on {udid}"
            )
        })?;

    info!(udid, bundle_id, pid, "App launched on physical device");
    Ok(pid)
}

/// Launch a URL on a physical device by delivering it to the target bundle.
///
/// Uses `xcrun devicectl device process launch --payload-url <url> <bundle>`.
/// In practice this launches the target bundle but does NOT actually
/// deliver the URL to the app's UIApplicationDelegate — the payload is
/// attached to the launch record but RN/expo-router's deep-link handling
/// never sees it. Pilot routes openDeepLink through the agent's
/// `XCUIApplication.open(url:)` path instead, so this helper is kept only
/// for diagnostics and is currently unused.
#[allow(dead_code)]
#[instrument]
pub async fn launch_url_on_device(udid: &str, bundle_id: &str, url: &str) -> Result<()> {
    let json_path = scratch_json_path("launch-url");
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            udid,
            "--json-output",
            &json_path.to_string_lossy(),
            "--terminate-existing",
            "--payload-url",
            url,
            bundle_id,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device process launch --payload-url")?;

    let json_body = tokio::fs::read_to_string(&json_path).await.ok();
    let _ = tokio::fs::remove_file(&json_path).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = extract_devicectl_error_hint(json_body.as_deref());
        bail!(
            "Failed to open URL on physical device {udid}: {stderr}{}",
            hint.map(|h| format!("\n  hint: {h}")).unwrap_or_default()
        );
    }

    info!(
        udid,
        bundle_id, url, "URL delivered to app on physical device"
    );
    Ok(())
}

/// Uninstall an app from a physical iOS device by bundle ID.
#[instrument]
pub async fn uninstall_app_on_device(udid: &str, bundle_id: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "uninstall",
            "app",
            "--device",
            udid,
            bundle_id,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device uninstall app")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Uninstalling a not-installed app is fine — target state is reached.
        if stderr.contains("not installed") || stderr.contains("could not be found") {
            debug!(udid, bundle_id, "App already not installed");
            return Ok(());
        }
        bail!("Failed to uninstall {bundle_id} from {udid}: {stderr}");
    }
    info!(udid, bundle_id, "App uninstalled from physical device");
    Ok(())
}

/// Pull an app's data container from a physical device to a local directory.
///
/// Uses `xcrun devicectl device copy from --domain-type appDataContainer`.
/// The destination directory will contain the container's children
/// (typically `Documents/`, `Library/`, `tmp/`).
#[instrument(skip(local_dest))]
pub async fn copy_app_container_from_device(
    udid: &str,
    bundle_id: &str,
    local_dest: &str,
) -> Result<()> {
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "copy",
            "from",
            "--device",
            udid,
            "--domain-type",
            "appDataContainer",
            "--domain-identifier",
            bundle_id,
            "--source",
            "/",
            "--destination",
            local_dest,
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device copy from")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to copy app container from {udid}: {stderr}");
    }
    Ok(())
}

/// Push local files back into an app's data container on a physical device.
///
/// Uses `xcrun devicectl device copy to --domain-type appDataContainer` with
/// one source entry per top-level child (`Documents/`, `Library/`, `tmp/`).
/// Passing `--remove-existing-content true` replaces the destination, so
/// stale files left by the previous state are cleared.
#[instrument(skip(local_sources))]
pub async fn copy_app_container_to_device(
    udid: &str,
    bundle_id: &str,
    local_sources: &[String],
) -> Result<()> {
    if local_sources.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec![
        "devicectl",
        "device",
        "copy",
        "to",
        "--device",
        udid,
        "--domain-type",
        "appDataContainer",
        "--domain-identifier",
        bundle_id,
        "--destination",
        "/",
        "--remove-existing-content",
        "true",
    ];
    for source in local_sources {
        args.push("--source");
        args.push(source.as_str());
    }
    let output = Command::new("xcrun")
        .args(&args)
        .output()
        .await
        .context("Failed to run xcrun devicectl device copy to")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to copy app container to {udid}: {stderr}");
    }
    Ok(())
}

/// Terminate a running process on a physical iOS device by PID.
#[allow(dead_code)]
#[instrument]
pub async fn terminate_process_on_device(udid: &str, pid: u32) -> Result<()> {
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "device",
            "process",
            "terminate",
            "--device",
            udid,
            "--pid",
            &pid.to_string(),
        ])
        .output()
        .await
        .context("Failed to run xcrun devicectl device process terminate")?;

    if !output.status.success() {
        // Terminating an already-gone process is not an error for Pilot's
        // purposes — it means the target state is already achieved.
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(udid, pid, stderr = %stderr, "devicectl terminate returned non-zero (process may already be gone)");
    }
    Ok(())
}

/// Scratch JSON output path for devicectl commands — per-invocation with the
/// caller's purpose in the filename so multiple concurrent calls don't collide.
#[allow(dead_code)]
fn scratch_json_path(purpose: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "pilot-devicectl-{}-{}-{}.json",
        purpose,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

/// Extract a human-readable hint from devicectl's JSON error output.
///
/// devicectl errors include nested `error.userInfo.NSLocalizedDescription`
/// fields that are almost always more useful than the bare stderr line.
#[allow(dead_code)]
fn extract_devicectl_error_hint(json_body: Option<&str>) -> Option<String> {
    let body = json_body?;
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .pointer("/error/userInfo/NSLocalizedDescription/string")
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .pointer("/error/userInfo/NSLocalizedDescription")
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .pointer("/error/userInfo/NSLocalizedRecoverySuggestion/string")
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
}

/// Launch an app on a simulator by bundle ID.
#[instrument]
pub async fn launch_app(udid: &str, bundle_id: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "launch", udid, bundle_id])
        .output()
        .await
        .context("Failed to run xcrun simctl launch")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to launch {bundle_id} on {udid}: {stderr}");
    }

    info!(udid, bundle_id, "App launched on simulator");
    Ok(())
}

/// Terminate an app on a simulator.
#[instrument]
pub async fn terminate_app(udid: &str, bundle_id: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "terminate", udid, bundle_id])
        .output()
        .await
        .context("Failed to run xcrun simctl terminate")?;

    if !output.status.success() {
        // Terminating an already-stopped app is not an error
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(udid, bundle_id, stderr = %stderr, "simctl terminate returned non-zero (app may not be running)");
    }

    Ok(())
}

/// Open a URL on a simulator (deep link).
#[instrument]
pub async fn open_url(udid: &str, url: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "openurl", udid, url])
        .output()
        .await
        .context("Failed to run xcrun simctl openurl")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to open URL on {udid}: {stderr}");
    }

    Ok(())
}

/// Grant a privacy permission on a simulator.
/// Service names: camera, photos, location, microphone, contacts, calendar, etc.
#[instrument]
pub async fn grant_permission(udid: &str, bundle_id: &str, service: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "privacy", udid, "grant", service, bundle_id])
        .output()
        .await
        .context("Failed to run xcrun simctl privacy grant")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to grant {service} permission for {bundle_id} on {udid}: {stderr}");
    }

    Ok(())
}

/// Revoke a privacy permission on a simulator.
#[instrument]
pub async fn revoke_permission(udid: &str, bundle_id: &str, service: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "privacy", udid, "revoke", service, bundle_id])
        .output()
        .await
        .context("Failed to run xcrun simctl privacy revoke")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to revoke {service} permission for {bundle_id} on {udid}: {stderr}");
    }

    Ok(())
}

/// Set the simulator appearance (light/dark mode).
#[instrument]
pub async fn set_appearance(udid: &str, mode: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "ui", udid, "appearance", mode])
        .output()
        .await
        .context("Failed to run xcrun simctl ui appearance")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to set appearance to {mode} on {udid}: {stderr}");
    }

    Ok(())
}

/// Get the simulator clipboard text via `simctl pbpaste`.
/// This avoids the iOS 16+ paste permission dialog that would be triggered
/// by reading UIPasteboard on-device.
#[instrument]
pub async fn get_clipboard(udid: &str) -> Result<String> {
    let output = Command::new("xcrun")
        .args(["simctl", "pbpaste", udid])
        .output()
        .await
        .context("Failed to run xcrun simctl pbpaste")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to get clipboard on {udid}: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Set the simulator clipboard text via `simctl pbcopy`.
/// This avoids the iOS 16+ paste permission dialog that would be triggered
/// by writing to UIPasteboard on-device.
#[instrument]
pub async fn set_clipboard(udid: &str, text: &str) -> Result<()> {
    let mut child = Command::new("xcrun")
        .args(["simctl", "pbcopy", udid])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .context("Failed to run xcrun simctl pbcopy")?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(text.as_bytes()).await?;
    }

    let status = child.wait().await?;
    if !status.success() {
        bail!("Failed to set clipboard on {udid}");
    }

    Ok(())
}

/// Get device logs from a simulator (equivalent to Android logcat).
#[allow(dead_code)]
#[instrument]
pub async fn get_logs(udid: &str, bundle_id: Option<&str>, since: Option<&str>) -> Result<String> {
    let mut args = vec!["simctl", "spawn", udid, "log", "show", "--style", "compact"];

    let predicate;
    if let Some(bid) = bundle_id {
        predicate = format!("subsystem == \"{}\"", bid);
        args.push("--predicate");
        args.push(&predicate);
    }

    if let Some(since_time) = since {
        args.push("--start");
        args.push(since_time);
    }

    let output = Command::new("xcrun")
        .args(&args)
        .output()
        .await
        .context("Failed to get simulator logs")?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Boot a simulator.
#[allow(dead_code)]
#[instrument]
pub async fn boot_simulator(udid: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "boot", udid])
        .output()
        .await
        .context("Failed to boot simulator")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "Unable to boot device in current state: Booted" is not a real error
        if stderr.contains("Booted") {
            debug!(udid, "Simulator already booted");
            return Ok(());
        }
        bail!("Failed to boot simulator {udid}: {stderr}");
    }

    info!(udid, "Simulator booted");
    configure_simulator(udid).await;
    Ok(())
}

/// Apply test-friendly defaults to the simulator (disable password autofill,
/// keyboard autocorrect, etc.) so system dialogs don't interfere with tests.
///
/// **Caller's responsibility** to skip this for physical devices — invoking
/// it against a real device's UDID is wasted work (the simctl spawns will
/// fail) but won't cause data loss. The `grpc_server::start_agent` handler
/// already branches on `is_active_ios_physical()` and skips this call on
/// physical-device runs to keep the simulator hot path free of any extra
/// devicectl latency.
pub async fn configure_simulator(udid: &str) {
    // Disable "Save Password?" dialog which blocks the UI during login tests.
    // The setting must be written to multiple domains because Apple has moved
    // the password autofill control across iOS versions and frameworks.
    for domain in [
        "-g",                 // Global (pre-iOS 26)
        "com.apple.WebUI",    // WebKit credential UI (iOS 26+)
        "com.apple.Safari",   // Safari password autofill
        "com.apple.Password", // Passwords framework (iOS 26+)
    ] {
        let _ = Command::new("xcrun")
            .args([
                "simctl",
                "spawn",
                udid,
                "defaults",
                "write",
                domain,
                "AutoFillPasswords",
                "-bool",
                "NO",
            ])
            .output()
            .await;
    }
    debug!(udid, "Configured simulator defaults for testing");
}

/// Shutdown a simulator.
#[allow(dead_code)]
#[instrument]
pub async fn shutdown_simulator(udid: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "shutdown", udid])
        .output()
        .await
        .context("Failed to shutdown simulator")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(udid, stderr = %stderr, "simctl shutdown returned non-zero");
    }

    Ok(())
}

/// Get the app container path on a simulator.
#[instrument]
pub async fn get_app_container(udid: &str, bundle_id: &str) -> Result<String> {
    let output = Command::new("xcrun")
        .args(["simctl", "get_app_container", udid, bundle_id, "data"])
        .output()
        .await
        .context("Failed to get app container")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to get app container for {bundle_id} on {udid}: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Clear an app's data container by removing user data.
/// Clears Documents, tmp, and all of Library so that app-managed
/// persisted state is recreated fresh on next use.
/// Preserves the container structure itself.
#[instrument]
pub async fn clear_container(container_path: &str) -> Result<()> {
    use std::path::Path;
    let container = Path::new(container_path);
    if !container.exists() {
        debug!("Container path does not exist: {container_path}");
        return Ok(());
    }

    // Clear all contents outside Library first, then clear all of Library.
    // This includes Documents, tmp, Library/Caches, Library/Application Support,
    // Library/Saved Application State, Library/WebKit, and Library/Preferences.
    let mut entries = tokio::fs::read_dir(container).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip Library — we handle it separately below.
        if name_str == "Library" {
            continue;
        }
        if path.is_dir() {
            let _ = tokio::fs::remove_dir_all(&path).await;
            let _ = tokio::fs::create_dir_all(&path).await;
        } else {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
    // Clear all Library contents, including Preferences.
    let library = container.join("Library");
    if library.exists() {
        let mut lib_entries = tokio::fs::read_dir(&library).await?;
        while let Some(entry) = lib_entries.next_entry().await? {
            let path = entry.path();
            if path.is_dir() {
                let _ = tokio::fs::remove_dir_all(&path).await;
            } else {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
    info!(container_path, "Cleared app data container");
    Ok(())
}

// ─── Network Proxy Helpers ───

/// Install a CA certificate on the iOS simulator for MITM HTTPS interception.
///
/// Uses `xcrun simctl keychain` (Xcode 15+) to add a root certificate to the
/// simulator's trust store. This allows the MITM proxy to intercept HTTPS traffic.
#[instrument]
pub async fn install_ca_cert(udid: &str, ca_pem_path: &str) -> Result<()> {
    let output = Command::new("xcrun")
        .args(["simctl", "keychain", udid, "add-root-cert", ca_pem_path])
        .output()
        .await
        .context("Failed to run xcrun simctl keychain add-root-cert")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to install CA cert on simulator {udid}: {stderr}");
    }

    info!(udid, "CA certificate installed on simulator");
    Ok(())
}

/// Clear app data by uninstalling and reinstalling.
#[allow(dead_code)]
#[instrument(skip(app_path))]
pub async fn clear_app_data(udid: &str, bundle_id: &str, app_path: Option<&str>) -> Result<()> {
    // Uninstall the app
    let output = Command::new("xcrun")
        .args(["simctl", "uninstall", udid, bundle_id])
        .output()
        .await
        .context("Failed to uninstall app")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        debug!(stderr = %stderr, "Uninstall may have failed (app might not be installed)");
    }

    // Reinstall if app path is provided
    if let Some(path) = app_path {
        install_app(udid, path).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real devicectl JSON captured from `xcrun devicectl list devices` with
    /// one unpaired iPhone connected. Used to verify that parsing is robust to
    /// unpaired devices (`ddiServicesAvailable: false`, `pairingState: "unpaired"`).
    const DEVICECTL_UNPAIRED_IPHONE: &str = r#"{
      "info": {
        "arguments": ["devicectl","list","devices","--json-output","/tmp/x"],
        "commandType": "devicectl.list.devices",
        "environment": {},
        "jsonVersion": 3,
        "outcome": "success",
        "version": "518.27"
      },
      "result": {
        "devices": [
          {
            "connectionProperties": {
              "isMobileDeviceOnly": false,
              "pairingState": "unpaired",
              "transportType": "wired",
              "tunnelState": "disconnected"
            },
            "deviceProperties": {
              "bootState": "booted",
              "ddiServicesAvailable": false,
              "name": "Sam\u2019s iPhone",
              "osBuildUpdate": "23C71",
              "osVersionNumber": "26.2.1"
            },
            "hardwareProperties": {
              "deviceType": "iPhone",
              "platform": "iOS",
              "productType": "iPhone17,1",
              "udid": "00008140-00096C9014F3001C"
            },
            "identifier": "EBAACA98-F83F-5F5A-85A7-23F989DD5585"
          }
        ]
      }
    }"#;

    #[test]
    fn parse_devicectl_devices_extracts_unpaired_iphone() {
        let devices = parse_devicectl_devices(DEVICECTL_UNPAIRED_IPHONE).unwrap();
        assert_eq!(devices.len(), 1);
        let d = &devices[0];
        assert_eq!(d.udid, "00008140-00096C9014F3001C");
        // The unicode curly apostrophe must survive round-tripping so the
        // name displayed to the user matches what they see in Xcode / Settings.
        assert_eq!(d.name, "Sam\u{2019}s iPhone");
        assert!(!d.is_simulator);
        assert!(
            !d.is_paired,
            "unpaired device should surface is_paired=false"
        );
        assert!(!d.ddi_services_available);
        assert_eq!(d.os_version, "26.2.1");
        assert_eq!(d.state, "Booted");
    }

    #[test]
    fn parse_devicectl_devices_filters_non_ios_entries() {
        // devicectl also lists paired Apple Watches, Apple TVs, and Macs
        // under certain Xcode configurations. Pilot only drives iOS, so
        // those must be filtered out at parse time.
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS", "udid": "IPHONE-UDID" },
                "deviceProperties": { "name": "iPhone", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              },
              {
                "hardwareProperties": { "platform": "watchOS", "udid": "WATCH-UDID" },
                "deviceProperties": { "name": "Apple Watch", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              },
              {
                "hardwareProperties": { "platform": "macOS", "udid": "MAC-UDID" },
                "deviceProperties": { "name": "Mac mini", "bootState": "booted" },
                "connectionProperties": { "pairingState": "paired" }
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].udid, "IPHONE-UDID");
    }

    #[test]
    fn parse_devicectl_devices_accepts_empty_result() {
        let json = r#"{ "result": { "devices": [] } }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn parse_devicectl_devices_skips_entries_missing_udid() {
        // Defensive against devicectl versions that might emit partial entries.
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS" },
                "deviceProperties": { "name": "weird" }
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert!(devices.is_empty());
    }

    #[test]
    fn parse_devicectl_devices_reports_shutdown_when_not_booted() {
        let json = r#"{
          "result": {
            "devices": [
              {
                "hardwareProperties": { "platform": "iOS", "udid": "U" },
                "deviceProperties": { "name": "N", "bootState": "unknown" },
                "connectionProperties": { "pairingState": "paired" }
              }
            ]
          }
        }"#;
        let devices = parse_devicectl_devices(json).unwrap();
        assert_eq!(devices[0].state, "Shutdown");
    }

    #[test]
    fn extract_devicectl_error_hint_returns_none_for_empty_input() {
        assert!(extract_devicectl_error_hint(None).is_none());
        assert!(extract_devicectl_error_hint(Some("not json")).is_none());
        assert!(extract_devicectl_error_hint(Some("{}")).is_none());
    }

    #[test]
    fn extract_devicectl_error_hint_parses_localized_description() {
        // devicectl wraps localized strings in { "string": "..." } objects
        // when the underlying NSError is serialized. Verify we reach through.
        let json = r#"{
          "error": {
            "userInfo": {
              "NSLocalizedDescription": {
                "string": "The operation couldn't be completed. (CoreDeviceError error 6.)"
              }
            }
          }
        }"#;
        let hint = extract_devicectl_error_hint(Some(json)).unwrap();
        assert!(hint.contains("CoreDeviceError error 6"));
    }

    #[test]
    fn scratch_json_paths_do_not_collide() {
        let a = scratch_json_path("foo");
        let b = scratch_json_path("foo");
        assert_ne!(a, b);
        // Both live under the OS temp dir so they get auto-cleaned.
        assert!(a.starts_with(std::env::temp_dir()));
    }
}
