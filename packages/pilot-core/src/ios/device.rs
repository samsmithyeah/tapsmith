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
        for (_runtime, device_list) in device_map {
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
                        });
                    }
                }
            }
        }
    }

    debug!(count = devices.len(), "Listed iOS simulators");
    Ok(devices)
}

/// List connected physical iOS devices via devicectl.
pub async fn list_physical_devices() -> Result<Vec<IosDevice>> {
    // Check if devicectl is available (Xcode 15+)
    let output = Command::new("xcrun")
        .args([
            "devicectl",
            "list",
            "devices",
            "--json-output",
            "/dev/stdout",
        ])
        .output()
        .await;

    match output {
        Ok(output) if output.status.success() => {
            let json_str = String::from_utf8_lossy(&output.stdout);
            let value: serde_json::Value =
                serde_json::from_str(&json_str).context("Failed to parse devicectl JSON output")?;

            let mut devices = Vec::new();
            if let Some(device_list) = value
                .get("result")
                .and_then(|r| r.get("devices"))
                .and_then(|d| d.as_array())
            {
                for device in device_list {
                    let udid = device
                        .pointer("/hardwareProperties/udid")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = device
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _transport = device
                        .pointer("/connectionProperties/transportType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("connected");

                    if !udid.is_empty() {
                        devices.push(IosDevice {
                            udid,
                            name,
                            state: "Connected".to_string(),
                            is_simulator: false,
                        });
                    }
                }
            }
            Ok(devices)
        }
        _ => {
            // devicectl not available — no physical device listing
            debug!("devicectl not available, skipping physical device listing");
            Ok(Vec::new())
        }
    }
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

// ─── Proxy Interpose (DYLD) ───

#[allow(dead_code)]
/// Detect the primary active macOS network service (e.g. "Wi-Fi", "Ethernet").
///
/// Uses `networksetup -listnetworkserviceorder` and cross-references with active
/// interfaces from `ifconfig` to find the service that is currently connected.
#[instrument]
pub async fn active_network_service() -> Result<String> {
    let output = Command::new("networksetup")
        .args(["-listnetworkserviceorder"])
        .output()
        .await
        .context("Failed to run networksetup")?;

    let text = String::from_utf8_lossy(&output.stdout);

    // Parse lines like:
    // (1) Wi-Fi
    // (Hardware Port: Wi-Fi, Device: en0)
    // Find the first service whose device interface is up.
    let mut current_service: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        // Service name line: "(N) ServiceName"
        if trimmed.starts_with('(') && !trimmed.contains("Hardware Port") {
            if let Some((_, name)) = trimmed.split_once(") ") {
                current_service = Some(name.to_string());
            }
        }
        // Hardware line: "(Hardware Port: ..., Device: en0)"
        if let Some(ref service) = current_service {
            if trimmed.contains("Hardware Port") {
                if let Some(dev_part) = trimmed.split("Device: ").nth(1) {
                    let device = dev_part.trim_end_matches(')').trim();
                    if !device.is_empty() && !device.contains('*') {
                        // Check if this interface has an active IP
                        let ifconfig = Command::new("ifconfig").arg(device).output().await;
                        if let Ok(ifout) = ifconfig {
                            let iftext = String::from_utf8_lossy(&ifout.stdout);
                            if iftext.contains("inet ") && iftext.contains("status: active") {
                                debug!(service = %service, device = device, "Found active network service");
                                return Ok(service.clone());
                            }
                        }
                    }
                }
                current_service = None;
            }
        }
    }

    // Fallback: try "Wi-Fi" (most common)
    debug!("No active service detected, falling back to Wi-Fi");
    Ok("Wi-Fi".to_string())
}

#[allow(dead_code)]
/// Run a `networksetup` command, escalating to admin privileges if needed.
///
/// Tries in order:
/// 1. Direct execution (works if user has admin privileges without password)
/// 2. `sudo -n` (works in CI with NOPASSWD configured)
/// 3. `osascript` with administrator privileges (shows macOS auth dialog)
async fn run_networksetup(args: &[&str]) -> Result<()> {
    // 1. Try direct execution
    let output = Command::new("networksetup")
        .args(args)
        .output()
        .await
        .context("Failed to run networksetup")?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.contains("requires admin") && !stderr.contains("Error") {
        // Non-permission error
        bail!("networksetup failed: {stderr}");
    }

    // 2. Try sudo -n (non-interactive, works with NOPASSWD)
    let output = Command::new("sudo")
        .arg("-n")
        .arg("networksetup")
        .args(args)
        .output()
        .await
        .context("Failed to run sudo networksetup")?;
    if output.status.success() {
        return Ok(());
    }

    // 3. Fall back to osascript with administrator privileges (shows auth dialog)
    let args_escaped: Vec<String> = args
        .iter()
        .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
        .collect();
    let shell_cmd = format!("networksetup {}", args_escaped.join(" "));
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        shell_cmd.replace('"', "\\\"")
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .context("Failed to run osascript for networksetup")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Failed to run networksetup with admin privileges: {stderr}");
    }
    Ok(())
}

#[allow(dead_code)]
/// Set the macOS HTTP and HTTPS proxy via `networksetup`.
///
/// iOS simulators share the host network stack, so setting the macOS system proxy
/// routes simulator traffic through our MITM proxy. Requires admin privileges —
/// escalates via `sudo` or macOS authorization dialog.
#[instrument]
pub async fn set_http_proxy(service: &str, host: &str, port: u16) -> Result<()> {
    let port_str = port.to_string();

    run_networksetup(&["-setwebproxy", service, host, &port_str])
        .await
        .context("Failed to set HTTP proxy")?;
    run_networksetup(&["-setsecurewebproxy", service, host, &port_str])
        .await
        .context("Failed to set HTTPS proxy")?;

    info!(service, host, port, "macOS HTTP/HTTPS proxy configured");
    Ok(())
}

#[allow(dead_code)]
/// Clear the macOS HTTP and HTTPS proxy settings.
#[instrument]
pub async fn clear_http_proxy(service: &str) -> Result<()> {
    if let Err(e) = run_networksetup(&["-setwebproxystate", service, "off"]).await {
        debug!(service, "Failed to disable HTTP proxy: {e}");
    }
    if let Err(e) = run_networksetup(&["-setsecurewebproxystate", service, "off"]).await {
        debug!(service, "Failed to disable HTTPS proxy: {e}");
    }

    info!(service, "macOS HTTP/HTTPS proxy cleared");
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
