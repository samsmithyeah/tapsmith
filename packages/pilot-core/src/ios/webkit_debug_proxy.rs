//! Managed `ios_webkit_debug_proxy` child process for iOS WebView testing.
//!
//! `ios-webkit-debug-proxy` (from Google/libimobiledevice) translates the
//! WebKit Inspector Protocol to Chrome DevTools Protocol (CDP), exposing iOS
//! WebViews on localhost TCP ports. This lets the TypeScript SDK use the same
//! CDP-based `WebViewHandle` for both Android and iOS.
//!
//! Lifecycle follows the `IproxyHandle` pattern: spawn on `start()`, kill on
//! `Drop`.

use anyhow::{bail, Context, Result};
use tokio::process::{Child, Command};
use tracing::{debug, info, warn};

const SPAWN_SETTLE_DELAY: std::time::Duration = std::time::Duration::from_millis(1000);

/// Owned handle to a running `ios_webkit_debug_proxy` child. Dropping kills it.
#[derive(Debug)]
pub struct WebkitDebugProxyHandle {
    child: Child,
    udid: String,
    port: u16,
}

impl WebkitDebugProxyHandle {
    /// Spawn `ios_webkit_debug_proxy` for a specific device.
    ///
    /// The proxy listens on `localhost:<port>` for the device listing and
    /// assigns WebView targets to ports in `[port+1, port+100)`.
    pub async fn start(udid: String, port: u16) -> Result<Self> {
        if !is_proxy_available().await {
            bail!(
                "ios_webkit_debug_proxy not found on PATH. Install it:\n  \
                 brew install ios-webkit-debug-proxy\n\
                 Then re-run your tests."
            );
        }

        // Kill any stray instance for this device/port before starting fresh
        kill_stray_proxy(&udid, port).await;

        info!(%udid, port, "Starting ios_webkit_debug_proxy");

        let port_range = format!("{udid}:{}-{}", port + 1, port + 100);
        let listen_arg = format!(":{port}");

        let mut cmd = Command::new("ios_webkit_debug_proxy");
        cmd.args(["-c", &port_range, "-F", "-p", &listen_arg])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .context("Failed to spawn ios_webkit_debug_proxy")?;

        // Give it time to start listening
        tokio::time::sleep(SPAWN_SETTLE_DELAY).await;
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr = read_tail_stderr(&mut child).await;
                bail!(
                    "ios_webkit_debug_proxy exited immediately with {status} for device {udid}. \
                     {stderr}\n  \
                     Common causes: the device is not connected, Safari Web Inspector is not \
                     enabled on the device, or another proxy is already using port {port}."
                );
            }
            Ok(None) => {
                debug!(%udid, port, "ios_webkit_debug_proxy alive after settle window");
            }
            Err(e) => {
                bail!("Failed to poll ios_webkit_debug_proxy status after spawn: {e}");
            }
        }

        Ok(Self { child, udid, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for WebkitDebugProxyHandle {
    fn drop(&mut self) {
        match self.child.start_kill() {
            Ok(()) => {
                debug!(
                    udid = %self.udid,
                    port = self.port,
                    "ios_webkit_debug_proxy torn down"
                );
            }
            Err(e) => {
                debug!(
                    udid = %self.udid,
                    error = %e,
                    "ios_webkit_debug_proxy kill on drop returned non-fatal error"
                );
            }
        }
    }
}

async fn is_proxy_available() -> bool {
    Command::new("which")
        .arg("ios_webkit_debug_proxy")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn read_tail_stderr(child: &mut Child) -> String {
    use tokio::io::AsyncReadExt;
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut buf = Vec::with_capacity(4096);
    let _ = stderr.read_to_end(&mut buf).await;
    if buf.is_empty() {
        String::new()
    } else {
        format!(
            "ios_webkit_debug_proxy stderr:\n  {}",
            String::from_utf8_lossy(&buf)
                .lines()
                .collect::<Vec<_>>()
                .join("\n  ")
        )
    }
}

async fn kill_stray_proxy(udid: &str, port: u16) {
    let pattern = format!("ios_webkit_debug_proxy.*{udid}");
    match Command::new("pkill").args(["-f", &pattern]).output().await {
        Ok(output) => {
            if output.status.success() {
                warn!(%udid, port, "Killed stray ios_webkit_debug_proxy");
            }
        }
        Err(e) => {
            debug!(%udid, error = %e, "pkill for stray ios_webkit_debug_proxy failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn start_without_proxy_gives_actionable_error() {
        if is_proxy_available().await {
            eprintln!("ios_webkit_debug_proxy is available — skipping missing-binary test");
            return;
        }
        let err = WebkitDebugProxyHandle::start("BOGUS-UDID".to_string(), 9300)
            .await
            .expect_err("start should fail when proxy is absent");
        let msg = format!("{err}");
        assert!(
            msg.contains("brew install ios-webkit-debug-proxy"),
            "error message must point to the install command, got: {msg}"
        );
    }

    #[test]
    fn proxy_handle_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<WebkitDebugProxyHandle>();
    }
}
