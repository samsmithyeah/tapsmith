//! macOS system HTTP proxy fallback for iOS simulator network capture.
//!
//! When the mitmproxy Network Extension is unavailable (e.g. on CI runners
//! where System Extensions can't be approved), this module configures the
//! macOS system HTTP/HTTPS proxy via `networksetup` so the simulator
//! inherits the proxy setting and routes traffic through the MITM proxy.
//!
//! **Trade-off vs Network Extension**: The system proxy is global — it
//! affects all traffic on the host, not just the simulator's PID. This is
//! fine for CI (single worker, isolated runner) but not suitable for local
//! dev with concurrent workers. The NE redirector remains the preferred
//! path; this is a fallback.

use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, warn};

/// Candidate network service names, checked in order. GHA macOS runners
/// typically use "Ethernet"; developer machines typically use "Wi-Fi".
const CANDIDATE_SERVICES: &[&str] = &["Ethernet", "Wi-Fi"];

/// Detect the active macOS network service (the first one with an IP address).
async fn resolve_active_service() -> Result<String> {
    for &service in CANDIDATE_SERVICES {
        if let Ok(true) = service_has_ip(service).await {
            return Ok(service.to_string());
        }
    }

    // Fallback: enumerate all services and pick the first with an IP.
    let output = Command::new("/usr/sbin/networksetup")
        .args(["-listallnetworkservices"])
        .output()
        .await
        .context("running networksetup -listallnetworkservices")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let name = line.trim().trim_start_matches('*').trim();
        if name.is_empty() || name.contains("denotes") {
            continue;
        }
        if CANDIDATE_SERVICES.contains(&name) {
            continue; // already tried
        }
        if let Ok(true) = service_has_ip(name).await {
            return Ok(name.to_string());
        }
    }

    bail!(
        "No active macOS network service found. Checked: {CANDIDATE_SERVICES:?} \
         and all services from `networksetup -listallnetworkservices`. \
         The iOS system proxy fallback requires an active network connection."
    )
}

/// Check whether a network service has a non-empty, non-link-local IP address.
async fn service_has_ip(service: &str) -> Result<bool> {
    let output = Command::new("/usr/sbin/networksetup")
        .args(["-getinfo", service])
        .output()
        .await
        .with_context(|| format!("running networksetup -getinfo {service}"))?;
    if !output.status.success() {
        return Ok(false);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(ip) = line.strip_prefix("IP address:") {
            let ip = ip.trim();
            if !ip.is_empty() && ip != "none" {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Set the macOS system HTTP and HTTPS proxy to `127.0.0.1:<port>` on
/// the active network service. Returns the service name for cleanup.
pub async fn set_system_proxy(port: u16) -> Result<String> {
    let service = resolve_active_service().await?;
    let port_str = port.to_string();

    // Set HTTP proxy
    let status = Command::new("/usr/sbin/networksetup")
        .args(["-setwebproxy", &service, "127.0.0.1", &port_str])
        .status()
        .await
        .context("running networksetup -setwebproxy")?;
    if !status.success() {
        bail!("networksetup -setwebproxy failed with {status}");
    }

    // Set HTTPS proxy
    let status = Command::new("/usr/sbin/networksetup")
        .args(["-setsecurewebproxy", &service, "127.0.0.1", &port_str])
        .status()
        .await
        .context("running networksetup -setsecurewebproxy")?;
    if !status.success() {
        // Best-effort rollback of HTTP proxy
        let _ = Command::new("/usr/sbin/networksetup")
            .args(["-setwebproxystate", &service, "off"])
            .status()
            .await;
        bail!("networksetup -setsecurewebproxy failed with {status}");
    }

    // Set proxy bypass domains so the GHA runner's own traffic to GitHub
    // Actions infrastructure isn't routed through our MITM proxy. Without
    // this, the runner loses its heartbeat and GHA cancels the job with
    // "hosted runner lost communication with the server".
    let bypass = [
        "*.github.com",
        "*.githubusercontent.com",
        "*.actions.githubusercontent.com",
        "*.blob.core.windows.net",
        "*.azure.com",
        "*.microsoft.com",
        "*.apple.com",
        "localhost",
        "127.0.0.1",
    ];
    let status = Command::new("/usr/sbin/networksetup")
        .arg("-setproxybypassdomains")
        .arg(&service)
        .args(bypass)
        .status()
        .await
        .context("running networksetup -setproxybypassdomains")?;
    if !status.success() {
        warn!("networksetup -setproxybypassdomains failed with {status} — CI runner traffic may be proxied");
    }

    info!(
        service = %service,
        port,
        "macOS system proxy set to 127.0.0.1:{port} (iOS simulator fallback)"
    );
    Ok(service)
}

/// Disable the macOS system HTTP and HTTPS proxy on the given service.
pub async fn reset_system_proxy(service: &str) {
    debug!(service, "Resetting macOS system proxy");

    if let Err(e) = Command::new("/usr/sbin/networksetup")
        .args(["-setwebproxystate", service, "off"])
        .status()
        .await
    {
        warn!(service, "Failed to disable HTTP proxy: {e}");
    }
    if let Err(e) = Command::new("/usr/sbin/networksetup")
        .args(["-setsecurewebproxystate", service, "off"])
        .status()
        .await
    {
        warn!(service, "Failed to disable HTTPS proxy: {e}");
    }

    info!(service, "macOS system proxy disabled");
}
