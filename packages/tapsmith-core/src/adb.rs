use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

/// Locate the `adb` binary on PATH.
pub async fn find_adb() -> Result<PathBuf> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(cmd)
        .arg("adb")
        .output()
        .await
        .context(format!("Failed to execute `{cmd} adb`"))?;

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

/// Base directory for user-installed CA certificates on Android.
const DEVICE_CA_CERT_DIR: &str = "/data/misc/user/0/cacerts-added";

/// Build the full on-device path for a CA cert given its filename (e.g. `a1b2c3d4.0`).
pub fn device_ca_cert_path(filename: &str) -> String {
    format!("{DEVICE_CA_CERT_DIR}/{filename}")
}

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

/// Get the human-friendly Android OS version (e.g. "14") for a device.
#[instrument]
pub async fn get_device_os_version(serial: &str) -> Result<String> {
    let stdout = run_adb(
        Some(serial),
        &["shell", "getprop", "ro.build.version.release"],
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

/// Set up reverse port forwarding: `adb reverse tcp:<device_port> tcp:<host_port>`.
///
/// Makes `127.0.0.1:<device_port>` on the device forward to `127.0.0.1:<host_port>`
/// on the host. More reliable than `settings put global http_proxy` with `10.0.2.2`
/// because it works at the ADB transport level.
#[instrument]
pub async fn reverse_port(serial: &str, device_port: u16, host_port: u16) -> Result<()> {
    let device_arg = format!("tcp:{device_port}");
    let host_arg = format!("tcp:{host_port}");
    run_adb(
        Some(serial),
        &["reverse", &device_arg, &host_arg],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(
        device_port,
        host_port, "Reverse port forwarding established"
    );
    Ok(())
}

/// Remove a specific reverse port forward.
#[instrument]
pub async fn remove_reverse(serial: &str, device_port: u16) -> Result<()> {
    let device_arg = format!("tcp:{device_port}");
    run_adb(
        Some(serial),
        &["reverse", "--remove", &device_arg],
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

/// Check if a package is installed on the device.
#[instrument]
pub async fn is_package_installed(serial: &str, package: &str) -> Result<bool> {
    let stdout = shell_lenient(serial, &format!("pm list packages {package}")).await?;
    Ok(stdout.contains(&format!("package:{package}")))
}

/// Push a local file to the device via `adb push`.
#[instrument(skip(local_path, remote_path))]
pub async fn push_file(serial: &str, local_path: &str, remote_path: &str) -> Result<()> {
    run_adb(
        Some(serial),
        &["push", local_path, remote_path],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(local_path, remote_path, "File pushed to device");
    Ok(())
}

/// Pull a file from the device to a local path via `adb pull`.
#[instrument(skip(local_path, remote_path))]
pub async fn pull_file(serial: &str, remote_path: &str, local_path: &str) -> Result<()> {
    let timeout = Duration::from_secs(300); // large app data can take a while
    run_adb(Some(serial), &["pull", remote_path, local_path], timeout).await?;
    debug!(remote_path, local_path, "File pulled from device");
    Ok(())
}

/// Execute a shell command on the device with a custom timeout, returning stdout as a String.
#[instrument]
pub async fn shell_with_timeout(serial: &str, command: &str, timeout: Duration) -> Result<String> {
    let stdout = run_adb(Some(serial), &["shell", command], timeout).await?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// Install a CA certificate on the device for MITM HTTPS interception.
///
/// `cert_filename` is the hash-based filename (e.g. `a1b2c3d4.0`) required by
/// Android's certificate store. See [`crate::mitm_ca::MitmAuthority::device_cert_filename`].
///
/// Attempts `adb root` to gain root access (works on emulator userdebug
/// images), then copies the PEM certificate into the user CA store.
/// On physical devices where root is unavailable, logs a warning and
/// continues — the user will need to install the CA manually.
pub async fn install_ca_cert(serial: &str, ca_pem_path: &str, cert_filename: &str) -> Result<()> {
    // Check if already running as root (e.g. CLI called `adb root` during setup)
    let already_root = shell_lenient(serial, "id")
        .await
        .map(|out| out.contains("uid=0"))
        .unwrap_or(false);

    if already_root {
        debug!(%serial, "adb already running as root, skipping adb root");
    } else {
        // Attempt to restart adb as root — required for writing to system dirs
        let root_result = run_adb_lenient(serial, &["root"]).await;
        match root_result {
            Ok(output) => {
                let msg = String::from_utf8_lossy(&output);
                if msg.contains("cannot run as root") || msg.contains("adbd cannot run as root") {
                    tracing::warn!(
                        %serial,
                        "Device does not support adb root — CA must be installed manually"
                    );
                    return Err(anyhow::anyhow!(
                        "Device does not support adb root — HTTPS traffic will not be captured. \
                         Install the CA cert manually from ~/.tapsmith/ca.pem"
                    ));
                }
                debug!(%serial, "adb root succeeded, waiting for device");
            }
            Err(e) => {
                tracing::warn!(%serial, "adb root failed: {e} — CA must be installed manually");
                return Err(anyhow::anyhow!(
                    "adb root failed: {e} — HTTPS traffic will not be captured"
                ));
            }
        }

        // Wait for device to come back after root restart
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let _ = run_adb(Some(serial), &["wait-for-device"], DEFAULT_TIMEOUT).await;
    }

    // Push cert to a temp location
    push_file(serial, ca_pem_path, "/data/local/tmp/tapsmith-ca.pem").await?;

    // Install into user CA store with hash-based filename
    let device_path = device_ca_cert_path(cert_filename);
    shell(serial, &format!("mkdir -p {DEVICE_CA_CERT_DIR}")).await?;
    shell(
        serial,
        &format!("cp /data/local/tmp/tapsmith-ca.pem {device_path}"),
    )
    .await?;
    shell(serial, &format!("chmod 644 {device_path}")).await?;

    info!(%serial, "CA certificate installed on device");
    Ok(())
}

/// Run an adb command (with serial targeting) that may fail, returning stdout
/// regardless. Used for commands like `adb root` that can fail on non-rooted
/// devices.
async fn run_adb_lenient(serial: &str, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = Command::new("adb");
    cmd.arg("-s").arg(serial);
    cmd.args(args);

    debug!(serial = serial, args = ?args, "Running adb command (lenient)");

    let output = tokio::time::timeout(DEFAULT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| anyhow!("adb command timed out after {DEFAULT_TIMEOUT:?}"))?
        .context("Failed to execute adb")?;

    Ok(output.stdout)
}

/// Execute a shell command on the device, returning stdout as a String.
/// Unlike `shell()`, this does not fail on non-zero exit codes —
/// it returns stdout regardless, which is needed for commands like
/// `dumpsys` that may write to stdout before exiting with an error.
#[instrument]
pub async fn shell_lenient(serial: &str, command: &str) -> Result<String> {
    let mut cmd = Command::new("adb");
    cmd.arg("-s").arg(serial).arg("shell").arg(command);

    debug!(
        serial = serial,
        command = command,
        "Running adb shell (lenient)"
    );

    let output = tokio::time::timeout(DEFAULT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| anyhow!("adb command timed out after {DEFAULT_TIMEOUT:?}"))?
        .context("Failed to execute adb")?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parsed WebView debug socket entry from /proc/net/unix.
#[derive(Debug, Clone)]
pub struct WebViewSocket {
    pub socket_name: String,
    pub pid: i32,
    pub package_name: String,
}

/// List WebView debug sockets by parsing /proc/net/unix on the device.
///
/// Android exposes devtools_remote sockets for debuggable WebViews at
/// `@webview_devtools_remote_<pid>` or `@chrome_devtools_remote`.
#[instrument]
pub async fn list_webview_sockets(serial: &str) -> Result<Vec<WebViewSocket>> {
    let unix_output = shell_lenient(
        serial,
        "cat /proc/net/unix 2>/dev/null | grep devtools_remote",
    )
    .await?;

    let mut sockets = Vec::new();

    for line in unix_output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // /proc/net/unix format: Num RefCount Protocol Flags Type St Inode Path
        // The socket name is in the last field, prefixed with @
        let Some(path) = line.split_whitespace().last() else {
            continue;
        };
        let socket_name = path.trim_start_matches('@');
        if !socket_name.contains("devtools_remote") {
            continue;
        }

        // Extract PID from socket name: webview_devtools_remote_<pid>
        let pid: i32 = socket_name
            .rsplit('_')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        sockets.push(WebViewSocket {
            socket_name: socket_name.to_string(),
            pid,
            package_name: String::new(),
        });
    }

    if sockets.is_empty() {
        return Ok(sockets);
    }

    // Resolve PIDs to package names via /proc/<pid>/cmdline (more reliable
    // than parsing `ps` output, which varies across Android versions).
    for socket in &mut sockets {
        if socket.pid > 0 {
            if let Ok(cmdline) =
                shell_lenient(serial, &format!("cat /proc/{}/cmdline", socket.pid)).await
            {
                let pkg = cmdline.trim_matches('\0').trim();
                if !pkg.is_empty() {
                    socket.package_name = pkg.to_string();
                }
            }
        }
    }

    debug!(count = sockets.len(), "Found WebView debug sockets");
    Ok(sockets)
}

/// Forward a local TCP port to a device-side abstract Unix socket.
///
/// Used for Chrome DevTools Protocol connections to WebView debug sockets.
#[instrument]
pub async fn forward_abstract_socket(
    serial: &str,
    host_port: u16,
    socket_name: &str,
) -> Result<()> {
    let host_arg = format!("tcp:{host_port}");
    let device_arg = format!("localabstract:{socket_name}");
    run_adb(
        Some(serial),
        &["forward", &host_arg, &device_arg],
        DEFAULT_TIMEOUT,
    )
    .await?;
    debug!(
        host_port,
        socket_name, "Abstract socket forwarding established"
    );
    Ok(())
}

// ─── iptables transparent redirect (PILOT-187) ───

const IPTABLES_CHAIN: &str = "TAPSMITH_REDIRECT";

/// Set up iptables rules to transparently redirect HTTP (80) and HTTPS (443)
/// traffic through the proxy port. Returns `true` on success.
///
/// Uses a dedicated chain (`TAPSMITH_REDIRECT`) for easy identification and
/// cleanup. Traffic destined for `127.0.0.1` is excluded to prevent redirect
/// loops (the proxy is reached via `adb reverse` on loopback).
pub async fn setup_iptables_redirect(serial: &str, proxy_port: u16) -> bool {
    // Clean up any stale chain from a prior crash
    cleanup_iptables_redirect(serial).await;

    let commands = [
        format!("iptables -t nat -N {IPTABLES_CHAIN}"),
        format!("iptables -t nat -A {IPTABLES_CHAIN} -d 127.0.0.0/8 -j RETURN"),
        format!("iptables -t nat -A {IPTABLES_CHAIN} -p tcp --dport 80 -j REDIRECT --to-port {proxy_port}"),
        format!("iptables -t nat -A {IPTABLES_CHAIN} -p tcp --dport 443 -j REDIRECT --to-port {proxy_port}"),
        format!("iptables -t nat -A OUTPUT -j {IPTABLES_CHAIN}"),
    ];

    for cmd in &commands {
        if let Err(e) = shell(serial, cmd).await {
            warn!(%serial, cmd, "iptables command failed: {e}");
            cleanup_iptables_redirect(serial).await;
            return false;
        }
    }

    info!(%serial, proxy_port, "iptables transparent redirect configured");
    true
}

/// Remove the `TAPSMITH_REDIRECT` iptables chain and its reference from OUTPUT.
/// Safe to call even if the chain doesn't exist.
pub async fn cleanup_iptables_redirect(serial: &str) {
    // Remove the jump rule from OUTPUT (may fail if not present — that's fine)
    let _ = shell(
        serial,
        &format!("iptables -t nat -D OUTPUT -j {IPTABLES_CHAIN}"),
    )
    .await;
    // Flush and delete the chain
    let _ = shell(serial, &format!("iptables -t nat -F {IPTABLES_CHAIN}")).await;
    let _ = shell(serial, &format!("iptables -t nat -X {IPTABLES_CHAIN}")).await;
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
