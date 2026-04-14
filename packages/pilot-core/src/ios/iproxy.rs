//! USB-over-TCP tunnel for physical iOS devices via `iproxy`.
//!
//! Physical iOS devices bind the Pilot agent's socket on their own loopback
//! interface — unreachable from the host. `iproxy` (from `libimobiledevice`)
//! creates a USB-tunneled listener on `127.0.0.1:<host_port>` that forwards
//! to `127.0.0.1:<device_port>` on the device, letting the existing agent
//! ping/command code treat a physical device the same as a simulator.
//!
//! We own the `iproxy` child process lifetime: spawn on `IproxyHandle::start`,
//! kill on `Drop`. Early-exit detection happens at the first ping — if iproxy
//! died, the ping to `127.0.0.1:<host_port>` will surface `connection refused`,
//! which the agent startup loop already handles.

use anyhow::{bail, Context, Result};
use tokio::process::{Child, Command};
use tracing::{debug, info, warn};

/// Short wait after spawn so iproxy has a chance to either bind the port or
/// exit with an error. Long enough to catch "device not connected" / "UDID
/// not found" / "port already in use"; short enough not to slow agent startup.
const SPAWN_SETTLE_DELAY: std::time::Duration = std::time::Duration::from_millis(250);

/// Owned handle to a running `iproxy` child. Dropping this kills the process.
#[derive(Debug)]
pub struct IproxyHandle {
    child: Child,
    udid: String,
    host_port: u16,
    device_port: u16,
}

impl IproxyHandle {
    /// Spawn `iproxy --udid <udid> <host_port>:<device_port>`.
    ///
    /// Returns an error if:
    /// - `iproxy` binary is not on PATH (asks user to `brew install libimobiledevice`)
    /// - iproxy exits within ~250ms of spawn (usually means the device is
    ///   unreachable, the UDID is wrong, or the host port is in use)
    pub async fn start(udid: String, host_port: u16, device_port: u16) -> Result<Self> {
        if !is_iproxy_available().await {
            bail!(
                "iproxy not found on PATH. Install libimobiledevice:\n  \
                 brew install libimobiledevice\n\
                 Then re-run `pilot setup-ios-device` to verify."
            );
        }

        info!(%udid, host_port, device_port, "Starting iproxy USB tunnel");

        let port_spec = format!("{host_port}:{device_port}");
        let mut cmd = Command::new("iproxy");
        cmd.args(["--udid", &udid, &port_spec])
            // iproxy prints to stdout/stderr on errors — keep them piped so
            // a test harness or log viewer can capture them, but we don't
            // actively drain them to avoid another pair of background tasks.
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // Kill on parent exit as a belt-and-braces cleanup for the case
            // where the daemon is killed hard and `Drop` doesn't run.
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .context("Failed to spawn iproxy — libimobiledevice may be broken")?;

        // Give iproxy a quarter-second to crash if it's going to crash.
        tokio::time::sleep(SPAWN_SETTLE_DELAY).await;
        match child.try_wait() {
            Ok(Some(status)) => {
                // Read whatever stderr iproxy left behind so the error is
                // actionable rather than just "iproxy exited 1".
                let stderr = read_tail_stderr(&mut child).await;
                bail!(
                    "iproxy exited immediately with {status} for device {udid} \
                     (host={host_port}, device={device_port}). \
                     {stderr}\n  \
                     Common causes: the device is not plugged in, the UDID is \
                     wrong, the device is locked, or another iproxy is already \
                     using host port {host_port}."
                );
            }
            Ok(None) => {
                debug!(%udid, host_port, device_port, "iproxy alive after settle window");
            }
            Err(e) => {
                // Inability to poll the child is treated as the same kind of
                // hard failure as an early exit — we don't want to ship a
                // half-initialized tunnel back to the caller.
                bail!("Failed to poll iproxy status after spawn: {e}");
            }
        }

        Ok(Self {
            child,
            udid,
            host_port,
            device_port,
        })
    }

    /// The host TCP port the tunnel is listening on.
    #[allow(dead_code)]
    pub fn host_port(&self) -> u16 {
        self.host_port
    }

    /// The device TCP port on the far side of the tunnel.
    #[allow(dead_code)]
    pub fn device_port(&self) -> u16 {
        self.device_port
    }
}

impl Drop for IproxyHandle {
    fn drop(&mut self) {
        // `kill_on_drop(true)` already asks tokio to kill on drop, but that
        // fires at a non-deterministic point. We start an explicit kill so
        // the port is released synchronously for the next start_agent call.
        match self.child.start_kill() {
            Ok(()) => {
                debug!(
                    udid = %self.udid,
                    host_port = self.host_port,
                    device_port = self.device_port,
                    "iproxy tunnel torn down"
                );
            }
            Err(e) => {
                // Already-dead children return ESRCH which is fine.
                debug!(
                    udid = %self.udid,
                    error = %e,
                    "iproxy kill on drop returned non-fatal error"
                );
            }
        }
    }
}

/// Returns true if the `iproxy` binary is resolvable on PATH.
async fn is_iproxy_available() -> bool {
    Command::new("which")
        .arg("iproxy")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Read whatever's buffered on a dead child's stderr for error reporting.
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
            "iproxy stderr:\n  {}",
            String::from_utf8_lossy(&buf)
                .lines()
                .collect::<Vec<_>>()
                .join("\n  ")
        )
    }
}

/// Best-effort cleanup of stray iproxy processes bound to a specific UDID.
///
/// Called before spawning a fresh tunnel to guarantee the target host port is
/// free, similar to how `kill_existing_agents_on` sweeps stale xcodebuild
/// processes. Uses `pkill -f` matching on the UDID + port spec so we don't
/// kill tunnels for other devices or workers.
pub async fn kill_stray_iproxy(udid: &str, host_port: u16, device_port: u16) {
    let pattern = format!("iproxy --udid {udid} {host_port}:{device_port}");
    match Command::new("pkill").args(["-f", &pattern]).output().await {
        Ok(output) => {
            if output.status.success() {
                warn!(%udid, host_port, "Killed stray iproxy tunnel");
            }
        }
        Err(e) => {
            debug!(%udid, error = %e, "pkill for stray iproxy failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn start_without_iproxy_gives_actionable_error() {
        // When libimobiledevice is missing we must return a clear install
        // instruction — not a generic "command not found" from the OS.
        // This test only runs reliably on machines *without* iproxy, so we
        // skip when iproxy is present (CI will always skip, dev machines
        // that have already been set up will skip).
        if is_iproxy_available().await {
            eprintln!("iproxy is available — skipping missing-binary test");
            return;
        }
        let err = IproxyHandle::start("BOGUS-UDID".to_string(), 18700, 18700)
            .await
            .expect_err("start should fail when iproxy is absent");
        let msg = format!("{err}");
        assert!(
            msg.contains("brew install libimobiledevice"),
            "error message must point to the install command, got: {msg}"
        );
    }

    #[test]
    fn iproxy_handle_is_send() {
        // The handle is stored in an Arc<RwLock<Option<...>>> on PilotServer,
        // so it must be Send. (A non-Send field would make the surrounding
        // async handlers compile-fail, but testing explicitly catches it
        // earlier with a clearer error.)
        fn assert_send<T: Send>() {}
        assert_send::<IproxyHandle>();
    }
}
