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
    Ok(())
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
/// Clears Documents, tmp, and Library (except Preferences) so that
/// databases like AsyncStorage are recreated fresh on next use.
/// Preserves the container structure itself.
#[instrument]
pub async fn clear_container(container_path: &str) -> Result<()> {
    use std::path::Path;
    let container = Path::new(container_path);
    if !container.exists() {
        debug!("Container path does not exist: {container_path}");
        return Ok(());
    }

    // Clear all contents except Library/Preferences (system config like i18n).
    // This clears: Documents, tmp, Library/Caches, Library/Application Support,
    // Library/Saved Application State (iOS state restoration), Library/WebKit, etc.
    let mut entries = tokio::fs::read_dir(container).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip Library — we handle it separately to preserve Preferences
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
    // Clear Library subdirectories except Preferences
    let library = container.join("Library");
    if library.exists() {
        let mut lib_entries = tokio::fs::read_dir(&library).await?;
        while let Some(entry) = lib_entries.next_entry().await? {
            let name = entry.file_name();
            if name.to_string_lossy() == "Preferences" {
                continue; // Keep system preferences
            }
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
