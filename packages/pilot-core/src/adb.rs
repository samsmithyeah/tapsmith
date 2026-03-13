use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, instrument};

/// Locate the `adb` binary on PATH.
pub async fn find_adb() -> Result<PathBuf> {
    let output = Command::new("which")
        .arg("adb")
        .output()
        .await
        .context("Failed to execute `which adb`")?;

    if !output.status.success() {
        bail!("adb not found on PATH");
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(PathBuf::from(path))
}

/// Parsed device entry from `adb devices`.
#[derive(Debug, Clone)]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
}

impl AdbDevice {
    pub fn is_online(&self) -> bool {
        self.state == "device"
    }

    pub fn is_emulator(&self) -> bool {
        self.serial.starts_with("emulator-") || self.serial.starts_with("localhost:")
    }
}

/// Run an adb command targeting a specific device, returning stdout bytes.
async fn run_adb(serial: Option<&str>, args: &[&str], timeout: Duration) -> Result<Vec<u8>> {
    let mut cmd = Command::new("adb");

    if let Some(s) = serial {
        cmd.arg("-s").arg(s);
    }

    cmd.args(args);

    debug!(serial = serial, args = ?args, "Running adb command");

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| anyhow!("adb command timed out after {timeout:?}"))?
        .context("Failed to execute adb")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("adb command failed (exit {}): {stderr}", output.status);
    }

    Ok(output.stdout)
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// List connected ADB devices.
#[instrument]
pub async fn list_devices() -> Result<Vec<AdbDevice>> {
    let stdout = run_adb(None, &["devices", "-l"], DEFAULT_TIMEOUT).await?;
    let output = String::from_utf8_lossy(&stdout);

    let mut devices = Vec::new();

    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let mut parts = line.split_whitespace();
        let serial = match parts.next() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let state = parts.next().unwrap_or("unknown").to_string();

        devices.push(AdbDevice { serial, state });
    }

    debug!(count = devices.len(), "Found ADB devices");
    Ok(devices)
}

/// Get the model name for a device.
#[instrument]
pub async fn get_device_model(serial: &str) -> Result<String> {
    let stdout = run_adb(
        Some(serial),
        &["shell", "getprop", "ro.product.model"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

/// Install an APK on the device. Uses `-r` to allow reinstall.
#[instrument(skip(apk_path))]
pub async fn install_apk(serial: &str, apk_path: &str) -> Result<()> {
    let timeout = Duration::from_secs(120);
    run_adb(Some(serial), &["install", "-r", apk_path], timeout).await?;
    Ok(())
}

/// Set up TCP port forwarding: `adb forward tcp:<host_port> tcp:<device_port>`.
#[instrument]
pub async fn forward_port(serial: &str, host_port: u16, device_port: u16) -> Result<()> {
    let host_arg = format!("tcp:{host_port}");
    let device_arg = format!("tcp:{device_port}");
    run_adb(
        Some(serial),
        &["forward", &host_arg, &device_arg],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(host_port, device_port, "Port forwarding established");
    Ok(())
}

/// Remove a specific port forward.
#[instrument]
pub async fn remove_forward(serial: &str, host_port: u16) -> Result<()> {
    let host_arg = format!("tcp:{host_port}");
    run_adb(
        Some(serial),
        &["forward", "--remove", &host_arg],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Execute a shell command on the device, returning stdout as a String.
#[instrument]
pub async fn shell(serial: &str, command: &str) -> Result<String> {
    let stdout = run_adb(Some(serial), &["shell", command], DEFAULT_TIMEOUT).await?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// Capture a screenshot from the device, returning raw PNG bytes.
#[instrument]
pub async fn screencap(serial: &str) -> Result<Vec<u8>> {
    let timeout = Duration::from_secs(15);
    let png = run_adb(Some(serial), &["exec-out", "screencap", "-p"], timeout).await?;

    if png.len() < 8 {
        bail!(
            "screencap returned too few bytes ({}), device may be locked",
            png.len()
        );
    }

    // Validate PNG magic bytes
    if &png[..4] != b"\x89PNG" {
        bail!("screencap output does not appear to be valid PNG data");
    }

    debug!(bytes = png.len(), "Screenshot captured");
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── AdbDevice::is_online ───

    #[test]
    fn is_online_device_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "device".into(),
        };
        assert!(dev.is_online());
    }

    #[test]
    fn is_online_offline_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "offline".into(),
        };
        assert!(!dev.is_online());
    }

    #[test]
    fn is_online_unauthorized_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "unauthorized".into(),
        };
        assert!(!dev.is_online());
    }

    #[test]
    fn is_online_unknown_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "unknown".into(),
        };
        assert!(!dev.is_online());
    }

    #[test]
    fn is_online_empty_state() {
        let dev = AdbDevice {
            serial: "ABC123".into(),
            state: "".into(),
        };
        assert!(!dev.is_online());
    }

    // ─── AdbDevice::is_emulator ───

    #[test]
    fn is_emulator_emulator_serial() {
        let dev = AdbDevice {
            serial: "emulator-5554".into(),
            state: "device".into(),
        };
        assert!(dev.is_emulator());
    }

    #[test]
    fn is_emulator_emulator_other_port() {
        let dev = AdbDevice {
            serial: "emulator-5556".into(),
            state: "device".into(),
        };
        assert!(dev.is_emulator());
    }

    #[test]
    fn is_emulator_localhost() {
        let dev = AdbDevice {
            serial: "localhost:5555".into(),
            state: "device".into(),
        };
        assert!(dev.is_emulator());
    }

    #[test]
    fn is_emulator_ip_address_is_not_emulator() {
        let dev = AdbDevice {
            serial: "192.168.1.1:5555".into(),
            state: "device".into(),
        };
        assert!(!dev.is_emulator());
    }

    #[test]
    fn is_emulator_physical_device() {
        let dev = AdbDevice {
            serial: "HVA123456".into(),
            state: "device".into(),
        };
        assert!(!dev.is_emulator());
    }

    #[test]
    fn is_emulator_another_physical_serial() {
        let dev = AdbDevice {
            serial: "R5CR1234XYZ".into(),
            state: "device".into(),
        };
        assert!(!dev.is_emulator());
    }
}
