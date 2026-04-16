use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tokio_stream::Stream;
use tonic::{Request, Response, Status, Streaming};
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use crate::adb;
use crate::agent_comms::{AgentCommand, AgentConnection, AgentResponse};
use crate::device::DeviceManager;
use crate::ios;
use crate::mitm_ca::MitmAuthority;
use crate::network_proxy::NetworkProxy;
use crate::platform::Platform;
use crate::proto;
use crate::route_handler::RouteInterceptHandler;
use crate::screenshot;

pub struct PilotServiceImpl {
    device_manager: Arc<RwLock<DeviceManager>>,
    agent: Arc<RwLock<AgentConnection>>,
    network_proxy: Arc<RwLock<Option<NetworkProxy>>>,
    /// Serial/UDID of the device whose proxy settings were modified (for cleanup).
    proxy_device_serial: Arc<RwLock<Option<String>>>,
    /// Platform the proxy was started on (for platform-specific cleanup).
    proxy_platform: Arc<RwLock<Option<Platform>>>,
    /// Device-side port used for `adb reverse` (for cleanup, Android only).
    proxy_reverse_port: Arc<RwLock<Option<u16>>>,
    /// On-device path of the installed CA cert (for cleanup, Android only).
    proxy_ca_cert_path: Arc<RwLock<Option<String>>>,
    /// iOS Network Extension redirector session (for cleanup, iOS simulators only).
    #[cfg(target_os = "macos")]
    ios_redirect: Arc<RwLock<Option<crate::ios_redirect::IosRedirect>>>,
    /// iOS agent launch config (stored for restart on launchApp).
    ios_agent_config: Arc<RwLock<Option<IosAgentConfig>>>,
    /// iproxy USB tunnel for the physical iOS device, if any. Held for the
    /// lifetime of the XCUITest runner session; dropped when a new agent is
    /// started or the session is torn down.
    ios_iproxy: Arc<RwLock<Option<crate::ios::iproxy::IproxyHandle>>>,
    /// Whether the current session has network tracing enabled. Set from
    /// `SetDeviceRequest.network_tracing_enabled` and re-affirmed by
    /// `StartAgentRequest.network_tracing_enabled`. Gates the
    /// `ensure_ios_physical_proxy` pre-arming on physical iOS devices —
    /// when false, the daemon skips every MITM/OCSP-passthrough code path,
    /// which eliminates the entire failure surface for users who just want
    /// to run tests on a real phone without HTTP capture. The CLI is the
    /// single source of truth for this value; the daemon never reads
    /// pilot.config.ts itself.
    network_tracing_enabled: Arc<RwLock<bool>>,
    /// Active route interception handler, if a `NetworkRoute` stream is open.
    /// Stored here so that `start_network_capture` can install it on newly
    /// created proxies (the stream may open before or after capture starts).
    active_route_handler: Arc<RwLock<Option<Arc<RouteInterceptHandler>>>>,
}

/// Stored iOS agent launch config for restart.
#[derive(Clone)]
struct IosAgentConfig {
    xctestrun_path: String,
    target_package: String,
    /// Host path to the installed `.app` bundle. Only set when the target
    /// device is physical — used by `clearAppData` to reinstall the app as
    /// the only way to wipe persistent state on a real device.
    app_path: Option<String>,
}

impl PilotServiceImpl {
    pub fn new(
        device_manager: Arc<RwLock<DeviceManager>>,
        agent: Arc<RwLock<AgentConnection>>,
    ) -> Self {
        Self {
            device_manager,
            agent,
            network_proxy: Arc::new(RwLock::new(None)),
            proxy_device_serial: Arc::new(RwLock::new(None)),
            proxy_platform: Arc::new(RwLock::new(None)),
            proxy_reverse_port: Arc::new(RwLock::new(None)),
            proxy_ca_cert_path: Arc::new(RwLock::new(None)),
            #[cfg(target_os = "macos")]
            ios_redirect: Arc::new(RwLock::new(None)),
            ios_agent_config: Arc::new(RwLock::new(None)),
            ios_iproxy: Arc::new(RwLock::new(None)),
            network_tracing_enabled: Arc::new(RwLock::new(false)),
            active_route_handler: Arc::new(RwLock::new(None)),
        }
    }

    /// Returns `true` when the currently-selected device is a physical iOS
    /// device (i.e. iOS platform + `is_emulator == false`). Falls back to
    /// `false` when no device is selected or when the device manager cannot
    /// be queried — the existing simulator-oriented code paths remain the
    /// safe default.
    async fn is_active_ios_physical(&self) -> bool {
        let dm = self.device_manager.read().await;
        matches!(
            dm.active_device(),
            Some(d) if d.platform == Platform::Ios && !d.is_emulator
        )
    }

    /// Idempotently start the Wi-Fi MITM proxy bound to a physical iOS
    /// device's deterministic port. Needed whenever we're about to
    /// perform any operation on a physical device that might cause iOS
    /// to issue an OCSP trust-verification request to Apple — install,
    /// launch, agent start, agent restart, etc. Without a live listener
    /// at that port, the phone's Wi-Fi proxy settings route the OCSP
    /// request to a dead address and iOS rejects the app with the
    /// "Developer App Certificate is not trusted" umbrella error.
    ///
    /// Skipped if a proxy is already running. `start_network_capture`
    /// reuses the same listener, and `stop_network_capture` tears it
    /// down — we re-prime it from every physical-iOS entry point.
    #[cfg(target_os = "macos")]
    async fn ensure_ios_physical_proxy(&self, serial: &str) {
        if self.network_proxy.read().await.is_some() {
            return;
        }
        let ca = match MitmAuthority::load_or_create() {
            Ok(ca) => Arc::new(ca),
            Err(e) => {
                warn!(error = %e, "Failed to load MITM CA for Wi-Fi proxy pre-start");
                return;
            }
        };
        let port = ios::physical_device_proxy::deterministic_port(serial);
        let bind =
            std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), port);
        match NetworkProxy::start_on(ca, bind).await {
            Ok(proxy) => {
                info!(%serial, %bind, "Pre-started Wi-Fi MITM proxy for physical iOS OCSP passthrough");
                *self.network_proxy.write().await = Some(proxy);
            }
            Err(e) => {
                warn!(error = %e, %bind, "Failed to pre-start Wi-Fi MITM proxy; OCSP passthrough unavailable");
            }
        }
    }

    fn request_id(provided: &str) -> String {
        if provided.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            provided.to_string()
        }
    }

    async fn active_serial(&self) -> Result<String, Status> {
        self.device_manager
            .write()
            .await
            .resolve_serial()
            .await
            .map_err(|e| Status::failed_precondition(e.to_string()))
    }

    async fn send_agent_command(&self, command: &AgentCommand) -> Result<AgentResponse, Status> {
        let raw = self.agent.write().await.send_command(command).await;
        self.recover_agent_on_timeout(command, raw).await
    }

    /// Raw agent command send — no auto-recovery wrapper. Used by the
    /// recovery path itself (`probe_ios_agent_session` after a restart) to
    /// avoid recursion if the recovery attempt's probe command also times
    /// out.
    async fn send_agent_command_raw(
        &self,
        command: &AgentCommand,
        timeout_ms: u64,
    ) -> Result<AgentResponse, Status> {
        let timeout = if timeout_ms > 0 {
            Duration::from_millis(timeout_ms)
        } else {
            Duration::from_secs(30)
        };
        self.agent
            .write()
            .await
            .send_command_with_timeout(command, timeout)
            .await
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn send_agent_command_with_timeout(
        &self,
        command: &AgentCommand,
        timeout_ms: u64,
    ) -> Result<AgentResponse, Status> {
        let timeout = if timeout_ms > 0 {
            Duration::from_millis(timeout_ms)
        } else {
            Duration::from_secs(30)
        };

        let raw = self
            .agent
            .write()
            .await
            .send_command_with_timeout(command, timeout)
            .await;
        self.recover_agent_on_timeout(command, raw).await
    }

    /// If the agent command failed with a "timed out" error AND the active
    /// device is a physical iOS device, the XCUITest runner's accessibility
    /// connection has most likely wedged. Restart the agent in-place and
    /// retry the command once. Transparent to callers — a successful retry
    /// returns Ok, a failed retry surfaces the underlying error.
    ///
    /// Physical-iOS only: simulator runs are fast enough that a full agent
    /// restart per stuck command would be a meaningful regression, and
    /// Android has its own proven recovery path in session-preflight.
    async fn recover_agent_on_timeout(
        &self,
        command: &AgentCommand,
        result: anyhow::Result<AgentResponse>,
    ) -> Result<AgentResponse, Status> {
        let err = match result {
            Ok(resp) => return Ok(resp),
            Err(e) => e,
        };
        let msg = err.to_string();
        let looks_like_timeout = msg.contains("timed out") || msg.contains("Timed out");
        if !looks_like_timeout || !self.is_active_ios_physical().await {
            return Err(Status::internal(msg));
        }
        let config = match self.ios_agent_config.read().await.clone() {
            Some(c) => c,
            None => return Err(Status::internal(msg)),
        };
        let serial = match self.active_serial().await {
            Ok(s) => s,
            Err(_) => return Err(Status::internal(msg)),
        };
        warn!(
            error = %msg,
            "iOS agent command timed out on physical device, restarting agent and retrying"
        );
        if let Err(e) = self
            .restart_ios_agent_for_app(&serial, &config.target_package, false, 5_000)
            .await
        {
            return Err(Status::internal(format!(
                "Agent timed out ({msg}); recovery also failed: {e}"
            )));
        }
        self.agent
            .write()
            .await
            .send_command(command)
            .await
            .map_err(|e| {
                Status::internal(format!(
                    "Agent timed out ({msg}); post-recovery retry also failed: {e}"
                ))
            })
    }

    async fn probe_ios_agent_session(
        &self,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let timeout_ms = if wait_for_idle {
            if idle_timeout_ms > 0 {
                idle_timeout_ms.min(10_000)
            } else {
                10_000
            }
        } else {
            1_000
        };
        let idle = self
            .send_agent_command_raw(
                &AgentCommand::WaitForIdle {
                    timeout_ms: Some(timeout_ms),
                },
                timeout_ms,
            )
            .await
            .map_err(|status| status.message().to_string())?;
        if !idle.success {
            return Err(idle
                .error
                .unwrap_or_else(|| "iOS agent probe failed after relaunch".to_string()));
        }

        Ok(())
    }

    async fn relaunch_ios_app_via_simctl(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let _ = ios::device::terminate_app(serial, package_name).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        ios::device::launch_app(serial, package_name)
            .await
            .map_err(|e| e.to_string())?;
        let relaunch = self
            .send_agent_command_with_timeout(
                &AgentCommand::LaunchApp {
                    package: package_name.to_string(),
                },
                8_000,
            )
            .await
            .map_err(|status| status.message().to_string())?;
        if !relaunch.success {
            return Err(relaunch
                .error
                .unwrap_or_else(|| "iOS app activate failed after simctl relaunch".to_string()));
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self
                    .probe_ios_agent_session(wait_for_idle, idle_timeout_ms)
                    .await;
            }
            // Cap the probe timeout so it can't exceed the outer deadline.
            let capped_idle_timeout = (idle_timeout_ms).min(remaining.as_millis() as u64);
            let err = match self
                .probe_ios_agent_session(wait_for_idle, capped_idle_timeout)
                .await
            {
                Ok(()) => return Ok(()),
                Err(err) => err,
            };
            if tokio::time::Instant::now() >= deadline {
                return Err(err);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn relaunch_ios_app_via_agent(
        &self,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let _ = self
            .send_agent_command_with_timeout(
                &AgentCommand::TerminateApp {
                    package: package_name.to_string(),
                },
                4_000,
            )
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let launch = self
            .send_agent_command_with_timeout(
                &AgentCommand::LaunchApp {
                    package: package_name.to_string(),
                },
                8_000,
            )
            .await
            .map_err(|status| status.message().to_string())?;
        if !launch.success {
            return Err(launch
                .error
                .unwrap_or_else(|| "iOS agent launch failed".to_string()));
        }

        self.probe_ios_agent_session(wait_for_idle, idle_timeout_ms)
            .await
    }

    async fn restart_ios_agent_for_app(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let config = self
            .ios_agent_config
            .read()
            .await
            .clone()
            .ok_or_else(|| "iOS agent is not configured".to_string())?;

        let is_physical = self.is_active_ios_physical().await;

        ios::agent_launch::kill_existing_agents_on(serial).await;

        // Physical iOS: re-prime the Wi-Fi MITM proxy before xcodebuild so
        // iOS's OCSP query for the relaunched runner reaches our passthrough
        // path. A prior test's stop_network_capture may have torn it down.
        // Gated on `network_tracing_enabled`: when the session has tracing
        // off, iOS never routes through our proxy port anyway, so there's
        // nothing to pre-arm and we save the OCSP-race surface entirely.
        #[cfg(target_os = "macos")]
        if is_physical && *self.network_tracing_enabled.read().await {
            self.ensure_ios_physical_proxy(serial).await;
        }

        // On physical devices we skip the simctl-mediated pre-relaunch because
        // simctl does not work on real hardware. The XCUITest runner's own
        // `app.launch()` (inside the re-started agent) provides an equivalent
        // fresh launch — slower but correct.
        if !is_physical {
            let _ = ios::device::terminate_app(serial, package_name).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            ios::device::launch_app(serial, package_name)
                .await
                .map_err(|e| {
                    format!("Failed to relaunch app via simctl before agent restart: {e}")
                })?;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let agent_port = self.agent.read().await.port();
        let new_iproxy = ios::agent_launch::start_agent_fresh(
            serial,
            &config.xctestrun_path,
            &config.target_package,
            agent_port,
            is_physical,
        )
        .await
        .map_err(|e| format!("Failed to restart iOS agent: {e}"))?;
        if let Some(handle) = new_iproxy {
            // Drop the old handle (closing its tunnel) before storing the new one
            // so the host port is never owned by two iproxy instances at once.
            *self.ios_iproxy.write().await = Some(handle);
        }

        self.agent
            .write()
            .await
            .connect_ios(serial)
            .await
            .map_err(|e| format!("Failed to reconnect to agent: {e}"))?;

        self.probe_ios_agent_session(wait_for_idle, idle_timeout_ms)
            .await
    }

    async fn reset_ios_app(
        &self,
        serial: &str,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<(), String> {
        let is_physical = self.is_active_ios_physical().await;

        let t0 = std::time::Instant::now();
        match self
            .relaunch_ios_app_via_agent(package_name, wait_for_idle, idle_timeout_ms)
            .await
        {
            Ok(()) => {
                info!(
                    package_name,
                    elapsed_ms = t0.elapsed().as_millis() as u64,
                    "iOS app reset completed via in-runner relaunch"
                );
                return Ok(());
            }
            Err(err) => {
                warn!(
                    package_name,
                    error = %err,
                    elapsed_ms = t0.elapsed().as_millis() as u64,
                    "in-runner iOS relaunch failed; trying next fallback"
                );
            }
        }

        // Physical devices skip the simctl fallback entirely — simctl targets
        // Simulator runtimes, not real hardware. Jump straight to the full
        // agent restart path, which works for both target kinds.
        if is_physical {
            return self
                .restart_ios_agent_for_app(serial, package_name, wait_for_idle, idle_timeout_ms)
                .await;
        }

        let t1 = std::time::Instant::now();
        match self
            .relaunch_ios_app_via_simctl(serial, package_name, wait_for_idle, idle_timeout_ms)
            .await
        {
            Ok(()) => {
                info!(
                    package_name,
                    elapsed_ms = t1.elapsed().as_millis() as u64,
                    "iOS app reset completed via simctl relaunch"
                );
                Ok(())
            }
            Err(err) => {
                warn!(
                    package_name,
                    error = %err,
                    elapsed_ms = t1.elapsed().as_millis() as u64,
                    "simctl relaunch lost the iOS accessibility session; falling back to agent restart"
                );
                self.restart_ios_agent_for_app(serial, package_name, wait_for_idle, idle_timeout_ms)
                    .await
            }
        }
    }

    /// Get the platform of the active device.
    /// Returns None when no device has been selected yet — callers must
    /// not assume a default platform.
    async fn active_platform(&self) -> Option<Platform> {
        self.device_manager
            .read()
            .await
            .active_device()
            .map(|d| d.platform)
    }

    /// Require the active device's platform, returning a gRPC error if
    /// no device has been selected.
    async fn require_platform(&self) -> Result<Platform, Status> {
        self.active_platform()
            .await
            .ok_or_else(|| Status::failed_precondition("No device selected. Call SetDevice first."))
    }

    async fn error_screenshot(&self) -> Vec<u8> {
        let dm = self.device_manager.read().await;
        let serial = dm.active_serial().map(String::from);
        let platform = dm.active_device().map(|d| d.platform);
        drop(dm);
        match (serial.as_deref(), platform) {
            (Some(s), Some(p)) => screenshot::capture_for_error(Some(s), p).await,
            _ => Vec::new(), // No device selected — can't capture
        }
    }

    async fn action_error(
        &self,
        request_id: String,
        error_type: &str,
        error_message: String,
    ) -> Response<proto::ActionResponse> {
        let screenshot = self.error_screenshot().await;
        Response::new(proto::ActionResponse {
            request_id,
            success: false,
            error_type: error_type.to_string(),
            error_message,
            screenshot,
        })
    }

    /// Clean up network proxy state: revert device proxy settings, remove CA
    /// cert, and stop the proxy. Called during graceful shutdown to ensure the
    /// device isn't left with a dangling proxy configuration.
    pub async fn cleanup_network_proxy(&self) {
        // Take the iOS redirect handle out of its slot now so we can
        // deterministically drop it BEFORE `proxy.stop()` runs below.
        // Dropping the handle closes the SE control channel (removing
        // this worker's PID filter), aborts the accept/refresh/launcher
        // tasks, and aborts any in-flight per-flow handlers. Without
        // this ordering, those background tasks would keep dispatching
        // new flows into the proxy state we're about to tear down.
        //
        // Note: `let _ios_redirect = ...` would drop at end-of-scope
        // (after `proxy.stop()`) because Rust drops locals in reverse
        // declaration order. We rely on an explicit `drop()` call below
        // to get the right ordering.
        #[cfg(target_os = "macos")]
        let ios_redirect = self.ios_redirect.write().await.take();
        let proxy = self.network_proxy.write().await.take();
        let serial = self.proxy_device_serial.write().await.take();
        let platform = self.proxy_platform.write().await.take();
        let reverse_port = self.proxy_reverse_port.write().await.take();
        let ca_cert_path = self.proxy_ca_cert_path.write().await.take();

        if let Some(serial) = &serial {
            match platform {
                Some(Platform::Ios) => {
                    info!(%serial, "iOS proxy stopped on shutdown");
                }
                _ => {
                    info!(%serial, "Cleaning up Android proxy settings on shutdown");
                    if let Err(e) = adb::shell(serial, "settings put global http_proxy :0").await {
                        warn!(%serial, "Failed to reset http_proxy on shutdown: {e}");
                    }
                    if let Some(port) = reverse_port {
                        if let Err(e) = adb::remove_reverse(serial, port).await {
                            warn!(%serial, port, "Failed to remove reverse port forward on shutdown: {e}");
                        }
                    }
                    if let Some(cert_path) = &ca_cert_path {
                        if let Err(e) = adb::shell(serial, &format!("rm -f {cert_path}")).await {
                            warn!(%serial, "Failed to remove CA cert on shutdown: {e}");
                        }
                    }
                }
            }
        }

        // Explicit drop BEFORE `proxy.stop()` — see comment above. On
        // non-macOS this no-ops because `ios_redirect` doesn't exist.
        #[cfg(target_os = "macos")]
        drop(ios_redirect);

        if let Some(proxy) = proxy {
            let _ = proxy.stop().await;
        }
    }

    async fn make_action_response(
        &self,
        request_id: String,
        result: Result<AgentResponse, Status>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        match result {
            Ok(resp) if resp.success => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Ok(resp) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: resp.error_type.unwrap_or_default(),
                    error_message: resp.error.unwrap_or_else(|| "Unknown error".to_string()),
                    screenshot,
                }))
            }
            Err(status) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "INTERNAL".to_string(),
                    error_message: status.message().to_string(),
                    screenshot,
                }))
            }
        }
    }

    /// Validate that a string looks like a valid Android package name (e.g. `com.example.app`).
    #[allow(clippy::result_large_err)] // Status is tonic's standard error type
    fn validate_package_name(name: &str) -> Result<(), Status> {
        if name.is_empty() {
            return Err(Status::invalid_argument("package_name is required"));
        }
        // Package names: letters, digits, dots, underscores
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return Err(Status::invalid_argument(format!(
                "invalid package name: {name:?} — must contain only alphanumeric characters, dots, and underscores"
            )));
        }
        Ok(())
    }

    /// Validate that a string looks like a valid Android permission (e.g. `android.permission.CAMERA`).
    #[allow(clippy::result_large_err)]
    fn validate_permission(perm: &str) -> Result<(), Status> {
        if perm.is_empty() {
            return Err(Status::invalid_argument("permission is required"));
        }
        if !perm
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        {
            return Err(Status::invalid_argument(format!(
                "invalid permission: {perm:?} — must contain only alphanumeric characters, dots, and underscores"
            )));
        }
        Ok(())
    }

    /// Validate that a string looks like a valid Android activity name (e.g. `.MainActivity`).
    #[allow(clippy::result_large_err)]
    fn validate_activity(activity: &str) -> Result<(), Status> {
        if !activity
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$')
        {
            return Err(Status::invalid_argument(format!(
                "invalid activity name: {activity:?}"
            )));
        }
        Ok(())
    }

    /// Run an ADB shell command and return a success/failure ActionResponse.
    async fn adb_action(
        &self,
        request_id: String,
        command: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let serial = self.active_serial().await?;
        match adb::shell(&serial, command).await {
            Ok(_) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Err(e) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "ADB_COMMAND_FAILED".to_string(),
                    error_message: e.to_string(),
                    screenshot,
                }))
            }
        }
    }

    fn success_action_response(request_id: String) -> Response<proto::ActionResponse> {
        Response::new(proto::ActionResponse {
            request_id,
            success: true,
            error_type: String::new(),
            error_message: String::new(),
            screenshot: Vec::new(),
        })
    }

    /// Helper for methods where iOS is a no-op (returns success) and Android
    /// runs a single ADB shell command.
    async fn ios_noop_or_android_adb(
        &self,
        request_id: String,
        android_cmd: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => Ok(Self::success_action_response(request_id)),
            Platform::Android => self.adb_action(request_id, android_cmd).await,
        }
    }

    /// Helper for grant/revoke permission which share identical structure:
    /// iOS calls `ios::device::{action}_permission`, Android validates the
    /// permission format then runs `pm {action}`.
    async fn platform_permission_action(
        &self,
        request_id: String,
        package_name: &str,
        permission: &str,
        action: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // `xcrun simctl privacy` only targets simulators. Physical
                    // devices require user interaction (or MDM) to change
                    // permission state. Surface a clear error with a workaround
                    // pointing to the in-app permission dialog + UIInterruptionMonitor.
                    return Ok(self
                        .action_error(
                            request_id,
                            "UNSUPPORTED_ON_PHYSICAL_DEVICE",
                            format!(
                                "device.{action}Permission is not supported on physical iOS devices. \
                                 Workaround: trigger the in-app permission dialog during the test and \
                                 let the XCUITest UIInterruptionMonitor tap through it automatically."
                            ),
                        )
                        .await);
                }
                let serial = self.active_serial().await?;
                let result = match action {
                    "grant" => {
                        ios::device::grant_permission(&serial, package_name, permission).await
                    }
                    "revoke" => {
                        ios::device::revoke_permission(&serial, package_name, permission).await
                    }
                    _ => unreachable!("platform_permission_action called with invalid action"),
                };
                match result {
                    Ok(()) => Ok(Self::success_action_response(request_id)),
                    Err(e) => Ok(self
                        .action_error(request_id, "ACTION_FAILED", e.to_string())
                        .await),
                }
            }
            Platform::Android => {
                Self::validate_permission(permission)?;
                let cmd = format!("pm {action} {package_name} {permission}");
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    /// Helper for methods where iOS sends an agent command and Android runs an
    /// ADB shell command.
    async fn ios_agent_or_android_adb(
        &self,
        request_id: String,
        ios_command: &AgentCommand,
        android_cmd: &str,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let result = self.send_agent_command(ios_command).await;
                self.make_action_response(request_id, result).await
            }
            Platform::Android => self.adb_action(request_id, android_cmd).await,
        }
    }

    async fn finish_launch(
        &self,
        request_id: String,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let idle_timeout = if idle_timeout_ms > 0 {
            idle_timeout_ms
        } else {
            10_000
        };

        if wait_for_idle {
            let idle_cmd = AgentCommand::WaitForIdle {
                timeout_ms: Some(idle_timeout),
            };
            if let Err(e) = self
                .send_agent_command_with_timeout(&idle_cmd, idle_timeout)
                .await
            {
                let screenshot = self.error_screenshot().await;
                return Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "WAIT_FOR_IDLE_FAILED".to_string(),
                    error_message: format!("App launched but UI did not become idle: {e}"),
                    screenshot,
                }));
            }
        }

        Ok(Self::success_action_response(request_id))
    }

    /// Launch an app via ADB shell command, optionally wait for idle, and return
    /// a success/failure ActionResponse. Shared by `launch_app` and `restart_app`.
    async fn launch_and_idle(
        &self,
        serial: &str,
        request_id: String,
        launch_cmd: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        match adb::shell(serial, launch_cmd).await {
            Ok(_) => {
                self.finish_launch(request_id, wait_for_idle, idle_timeout_ms)
                    .await
            }
            Err(e) => {
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "LAUNCH_FAILED".to_string(),
                    error_message: format!("Failed to launch app: {e}"),
                    screenshot,
                }))
            }
        }
    }

    async fn resolve_launcher_activity(
        &self,
        serial: &str,
        package_name: &str,
    ) -> Result<Option<String>, Status> {
        let commands = [
            format!("cmd package resolve-activity --brief {package_name}"),
            format!("pm resolve-activity --brief {package_name}"),
        ];

        for command in commands {
            let output = adb::shell_lenient(serial, &command)
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

            if let Some(activity) = parse_resolved_activity(&output, package_name) {
                return Ok(Some(activity));
            }
        }

        Ok(None)
    }

    async fn launch_package(
        &self,
        serial: &str,
        request_id: String,
        package_name: &str,
        wait_for_idle: bool,
        idle_timeout_ms: u64,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let monkey_cmd = format!(
            "monkey -p {} -c android.intent.category.LAUNCHER 1",
            package_name
        );

        match adb::shell(serial, &monkey_cmd).await {
            Ok(_) => {
                self.finish_launch(request_id, wait_for_idle, idle_timeout_ms)
                    .await
            }
            Err(monkey_err) => {
                let Some(activity) = self.resolve_launcher_activity(serial, package_name).await?
                else {
                    let screenshot = self.error_screenshot().await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "LAUNCH_FAILED".to_string(),
                        error_message: format!("Failed to launch app: {monkey_err}"),
                        screenshot,
                    }));
                };

                let fallback_cmd =
                    format!("am start -S --activity-clear-task -n {package_name}/{activity}");
                match adb::shell(serial, &fallback_cmd).await {
                    Ok(_) => {
                        self.finish_launch(request_id, wait_for_idle, idle_timeout_ms)
                            .await
                    }
                    Err(fallback_err) => {
                        let screenshot = self.error_screenshot().await;
                        Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "LAUNCH_FAILED".to_string(),
                            error_message: format!(
                                "Failed to launch app via launcher intent ({monkey_err}) and explicit activity {activity} ({fallback_err})"
                            ),
                            screenshot,
                        }))
                    }
                }
            }
        }
    }

    /// Query dumpsys for the current resumed activity and return `(package, activity)`.
    async fn get_current_component(&self) -> Result<Option<(String, String)>, Status> {
        let serial = self.active_serial().await?;
        let output = adb::shell_lenient(
            &serial,
            "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity'",
        )
        .await
        .map_err(|e| Status::internal(e.to_string()))?;

        Ok(parse_component_name(&output))
    }
}

/// Convert a protobuf Selector into a JSON value for the agent protocol.
pub(crate) fn selector_to_json(selector: &proto::Selector) -> Value {
    let mut obj = json!({});

    if let Some(ref sel) = selector.selector {
        match sel {
            proto::selector::Selector::Role(role_sel) => {
                obj["role"] = json!({
                    "role": role_sel.role,
                    "name": role_sel.name,
                });
            }
            proto::selector::Selector::Text(t) => {
                obj["text"] = json!(t);
            }
            proto::selector::Selector::TextContains(t) => {
                obj["textContains"] = json!(t);
            }
            proto::selector::Selector::ContentDesc(t) => {
                obj["contentDesc"] = json!(t);
            }
            proto::selector::Selector::Hint(t) => {
                obj["hint"] = json!(t);
            }
            proto::selector::Selector::ClassName(t) => {
                obj["className"] = json!(t);
            }
            proto::selector::Selector::TestId(t) => {
                obj["testId"] = json!(t);
            }
            proto::selector::Selector::ResourceId(t) => {
                obj["resourceId"] = json!(t);
            }
            proto::selector::Selector::Xpath(t) => {
                obj["xpath"] = json!(t);
            }
        }
    }

    if let Some(ref parent) = selector.parent {
        obj["parent"] = selector_to_json(parent);
    }

    obj
}

pub(crate) fn opt_timeout(ms: u64) -> Option<u64> {
    if ms > 0 {
        Some(ms)
    } else {
        None
    }
}

#[tonic::async_trait]
impl proto::pilot_service_server::PilotService for PilotServiceImpl {
    #[instrument(skip_all, fields(request_id))]
    async fn find_element(
        &self,
        request: Request<proto::FindElementRequest>,
    ) -> Result<Response<proto::FindElementResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::FindElement {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;

        match result {
            Ok(resp) if resp.success => {
                let element = parse_element_info(&resp.data);
                Ok(Response::new(proto::FindElementResponse {
                    request_id,
                    found: true,
                    element,
                    error_message: String::new(),
                }))
            }
            Ok(resp) => Ok(Response::new(proto::FindElementResponse {
                request_id,
                found: false,
                element: None,
                error_message: resp
                    .error
                    .unwrap_or_else(|| "Element not found".to_string()),
            })),
            Err(status) => Ok(Response::new(proto::FindElementResponse {
                request_id,
                found: false,
                element: None,
                error_message: status.message().to_string(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn find_elements(
        &self,
        request: Request<proto::FindElementsRequest>,
    ) -> Result<Response<proto::FindElementsResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::FindElements {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;

        match result {
            Ok(resp) if resp.success => {
                let elements = parse_element_list(&resp.data);
                Ok(Response::new(proto::FindElementsResponse {
                    request_id,
                    elements,
                    error_message: String::new(),
                }))
            }
            Ok(resp) => Ok(Response::new(proto::FindElementsResponse {
                request_id,
                elements: Vec::new(),
                error_message: resp.error.unwrap_or_default(),
            })),
            Err(status) => Ok(Response::new(proto::FindElementsResponse {
                request_id,
                elements: Vec::new(),
                error_message: status.message().to_string(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn tap(
        &self,
        request: Request<proto::TapRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::Tap {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn long_press(
        &self,
        request: Request<proto::LongPressRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::LongPress {
            selector: selector_to_json(selector),
            duration_ms: opt_timeout(req.duration_ms),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn type_text(
        &self,
        request: Request<proto::TypeTextRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::TypeText {
            selector: selector_to_json(selector),
            text: req.text,
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn clear_text(
        &self,
        request: Request<proto::ClearTextRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::ClearText {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn clear_and_type(
        &self,
        request: Request<proto::ClearAndTypeRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let sel_json = selector_to_json(selector);

        // Clear first, then type
        let clear_cmd = AgentCommand::ClearText {
            selector: sel_json.clone(),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let clear_result = self
            .send_agent_command_with_timeout(&clear_cmd, req.timeout_ms)
            .await;

        if let Err(e) = &clear_result {
            return self.make_action_response(request_id, Err(e.clone())).await;
        }

        if let Ok(ref resp) = clear_result {
            if !resp.success {
                return self.make_action_response(request_id, clear_result).await;
            }
        }

        let type_cmd = AgentCommand::TypeText {
            selector: sel_json,
            text: req.text,
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&type_cmd, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn swipe(
        &self,
        request: Request<proto::SwipeRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let start_element = req.start_element.as_ref().map(selector_to_json);

        let command = AgentCommand::Swipe {
            direction: req.direction,
            start_element,
            speed: if req.speed > 0.0 {
                Some(req.speed)
            } else {
                None
            },
            distance: if req.distance > 0.0 {
                Some(req.distance)
            } else {
                None
            },
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn scroll(
        &self,
        request: Request<proto::ScrollRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let container = req.container.as_ref().map(selector_to_json);
        let scroll_until_visible = req.scroll_until_visible.as_ref().map(selector_to_json);

        let command = AgentCommand::Scroll {
            container,
            direction: req.direction,
            scroll_until_visible,
            distance: if req.distance > 0.0 {
                Some(req.distance)
            } else {
                None
            },
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn press_key(
        &self,
        request: Request<proto::PressKeyRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let command = AgentCommand::PressKey { key: req.key };

        let result = self.send_agent_command(&command).await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn take_screenshot(
        &self,
        request: Request<proto::ScreenshotRequest>,
    ) -> Result<Response<proto::ScreenshotResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;

        // On iOS, route through the agent (XCUIScreen.main.screenshot()) which
        // is much faster than spawning `xcrun simctl io screenshot` per call.
        if platform == Platform::Ios {
            let command = AgentCommand::Screenshot {};
            // Use a short timeout — screenshots are best-effort for tracing
            // and should not block for 30s if the agent is busy.
            match self.send_agent_command_with_timeout(&command, 5000).await {
                Ok(resp) if resp.success => {
                    let b64_str = resp.data.get("data").and_then(|v| v.as_str()).unwrap_or("");
                    use base64::Engine;
                    match base64::engine::general_purpose::STANDARD.decode(b64_str) {
                        Ok(data) => Ok(Response::new(proto::ScreenshotResponse {
                            request_id,
                            success: true,
                            data,
                            error_message: String::new(),
                        })),
                        Err(e) => Ok(Response::new(proto::ScreenshotResponse {
                            request_id,
                            success: false,
                            data: Vec::new(),
                            error_message: format!("Failed to decode screenshot data: {e}"),
                        })),
                    }
                }
                Ok(resp) => Ok(Response::new(proto::ScreenshotResponse {
                    request_id,
                    success: false,
                    data: Vec::new(),
                    error_message: resp
                        .error
                        .unwrap_or_else(|| "Screenshot failed".to_string()),
                })),
                Err(status) => Ok(Response::new(proto::ScreenshotResponse {
                    request_id,
                    success: false,
                    data: Vec::new(),
                    error_message: status.message().to_string(),
                })),
            }
        } else {
            let serial = self.active_serial().await?;
            match screenshot::capture(&serial, platform).await {
                Ok(data) => Ok(Response::new(proto::ScreenshotResponse {
                    request_id,
                    success: true,
                    data,
                    error_message: String::new(),
                })),
                Err(e) => Ok(Response::new(proto::ScreenshotResponse {
                    request_id,
                    success: false,
                    data: Vec::new(),
                    error_message: e.to_string(),
                })),
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_ui_hierarchy(
        &self,
        request: Request<proto::UiHierarchyRequest>,
    ) -> Result<Response<proto::UiHierarchyResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let command = AgentCommand::GetUiHierarchy {};

        match self.send_agent_command(&command).await {
            Ok(resp) if resp.success => {
                let xml = resp
                    .data
                    .get("hierarchy")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                Ok(Response::new(proto::UiHierarchyResponse {
                    request_id,
                    hierarchy_xml: xml,
                    error_message: String::new(),
                }))
            }
            Ok(resp) => Ok(Response::new(proto::UiHierarchyResponse {
                request_id,
                hierarchy_xml: String::new(),
                error_message: resp.error.unwrap_or_default(),
            })),
            Err(status) => Ok(Response::new(proto::UiHierarchyResponse {
                request_id,
                hierarchy_xml: String::new(),
                error_message: status.message().to_string(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn wait_for_idle(
        &self,
        request: Request<proto::WaitForIdleRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let command = AgentCommand::WaitForIdle {
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn install_apk(
        &self,
        request: Request<proto::InstallApkRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let serial = self.active_serial().await?;

        info!(apk_path = %req.apk_path, "Installing APK");

        match adb::install_apk(&serial, &req.apk_path).await {
            Ok(()) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Err(e) => {
                error!(error = %e, "APK installation failed");
                let screenshot = self.error_screenshot().await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "INSTALL_FAILED".to_string(),
                    error_message: e.to_string(),
                    screenshot,
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn list_devices(
        &self,
        request: Request<proto::ListDevicesRequest>,
    ) -> Result<Response<proto::ListDevicesResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let mut dm = self.device_manager.write().await;
        dm.refresh()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let devices = dm
            .devices()
            .iter()
            .map(|d| proto::DeviceInfo {
                serial: d.serial.clone(),
                model: d.model.clone(),
                state: format!("{:?}", d.state),
                is_emulator: d.is_emulator,
                platform: d.platform.as_str().to_string(),
                os_version: d.os_version.clone(),
            })
            .collect();

        Ok(Response::new(proto::ListDevicesResponse {
            request_id,
            devices,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_device(
        &self,
        request: Request<proto::SetDeviceRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let mut dm = self.device_manager.write().await;

        // Refresh to make sure the device is known
        dm.refresh()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        match dm.set_active(&req.serial) {
            Ok(()) => {
                // Drop the device_manager lock before the async pre-start so
                // ensure_ios_physical_proxy can acquire its own locks without
                // deadlocking against our write guard.
                drop(dm);
                // Persist the CLI's tracing flag on the server so subsequent
                // call sites (start_agent, recovery restarts) can check it
                // without re-plumbing the bool through every request. The
                // CLI is authoritative — it derives this from pilot.config.ts.
                *self.network_tracing_enabled.write().await = req.network_tracing_enabled;
                // For physical iOS with tracing enabled, pre-start the Wi-Fi
                // MITM proxy immediately so any subsequent devicectl install
                // / launch / xcodebuild invocation can't race the phone's
                // OCSP check (which routes through the Wi-Fi proxy port on
                // the Mac). When tracing is off, iOS has no reason to route
                // through our proxy at all, so we skip the pre-start entirely
                // — this is the single biggest basic-track failure reduction.
                #[cfg(target_os = "macos")]
                if req.network_tracing_enabled && self.is_active_ios_physical().await {
                    self.ensure_ios_physical_proxy(&req.serial).await;
                    // Push the current trace.networkHosts allowlist into
                    // the live proxy so the next `/pilot.pac` fetch from
                    // iOS reflects the user's pilot.config.ts exactly.
                    // Safe to call while the proxy is serving traffic.
                    if let Some(proxy) = self.network_proxy.read().await.as_ref() {
                        proxy.set_network_hosts(req.network_hosts.clone()).await;
                    }
                }
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Err(e) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: false,
                error_type: "DEVICE_NOT_FOUND".to_string(),
                error_message: e.to_string(),
                screenshot: Vec::new(),
            })),
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn start_agent(
        &self,
        request: Request<proto::StartAgentRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;

        info!(serial = %serial, %platform, "Starting agent connection");

        info!(ios_xctestrun_path = %req.ios_xctestrun_path, "StartAgent fields");

        match platform {
            Platform::Ios => {
                // ─── iOS: launch XCUITest agent ───
                if req.ios_xctestrun_path.is_empty() {
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_NOT_CONFIGURED".to_string(),
                        error_message: "iOS agent not configured. \
                            Set iosXctestrun in your pilot config."
                            .to_string(),
                        screenshot: Vec::new(),
                    }));
                }

                let is_physical = self.is_active_ios_physical().await;

                // Apply test-friendly defaults every time the agent starts,
                // not just on first boot — reused simulators may have stale config.
                // Skipped entirely on physical devices: the simctl spawns
                // would fail, and the device's defaults are user-owned anyway.
                if !is_physical {
                    ios::device::configure_simulator(&serial).await;
                }

                // Drop any prior iproxy tunnel BEFORE start_agent so the
                // existing host port is free when start_agent tries to bind
                // a fresh tunnel. Without this, a re-started agent on the
                // same physical device would fight its own leftover tunnel.
                *self.ios_iproxy.write().await = None;

                // Re-affirm the server-wide tracing flag. SetDevice is the
                // primary setter, but StartAgent is called in the same RPC
                // sequence — keeping both in sync is defensive against
                // future clients that skip set_device.
                *self.network_tracing_enabled.write().await = req.network_tracing_enabled;

                // Pre-start the Wi-Fi MITM proxy for physical iOS devices
                // with tracing enabled. Idempotent — skipped if already
                // bound (typically from set_device). Re-primes when prior
                // test's stop_network_capture tore the listener down. When
                // tracing is off, skipped entirely (see SetDevice for why).
                #[cfg(target_os = "macos")]
                if is_physical && req.network_tracing_enabled {
                    self.ensure_ios_physical_proxy(&serial).await;
                }

                let agent_port = self.agent.read().await.port();
                let iproxy_handle = match ios::agent_launch::start_agent(
                    &serial,
                    &req.ios_xctestrun_path,
                    &req.target_package,
                    agent_port,
                    is_physical,
                )
                .await
                {
                    Ok(handle) => handle,
                    Err(e) => {
                        error!(error = %e, "Failed to start iOS agent");
                        return Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "AGENT_START_FAILED".to_string(),
                            error_message: e.to_string(),
                            screenshot: Vec::new(),
                        }));
                    }
                };
                if let Some(handle) = iproxy_handle {
                    *self.ios_iproxy.write().await = Some(handle);
                }

                // Store config for potential agent restart in launchApp
                *self.ios_agent_config.write().await = Some(IosAgentConfig {
                    xctestrun_path: req.ios_xctestrun_path.clone(),
                    target_package: req.target_package.clone(),
                    app_path: (!req.ios_app_path.is_empty()).then(|| req.ios_app_path.clone()),
                });
            }
            Platform::Android => {
                // ─── Android: install APKs and launch instrumentation ───
                let has_apk_paths =
                    !req.agent_apk_path.is_empty() && !req.agent_test_apk_path.is_empty();
                let agent_installed = adb::is_package_installed(&serial, "dev.pilot.agent")
                    .await
                    .unwrap_or(false);

                if !agent_installed && !has_apk_paths {
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_NOT_INSTALLED".to_string(),
                        error_message: "Pilot agent is not installed on the device. \
                            Set agentApk and agentTestApk in your pilot config, \
                            or install manually with: adb install <path-to-agent.apk>"
                            .to_string(),
                        screenshot: Vec::new(),
                    }));
                }

                // Always reinstall when APK paths are provided so that code
                // changes to the agent are deployed without manual intervention.
                if has_apk_paths {
                    info!("Installing agent APKs...");
                    if let Err(e) = adb::install_apk(&serial, &req.agent_apk_path).await {
                        return Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "AGENT_INSTALL_FAILED".to_string(),
                            error_message: format!("Failed to install agent APK: {e}"),
                            screenshot: Vec::new(),
                        }));
                    }
                    if let Err(e) = adb::install_apk(&serial, &req.agent_test_apk_path).await {
                        return Ok(Response::new(proto::ActionResponse {
                            request_id,
                            success: false,
                            error_type: "AGENT_INSTALL_FAILED".to_string(),
                            error_message: format!("Failed to install agent test APK: {e}"),
                            screenshot: Vec::new(),
                        }));
                    }
                    info!("Agent APKs installed successfully");
                }

                // Launch the agent instrumentation
                let instrument_cmd = if req.target_package.is_empty() {
                    "am instrument -w dev.pilot.agent/.PilotAgent".to_string()
                } else {
                    format!(
                        "am instrument -w -e targetPackage {} dev.pilot.agent/.PilotAgent",
                        req.target_package
                    )
                };

                // Launch in background on device
                let bg_cmd = format!("nohup {} > /dev/null 2>&1 &", instrument_cmd);
                if let Err(e) = adb::shell(&serial, &bg_cmd).await {
                    error!(error = %e, "Failed to start agent instrumentation");
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_START_FAILED".to_string(),
                        error_message: e.to_string(),
                        screenshot: Vec::new(),
                    }));
                }

                // Give the agent a moment to start
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }

        // Connect to the agent (iOS: direct TCP, Android: via ADB port forward)
        let mut agent = self.agent.write().await;
        let connect_result = match platform {
            Platform::Ios => agent.connect_ios(&serial).await,
            Platform::Android => agent.connect(&serial).await,
        };
        match connect_result {
            Ok(()) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Err(e) => {
                error!(error = %e, "Failed to connect to agent");
                let platform = self.require_platform().await?;
                let screenshot = screenshot::capture_for_error(Some(&serial), platform).await;
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: false,
                    error_type: "AGENT_CONNECTION_FAILED".to_string(),
                    error_message: e.to_string(),
                    screenshot,
                }))
            }
        }
    }

    async fn ping(
        &self,
        _request: Request<proto::PingRequest>,
    ) -> Result<Response<proto::PingResponse>, Status> {
        let agent_connected = self.agent.read().await.is_connected();

        Ok(Response::new(proto::PingResponse {
            version: env!("CARGO_PKG_VERSION").to_string(),
            agent_connected,
        }))
    }

    // ── Element Actions (PILOT-2) ──

    #[instrument(skip_all, fields(request_id))]
    async fn double_tap(
        &self,
        request: Request<proto::DoubleTapRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::DoubleTap {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn drag_and_drop(
        &self,
        request: Request<proto::DragAndDropRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let source = req
            .source_selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("source_selector is required"))?;
        let target = req
            .target_selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("target_selector is required"))?;

        let command = AgentCommand::DragAndDrop {
            source_selector: selector_to_json(source),
            target_selector: selector_to_json(target),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn select_option(
        &self,
        request: Request<proto::SelectOptionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let (option, index) = match req.selection {
            Some(proto::select_option_request::Selection::Option(ref opt)) => {
                (Some(opt.clone()), None)
            }
            Some(proto::select_option_request::Selection::Index(idx)) => (None, Some(idx)),
            None => {
                return Err(Status::invalid_argument(
                    "either option or index is required",
                ));
            }
        };

        let command = AgentCommand::SelectOption {
            selector: selector_to_json(selector),
            option,
            index,
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn pinch_zoom(
        &self,
        request: Request<proto::PinchZoomRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::PinchZoom {
            selector: selector_to_json(selector),
            scale: req.scale,
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn focus(
        &self,
        request: Request<proto::FocusRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::Focus {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn blur(
        &self,
        request: Request<proto::BlurRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::Blur {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn highlight(
        &self,
        request: Request<proto::HighlightRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::Highlight {
            selector: selector_to_json(selector),
            duration_ms: opt_timeout(req.duration_ms),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;
        self.make_action_response(request_id, result).await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn take_element_screenshot(
        &self,
        request: Request<proto::TakeElementScreenshotRequest>,
    ) -> Result<Response<proto::ScreenshotResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let selector = req
            .selector
            .as_ref()
            .ok_or_else(|| Status::invalid_argument("selector is required"))?;

        let command = AgentCommand::TakeElementScreenshot {
            selector: selector_to_json(selector),
            timeout_ms: opt_timeout(req.timeout_ms),
        };

        let result = self
            .send_agent_command_with_timeout(&command, req.timeout_ms)
            .await;

        match result {
            Ok(resp) if resp.success => {
                let b64_str = resp.data.get("data").and_then(|v| v.as_str()).unwrap_or("");

                use base64::Engine;
                match base64::engine::general_purpose::STANDARD.decode(b64_str) {
                    Ok(data) => Ok(Response::new(proto::ScreenshotResponse {
                        request_id,
                        success: true,
                        data,
                        error_message: String::new(),
                    })),
                    Err(e) => {
                        error!("Failed to decode element screenshot base64: {e}");
                        Ok(Response::new(proto::ScreenshotResponse {
                            request_id,
                            success: false,
                            data: Vec::new(),
                            error_message: format!("Failed to decode screenshot data: {e}"),
                        }))
                    }
                }
            }
            Ok(resp) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: false,
                data: Vec::new(),
                error_message: resp
                    .error
                    .unwrap_or_else(|| "Screenshot failed".to_string()),
            })),
            Err(status) => Ok(Response::new(proto::ScreenshotResponse {
                request_id,
                success: false,
                data: Vec::new(),
                error_message: status.message().to_string(),
            })),
        }
    }

    // ── Device Management (PILOT-10) ──

    #[instrument(skip_all, fields(request_id))]
    async fn launch_app(
        &self,
        request: Request<proto::LaunchAppRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;

        Self::validate_package_name(&req.package_name)?;

        match platform {
            Platform::Ios => {
                let idle_timeout_ms = if req.idle_timeout_ms > 0 {
                    req.idle_timeout_ms
                } else {
                    10000
                };
                let is_physical = self.is_active_ios_physical().await;

                if req.clear_data {
                    if is_physical {
                        // Physical devices have no host-accessible app container
                        // filesystem — `get_app_container` / `clear_container`
                        // are simulator-only hacks. Instead, we rely on the
                        // agent-mediated relaunch below to provide a fresh
                        // launch; to actually wipe persistent state on a
                        // physical device the user must reinstall the app
                        // (future work: wire reinstall via devicectl into
                        // clear_data).
                        warn!(
                            package = %req.package_name,
                            "clear_data on physical iOS device is best-effort: \
                             persistent AsyncStorage/caches are not wiped. \
                             Reinstall the app via `pilot test --force-install` \
                             for a clean slate."
                        );
                    } else {
                        // Terminate the app first to avoid file access conflicts
                        // when clearing the data container.
                        let _ = ios::device::terminate_app(&serial, &req.package_name).await;
                        // Clear the data container (AsyncStorage, caches, etc.)
                        // without uninstalling the app.
                        match ios::device::get_app_container(&serial, &req.package_name).await {
                            Ok(ref container) => {
                                if let Err(e) = ios::device::clear_container(container).await {
                                    warn!(error = %e, "Failed to clear app container");
                                }
                            }
                            Err(e) => {
                                debug!(error = %e, "Could not get app container");
                            }
                        }
                    }
                }

                if let Err(error_message) = self
                    .reset_ios_app(
                        &serial,
                        &req.package_name,
                        req.wait_for_idle,
                        idle_timeout_ms,
                    )
                    .await
                {
                    return Ok(self
                        .action_error(request_id, "LAUNCH_FAILED", error_message)
                        .await);
                }

                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Platform::Android => {
                if !req.activity.is_empty() {
                    Self::validate_activity(&req.activity)?;
                }

                // Clear data first if requested
                if req.clear_data {
                    match adb::shell(&serial, &format!("pm clear {}", req.package_name)).await {
                        Ok(output) if !output.trim().starts_with("Success") => {
                            error!(output = %output.trim(), "pm clear did not report success");
                            let screenshot = self.error_screenshot().await;
                            return Ok(Response::new(proto::ActionResponse {
                                request_id,
                                success: false,
                                error_type: "CLEAR_DATA_FAILED".to_string(),
                                error_message: format!(
                                    "Failed to clear app data: {}",
                                    output.trim()
                                ),
                                screenshot,
                            }));
                        }
                        Err(e) => {
                            error!(error = %e, "Failed to clear app data before launch");
                            let screenshot = self.error_screenshot().await;
                            return Ok(Response::new(proto::ActionResponse {
                                request_id,
                                success: false,
                                error_type: "CLEAR_DATA_FAILED".to_string(),
                                error_message: format!("Failed to clear app data: {e}"),
                                screenshot,
                            }));
                        }
                        Ok(_) => {} // Success
                    }
                }

                if req.activity.is_empty() {
                    self.launch_package(
                        &serial,
                        request_id,
                        &req.package_name,
                        req.wait_for_idle,
                        req.idle_timeout_ms,
                    )
                    .await
                } else {
                    // -S force-stops the app before launching, ensuring no
                    // residual savedInstanceState Bundle survives from a
                    // previous Activity. Without it, React Navigation /
                    // Expo Router can restore stale navigation state from
                    // the Bundle even after pm clear wiped AsyncStorage.
                    // --activity-clear-task ensures a fresh task stack.
                    let cmd = format!(
                        "am start -S --activity-clear-task -n {}/{}",
                        req.package_name, req.activity,
                    );
                    self.launch_and_idle(
                        &serial,
                        request_id,
                        &cmd,
                        req.wait_for_idle,
                        req.idle_timeout_ms,
                    )
                    .await
                }
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn open_deep_link(
        &self,
        request: Request<proto::OpenDeepLinkRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        if req.uri.is_empty() {
            return Err(Status::invalid_argument("uri is required"));
        }

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let serial = self.active_serial().await?;
                if self.is_active_ios_physical().await {
                    // Route through the XCUITest agent, which calls
                    // `XCUIApplication.open(url:)` on the target app.
                    // This triggers the app's scene URL handler the same
                    // way `simctl openurl` does on simulators — unlike
                    // `devicectl process launch --payload-url`, which
                    // launches the app but doesn't actually deliver the
                    // URL to the app's UIApplicationDelegate.
                    let bundle_id = self
                        .ios_agent_config
                        .read()
                        .await
                        .as_ref()
                        .map(|c| c.target_package.clone())
                        .filter(|p| !p.is_empty())
                        .ok_or_else(|| {
                            Status::failed_precondition(
                                "device.openDeepLink on a physical iOS device requires an \
                                 active agent session with a target package. Call \
                                 startAgent first.",
                            )
                        })?;
                    let command = AgentCommand::OpenDeepLink {
                        url: req.uri.clone(),
                        package: bundle_id,
                    };
                    let result = self.send_agent_command(&command).await;
                    return self.make_action_response(request_id, result).await;
                }
                match ios::device::open_url(&serial, &req.uri).await {
                    Ok(()) => Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: true,
                        error_type: String::new(),
                        error_message: String::new(),
                        screenshot: Vec::new(),
                    })),
                    Err(e) => Ok(self
                        .action_error(request_id, "ACTION_FAILED", e.to_string())
                        .await),
                }
            }
            Platform::Android => {
                if req.uri.contains('\'') {
                    return Err(Status::invalid_argument(
                        "uri contains an invalid character: single quote (') is not allowed",
                    ));
                }
                let cmd = format!("am start -a android.intent.action.VIEW -d '{}'", req.uri);
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_current_package(
        &self,
        request: Request<proto::GetCurrentPackageRequest>,
    ) -> Result<Response<proto::GetCurrentPackageResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        let package_name = match platform {
            Platform::Ios => {
                // On iOS, return the target package from agent config
                self.ios_agent_config
                    .read()
                    .await
                    .as_ref()
                    .map(|c| c.target_package.clone())
                    .unwrap_or_default()
            }
            Platform::Android => self
                .get_current_component()
                .await?
                .map(|(pkg, _)| pkg)
                .unwrap_or_default(),
        };

        Ok(Response::new(proto::GetCurrentPackageResponse {
            request_id,
            package_name,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_current_activity(
        &self,
        request: Request<proto::GetCurrentActivityRequest>,
    ) -> Result<Response<proto::GetCurrentActivityResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        let activity = match platform {
            Platform::Ios => {
                // Android-only concept — iOS doesn't have activities
                String::new()
            }
            Platform::Android => self
                .get_current_component()
                .await?
                .map(|(_, act)| act)
                .unwrap_or_default(),
        };

        Ok(Response::new(proto::GetCurrentActivityResponse {
            request_id,
            activity,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn restart_app(
        &self,
        request: Request<proto::RestartAppRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let idle_timeout_ms = if req.idle_timeout_ms > 0 {
                    req.idle_timeout_ms
                } else {
                    10000
                };

                if let Err(error_message) = self
                    .reset_ios_app(
                        &serial,
                        &req.package_name,
                        req.wait_for_idle,
                        idle_timeout_ms,
                    )
                    .await
                {
                    return Ok(self
                        .action_error(request_id, "LAUNCH_FAILED", error_message)
                        .await);
                }

                Ok(Self::success_action_response(request_id))
            }
            Platform::Android => {
                // Force-stop the app to kill the process and reset all in-memory state.
                if let Err(e) =
                    adb::shell(&serial, &format!("am force-stop {}", req.package_name)).await
                {
                    error!(error = %e, "Failed to force-stop app");
                    let screenshot = self.error_screenshot().await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "FORCE_STOP_FAILED".to_string(),
                        error_message: format!("Failed to stop app: {e}"),
                        screenshot,
                    }));
                }

                self.launch_package(
                    &serial,
                    request_id,
                    &req.package_name,
                    req.wait_for_idle,
                    req.idle_timeout_ms,
                )
                .await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn terminate_app(
        &self,
        request: Request<proto::TerminateAppRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                // Terminate through the XCUITest agent so the runner stays in
                // sync with app state. This prevents the cascading fallback
                // chain in reset_ios_app when the next test calls restartApp.
                // Fall back to simctl terminate if the agent is unreachable.
                let agent_result = self
                    .send_agent_command_with_timeout(
                        &AgentCommand::TerminateApp {
                            package: req.package_name.clone(),
                        },
                        4_000,
                    )
                    .await;

                // Fall back to simctl on transport error AND on agent-reported
                // failure (Ok(resp) where !resp.success). The agent can return
                // a structured failure (e.g. app already gone, XCUI error) that
                // would otherwise be silently swallowed. Physical devices have
                // no simctl fallback — if the agent fails, the app state is
                // indeterminate and we surface the error rather than pretending
                // it worked.
                let needs_fallback = match &agent_result {
                    Err(_) => true,
                    Ok(resp) => !resp.success,
                };
                if needs_fallback {
                    if self.is_active_ios_physical().await {
                        let msg = match &agent_result {
                            Err(status) => status.message().to_string(),
                            Ok(resp) => resp
                                .error
                                .clone()
                                .unwrap_or_else(|| "terminate_app agent path failed".to_string()),
                        };
                        return Ok(self.action_error(request_id, "TERMINATE_FAILED", msg).await);
                    }
                    let serial = self.active_serial().await?;
                    let _ = ios::device::terminate_app(&serial, &req.package_name).await;
                }

                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Platform::Android => {
                let cmd = format!("am force-stop {}", req.package_name);
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_app_state(
        &self,
        request: Request<proto::GetAppStateRequest>,
    ) -> Result<Response<proto::GetAppStateResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                // Route through the XCUITest agent which can query app state
                let command = AgentCommand::GetAppState {
                    package: req.package_name.clone(),
                };
                let result = self.send_agent_command(&command).await?;
                let state = result
                    .data
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stopped")
                    .to_string();
                Ok(Response::new(proto::GetAppStateResponse {
                    request_id,
                    state,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;

                // Check if app is installed
                let installed =
                    adb::shell_lenient(&serial, &format!("pm list packages {}", req.package_name))
                        .await
                        .map_err(|e| Status::internal(e.to_string()))?;

                if !installed.contains(&req.package_name) {
                    return Ok(Response::new(proto::GetAppStateResponse {
                        request_id,
                        state: "not_installed".to_string(),
                    }));
                }

                // Check if app process is running and in foreground
                let resumed = adb::shell_lenient(
                    &serial,
                    "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity'",
                )
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

                if resumed.contains(&req.package_name) {
                    return Ok(Response::new(proto::GetAppStateResponse {
                        request_id,
                        state: "foreground".to_string(),
                    }));
                }

                // Check if process exists at all
                let procs = adb::shell_lenient(&serial, &format!("pidof {}", req.package_name))
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;

                let state = if procs.trim().is_empty() {
                    "stopped"
                } else {
                    "background"
                };

                Ok(Response::new(proto::GetAppStateResponse {
                    request_id,
                    state: state.to_string(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn clear_app_data(
        &self,
        request: Request<proto::ClearAppDataRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Physical devices have no host-accessible app container
                    // filesystem, so `get_app_container` / `clear_container`
                    // are meaningless. Reinstall the app bundle as the only
                    // reliable way to wipe persistent state on a real device.
                    // Requires the app path to have been cached during
                    // StartAgent (via the StartAgentRequest.ios_app_path
                    // field). Without it we can't reinstall and must surface
                    // an actionable error.
                    let serial = self.active_serial().await?;
                    let app_path = self
                        .ios_agent_config
                        .read()
                        .await
                        .as_ref()
                        .and_then(|c| c.app_path.clone());
                    let Some(app_path) = app_path else {
                        return Ok(self
                            .action_error(
                                request_id,
                                "UNSUPPORTED_ON_PHYSICAL_DEVICE",
                                "device.clearAppData on a physical iOS device requires the \
                                 app bundle path to have been passed at startAgent time. \
                                 Pilot's CLI does this automatically when `app` is set in \
                                 your config. If you're calling startAgent manually, pass \
                                 the device-signed .app path via StartAgentRequest.ios_app_path."
                                    .to_string(),
                            )
                            .await);
                    };
                    // Uninstall + install is the only devicectl sequence
                    // that actually wipes the app's data container on
                    // physical iOS (plain `install` preserves the container
                    // when replacing an existing bundle). Uninstall also
                    // drops the bundle's LaunchServices URL-scheme entry,
                    // so we wait briefly after install for LaunchServices
                    // to re-index — without this, the first subsequent
                    // `openDeepLink` call drops silently.
                    if let Err(e) =
                        ios::device::uninstall_app_on_device(&serial, &req.package_name).await
                    {
                        warn!(error = %e, "Uninstall step of physical-iOS clearAppData failed, continuing to reinstall");
                    }
                    if let Err(e) = ios::device::install_app_on_device(&serial, &app_path).await {
                        return Ok(self
                            .action_error(
                                request_id,
                                "ACTION_FAILED",
                                format!("clearAppData reinstall failed: {e}"),
                            )
                            .await);
                    }
                    // Give LaunchServices time to re-index the bundle's URL
                    // schemes. Without this, the next `openDeepLink` often
                    // fires before iOS knows what app handles the scheme.
                    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: true,
                        error_type: String::new(),
                        error_message: String::new(),
                        screenshot: Vec::new(),
                    }));
                }
                let serial = self.active_serial().await?;
                // Clear the data container (AsyncStorage, UserDefaults, caches)
                // but do NOT terminate the app — launchApp handles that and
                // properly re-establishes the XCUITest accessibility bridge.
                // Clearing data while the app is running is fine because the
                // app will be relaunched anyway.
                match ios::device::get_app_container(&serial, &req.package_name).await {
                    Ok(ref container) => {
                        if let Err(e) = ios::device::clear_container(container).await {
                            warn!(error = %e, "Failed to clear app container, continuing anyway");
                        }
                    }
                    Err(e) => {
                        debug!(error = %e, "Could not get app container (app may not be installed)");
                    }
                }
                Ok(Response::new(proto::ActionResponse {
                    request_id,
                    success: true,
                    error_type: String::new(),
                    error_message: String::new(),
                    screenshot: Vec::new(),
                }))
            }
            Platform::Android => {
                let cmd = format!("pm clear {}", req.package_name);
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn grant_permission(
        &self,
        request: Request<proto::GrantPermissionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        // iOS uses service names: camera, photos, location, microphone, etc.
        self.platform_permission_action(request_id, &req.package_name, &req.permission, "grant")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn revoke_permission(
        &self,
        request: Request<proto::RevokePermissionRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        Self::validate_package_name(&req.package_name)?;

        self.platform_permission_action(request_id, &req.package_name, &req.permission, "revoke")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_clipboard(
        &self,
        request: Request<proto::SetClipboardRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let platform = self.require_platform().await?;

        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // simctl pbcopy is simulator-only. Physical devices go
                    // through the XCUITest agent, which calls
                    // `UIPasteboard.general.string = ...`. Writes don't
                    // trigger the iOS 16+ paste prompt — only reads do, and
                    // even then the runner bundle bypasses the dialog since
                    // it isn't a foreground app.
                    let command = AgentCommand::SetClipboard { text: req.text };
                    let result = self.send_agent_command(&command).await;
                    return self.make_action_response(request_id, result).await;
                }
                // Use simctl pbcopy to avoid the iOS 16+ paste permission dialog
                // that would crash the XCUITest agent if it accessed UIPasteboard.
                let serial = self.active_serial().await?;
                ios::device::set_clipboard(&serial, &req.text)
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                Ok(Self::success_action_response(request_id))
            }
            Platform::Android => {
                // Use the on-device agent for clipboard operations since it has
                // access to Android's ClipboardManager via the instrumentation context.
                let command = AgentCommand::SetClipboard { text: req.text };
                let result = self.send_agent_command(&command).await;
                self.make_action_response(request_id, result).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_clipboard(
        &self,
        request: Request<proto::GetClipboardRequest>,
    ) -> Result<Response<proto::GetClipboardResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let platform = self.require_platform().await?;

        let text = match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Route through the XCUITest agent — the runner bundle
                    // can call `UIPasteboard.general.string` without hitting
                    // the iOS 16+ paste prompt since it isn't a foreground
                    // app. On simulators we keep the simctl pbpaste path to
                    // match the existing behaviour (and avoid touching the
                    // agent at all when we don't need to).
                    let command = AgentCommand::GetClipboard {};
                    let result = self
                        .send_agent_command(&command)
                        .await
                        .map_err(|e| Status::internal(e.to_string()))?;
                    result
                        .data
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                } else {
                    // Use simctl pbpaste to avoid the iOS 16+ paste permission dialog
                    // that would crash the XCUITest agent if it accessed UIPasteboard.
                    let serial = self.active_serial().await?;
                    ios::device::get_clipboard(&serial)
                        .await
                        .map_err(|e| Status::internal(e.to_string()))?
                }
            }
            Platform::Android => {
                let command = AgentCommand::GetClipboard {};
                let result = self
                    .send_agent_command(&command)
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                result
                    .data
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            }
        };

        Ok(Response::new(proto::GetClipboardResponse {
            request_id,
            text,
        }))
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_orientation(
        &self,
        request: Request<proto::SetOrientationRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let command = AgentCommand::SetOrientation {
                    orientation: req.orientation.clone(),
                };
                let result = self.send_agent_command(&command).await;
                self.make_action_response(request_id, result).await
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let rotation = match req.orientation.as_str() {
                    "portrait" => "0",
                    "landscape" => "1",
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "orientation must be 'portrait' or 'landscape', got '{other}'"
                        )));
                    }
                };
                if let Err(e) =
                    adb::shell(&serial, "settings put system accelerometer_rotation 0").await
                {
                    error!(error = %e, "Failed to disable auto-rotate");
                }
                let cmd = format!("settings put system user_rotation {rotation}");
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_orientation(
        &self,
        request: Request<proto::GetOrientationRequest>,
    ) -> Result<Response<proto::GetOrientationResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let command = AgentCommand::GetOrientation {};
                let result = self.send_agent_command(&command).await?;
                let orientation = result
                    .data
                    .get("orientation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("portrait")
                    .to_string();
                Ok(Response::new(proto::GetOrientationResponse {
                    request_id,
                    orientation,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let output = adb::shell(&serial, "settings get system user_rotation")
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                let orientation = match output.trim() {
                    "1" | "3" => "landscape",
                    _ => "portrait",
                };
                Ok(Response::new(proto::GetOrientationResponse {
                    request_id,
                    orientation: orientation.to_string(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn is_keyboard_shown(
        &self,
        request: Request<proto::IsKeyboardShownRequest>,
    ) -> Result<Response<proto::IsKeyboardShownResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                let command = AgentCommand::IsKeyboardShown {};
                let result = self.send_agent_command(&command).await?;
                let shown = result
                    .data
                    .get("shown")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                Ok(Response::new(proto::IsKeyboardShownResponse {
                    request_id,
                    shown,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let output = adb::shell_lenient(&serial, "dumpsys input_method | grep mInputShown")
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                let shown = output.contains("mInputShown=true");
                Ok(Response::new(proto::IsKeyboardShownResponse {
                    request_id,
                    shown,
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn hide_keyboard(
        &self,
        request: Request<proto::HideKeyboardRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        self.ios_agent_or_android_adb(
            request_id,
            &AgentCommand::HideKeyboard {},
            "input keyevent KEYCODE_ESCAPE",
        )
        .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn open_notifications(
        &self,
        request: Request<proto::OpenNotificationsRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // iOS has no notification shade — success no-op
        self.ios_noop_or_android_adb(request_id, "cmd statusbar expand-notifications")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn open_quick_settings(
        &self,
        request: Request<proto::OpenQuickSettingsRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // iOS has no quick settings — success no-op
        self.ios_noop_or_android_adb(request_id, "cmd statusbar expand-settings")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn set_color_scheme(
        &self,
        request: Request<proto::SetColorSchemeRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                match req.scheme.as_str() {
                    "dark" | "light" => {}
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "scheme must be 'dark' or 'light', got '{other}'"
                        )));
                    }
                }
                if self.is_active_ios_physical().await {
                    // `xcrun simctl ui appearance` is simulator-only. Physical
                    // devices require the user to toggle light/dark mode in
                    // Settings; there is no programmatic path.
                    return Ok(self
                        .action_error(
                            request_id,
                            "UNSUPPORTED_ON_PHYSICAL_DEVICE",
                            "device.setColorScheme is not supported on physical iOS devices. \
                             Workaround: set the system appearance on the device manually \
                             (Settings → Display & Brightness) before running the test."
                                .to_string(),
                        )
                        .await);
                }
                let serial = self.active_serial().await?;
                match ios::device::set_appearance(&serial, &req.scheme).await {
                    Ok(()) => Ok(Self::success_action_response(request_id)),
                    Err(e) => Ok(self
                        .action_error(request_id, "ACTION_FAILED", e.to_string())
                        .await),
                }
            }
            Platform::Android => {
                let mode = match req.scheme.as_str() {
                    "dark" => "yes",
                    "light" => "no",
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "scheme must be 'dark' or 'light', got '{other}'"
                        )));
                    }
                };
                let cmd = format!("cmd uimode night {mode}");
                self.adb_action(request_id, &cmd).await
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn get_color_scheme(
        &self,
        request: Request<proto::GetColorSchemeRequest>,
    ) -> Result<Response<proto::GetColorSchemeResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                // Route through agent — it can read UITraitCollection.current
                let command = AgentCommand::GetColorScheme {};
                let result = self.send_agent_command(&command).await?;
                let scheme = result
                    .data
                    .get("scheme")
                    .and_then(|v| v.as_str())
                    .unwrap_or("light")
                    .to_string();
                Ok(Response::new(proto::GetColorSchemeResponse {
                    request_id,
                    scheme,
                }))
            }
            Platform::Android => {
                let serial = self.active_serial().await?;
                let output = adb::shell_lenient(&serial, "cmd uimode night")
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?;
                let scheme = if output.contains("Night mode: yes") {
                    "dark"
                } else {
                    "light"
                };
                Ok(Response::new(proto::GetColorSchemeResponse {
                    request_id,
                    scheme: scheme.to_string(),
                }))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn wake_device(
        &self,
        request: Request<proto::WakeDeviceRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        // iOS simulator is always awake
        self.ios_noop_or_android_adb(request_id, "input keyevent KEYCODE_WAKEUP")
            .await
    }

    #[instrument(skip_all, fields(request_id))]
    async fn unlock_device(
        &self,
        request: Request<proto::UnlockDeviceRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let platform = self.require_platform().await?;
        match platform {
            // iOS simulator has no lock screen
            Platform::Ios => Ok(Self::success_action_response(request_id)),
            Platform::Android => {
                let serial = self.active_serial().await?;
                // Wake the screen first
                let _ = adb::shell_lenient(&serial, "input keyevent KEYCODE_WAKEUP").await;
                tokio::time::sleep(Duration::from_millis(500)).await;
                // Dismiss non-secure lock screen (KEYCODE_MENU)
                let _ = adb::shell_lenient(&serial, "input keyevent 82").await;
                tokio::time::sleep(Duration::from_millis(500)).await;
                // Swipe up as fallback for swipe-to-unlock screens
                let _ = adb::shell_lenient(&serial, "input swipe 540 1800 540 800 300").await;
                Ok(Self::success_action_response(request_id))
            }
        }
    }

    // ─── Network Capture (PILOT-164) ───

    async fn start_network_capture(
        &self,
        request: Request<proto::StartNetworkCaptureRequest>,
    ) -> Result<Response<proto::StartNetworkCaptureResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let mut proxy_guard = self.network_proxy.write().await;
        // If a proxy is already running (pre-started for physical iOS OCSP
        // passthrough during start_agent), reuse it instead of erroring.
        // Capture state is reset so this session starts clean.
        if let Some(existing) = proxy_guard.as_ref() {
            let existing_port = existing.port();
            existing.reset_entries().await;
            let serial = self.active_serial().await.unwrap_or_default();
            info!(
                serial = %serial,
                port = existing_port,
                "Reusing pre-started proxy for network capture"
            );
            return Ok(Response::new(proto::StartNetworkCaptureResponse {
                request_id,
                success: true,
                proxy_port: u32::from(existing_port),
                error_message: String::new(),
            }));
        }

        // Load or create the MITM CA for HTTPS interception
        let mitm_ca = Arc::new(
            MitmAuthority::load_or_create()
                .map_err(|e| Status::internal(format!("Failed to create MITM CA: {e}")))?,
        );

        let serial = self.active_serial().await?;
        let platform = self.require_platform().await?;
        let ca_pem_path = mitm_ca.ca_pem_path().to_string_lossy().to_string();
        let mut warning: Option<String> = None;

        let is_ios_physical = self.is_active_ios_physical().await;

        match platform {
            Platform::Ios if !is_ios_physical => {
                // Simulator path — install CA into the simulator's trust store.
                if let Err(e) = ios::device::install_ca_cert(&serial, &ca_pem_path).await {
                    let msg = format!(
                        "Failed to install CA cert on simulator: {e} — HTTPS traffic will not be captured"
                    );
                    error!("{msg}");
                    warning = Some(msg);
                }
            }
            Platform::Ios => {
                // Physical device path (PILOT-185) — the CA is trusted via the
                // mobileconfig the user installed on the device, so there's
                // nothing to install from the host. We just verify the
                // mobileconfig exists and warn loudly if it's missing, since
                // without it the device has no route into our proxy and no
                // trust for our CA.
                #[cfg(target_os = "macos")]
                {
                    if !ios::physical_device_proxy::mobileconfig_exists(&serial).await {
                        return Ok(Response::new(proto::StartNetworkCaptureResponse {
                            request_id,
                            success: false,
                            proxy_port: 0,
                            error_message: format!(
                                "No Pilot network profile found for device {serial}. \
                                 Run `pilot configure-ios-network {serial}` first, then \
                                 install the generated .mobileconfig on the device."
                            ),
                        }));
                    }
                    // Warn if the host's Wi-Fi IP has drifted from what the
                    // mobileconfig was generated against.
                    if let Ok(Some(meta)) =
                        ios::physical_device_proxy::read_mobileconfig_meta(&serial).await
                    {
                        if let Ok(current_ip) =
                            ios::physical_device_proxy::resolve_host_wifi_ip().await
                        {
                            if ios::physical_device_proxy::is_mobileconfig_stale(&meta, current_ip)
                                .await
                            {
                                let msg = format!(
                                    "Host Wi-Fi IP changed since mobileconfig was generated ({} → {}). \
                                     Run `pilot refresh-ios-network {serial}` and reinstall the profile.",
                                    meta.host_ip, current_ip
                                );
                                warn!("{msg}");
                                warning = Some(msg);
                            }
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: "Physical iOS network capture requires macOS".to_string(),
                    }));
                }
            }
            Platform::Android => {
                // Install the CA cert on the Android device (best-effort — may fail on non-rooted devices)
                let cert_filename = mitm_ca.device_cert_filename().map_err(|e| {
                    Status::internal(format!("Failed to compute CA cert hash: {e}"))
                })?;
                let device_cert_path = adb::device_ca_cert_path(&cert_filename);
                if let Err(e) = adb::install_ca_cert(&serial, &ca_pem_path, &cert_filename).await {
                    let msg = format!(
                        "Failed to install CA cert on device: {e} — HTTPS traffic will not be captured"
                    );
                    error!("{msg}");
                    warning = Some(msg);
                }
                *self.proxy_ca_cert_path.write().await = Some(device_cert_path);
            }
        }

        // Pick the proxy bind address based on device type. Simulators and
        // Android both want loopback (they reach the proxy via transparent
        // redirection or adb reverse). Physical iOS devices need a LAN-
        // reachable listener on a deterministic per-UDID port so their
        // installed mobileconfig can route traffic here.
        let proxy = if is_ios_physical {
            #[cfg(target_os = "macos")]
            {
                let port = ios::physical_device_proxy::deterministic_port(&serial);
                let bind = std::net::SocketAddr::new(
                    std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                    port,
                );
                NetworkProxy::start_on(Arc::clone(&mitm_ca), bind)
                    .await
                    .map_err(|e| {
                        Status::internal(format!("Failed to start proxy on {bind}: {e}"))
                    })?
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Ok(Response::new(proto::StartNetworkCaptureResponse {
                    request_id,
                    success: false,
                    proxy_port: 0,
                    error_message: "Physical iOS network capture requires macOS".to_string(),
                }));
            }
        } else {
            NetworkProxy::start(Arc::clone(&mitm_ca))
                .await
                .map_err(|e| Status::internal(format!("Failed to start proxy: {e}")))?
        };
        let host_port = proxy.port();

        // Physical iOS: verify the proxy is reachable from the LAN. On
        // modern macOS the Application Firewall's stealth mode silently
        // drops inbound TCP SYNs to user processes, even when the binary
        // is explicitly allowed in the firewall list. The symptom is the
        // device never reaches the proxy — traffic capture silently
        // returns 0 entries and users spend an hour debugging SSID /
        // profile install / Wi-Fi before finding the real cause.
        //
        // Check by connecting to our own LAN IP on the proxy port. If
        // that times out, the firewall (or similar) is blocking and we
        // return a clear error with the exact socketfilterfw fix.
        #[cfg(target_os = "macos")]
        if is_ios_physical {
            if let Ok(lan_ip) = ios::physical_device_proxy::resolve_host_wifi_ip().await {
                let reachable = self_probe_lan_listener(lan_ip, host_port).await;
                if !reachable {
                    // Drop the proxy — otherwise the next start_network_capture
                    // call will fail with "already running".
                    drop(proxy);
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: format!(
                            "Pilot proxy is bound to {lan_ip}:{host_port} but inbound LAN \
                             connections are being blocked — the iPhone will never reach it.\n\n\
                             Most likely cause: macOS Application Firewall stealth mode is \
                             silently dropping unsolicited inbound TCP SYNs, even for \
                             allow-listed binaries. Disable it with:\n  \
                             sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off\n\n\
                             Or disable the firewall entirely for this session:\n  \
                             sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off"
                        ),
                    }));
                }
            }
        }

        match platform {
            Platform::Ios if !is_ios_physical => {
                // PILOT-182: route the simulator's traffic into the MITM
                // proxy via the macOS Network Extension redirector instead
                // of a global system proxy. Per-PID filtering gives each
                // worker daemon full isolation from other concurrent
                // workers (and from the user's host traffic).
                //
                // If the redirector fails to start (SE not approved, brew
                // missing, launcher binary unreachable, …), there is NO
                // path for traffic to reach the proxy — capture is
                // effectively dead. Early-return `success: false` so the
                // runner prints "Network capture disabled" instead of the
                // misleading "warning". The local `proxy` is dropped at
                // end of scope, releasing the TCP listener.
                #[cfg(target_os = "macos")]
                {
                    match crate::ios_redirect::IosRedirect::start(
                        serial.clone(),
                        proxy.state_handle(),
                        Arc::clone(&mitm_ca),
                    )
                    .await
                    {
                        Ok(redirect) => {
                            *self.ios_redirect.write().await = Some(redirect);
                            info!(
                                %serial, host_port,
                                "iOS redirector session established"
                            );
                        }
                        Err(e) => {
                            let msg =
                                format!("Failed to start iOS Network Extension redirector: {e}");
                            error!("{msg}");
                            return Ok(Response::new(proto::StartNetworkCaptureResponse {
                                request_id,
                                success: false,
                                proxy_port: 0,
                                error_message: msg,
                            }));
                        }
                    }
                }
                #[cfg(not(target_os = "macos"))]
                {
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message: "iOS network capture requires macOS".to_string(),
                    }));
                }
            }
            Platform::Ios => {
                // PILOT-185 physical-device path — the device already has the
                // mobileconfig installed, so its outbound HTTP traffic is
                // directed at us via the standard HTTP proxy protocol. The
                // existing `handle_connection` path inside NetworkProxy
                // transparently handles CONNECT / GET-with-absolute-URL
                // requests from the device, so no redirector is needed.
                info!(
                    %serial,
                    host_port,
                    "Physical iOS proxy listening for device HTTP_PROXY traffic"
                );
            }
            Platform::Android => {
                // Use `adb reverse` to make the proxy reachable as 127.0.0.1:{port} on
                // the device. More reliable than `settings put global http_proxy`
                // with 10.0.2.2 because it works at the ADB transport level.
                let device_port = host_port;
                if let Err(e) = adb::reverse_port(&serial, device_port, host_port).await {
                    error!("Failed to set up adb reverse: {e}");
                }

                let proxy_setting = format!("127.0.0.1:{device_port}");
                info!(%serial, %proxy_setting, host_port, "Configuring device HTTP proxy via adb reverse");

                if let Err(e) = adb::shell(
                    &serial,
                    &format!("settings put global http_proxy {proxy_setting}"),
                )
                .await
                {
                    error!("Failed to set device proxy: {e}");
                }
                *self.proxy_reverse_port.write().await = Some(device_port);
            }
        }

        *proxy_guard = Some(proxy);

        // If a NetworkRoute stream is active, install its handler on the
        // newly created proxy so route interception works regardless of
        // whether the stream opened before or after capture started.
        if let Some(handler) = self.active_route_handler.read().await.as_ref() {
            if let Some(p) = proxy_guard.as_ref() {
                p.set_handler(Arc::clone(handler) as Arc<dyn crate::network_proxy::NetworkHandler>)
                    .await;
            }
        }

        *self.proxy_device_serial.write().await = Some(serial);
        *self.proxy_platform.write().await = Some(platform);

        Ok(Response::new(proto::StartNetworkCaptureResponse {
            request_id,
            success: true,
            proxy_port: host_port as u32,
            error_message: warning.unwrap_or_default(),
        }))
    }

    async fn stop_network_capture(
        &self,
        request: Request<proto::StopNetworkCaptureRequest>,
    ) -> Result<Response<proto::StopNetworkCaptureResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        let proxy = self.network_proxy.write().await.take();
        let Some(proxy) = proxy else {
            return Ok(Response::new(proto::StopNetworkCaptureResponse {
                request_id,
                success: false,
                entries: Vec::new(),
                error_message: "Network capture is not running".to_string(),
            }));
        };

        // Revert proxy settings based on platform
        let serial = self.proxy_device_serial.write().await.take();
        let platform = self.proxy_platform.write().await.take();
        let reverse_port = self.proxy_reverse_port.write().await.take();
        let ca_cert_path = self.proxy_ca_cert_path.write().await.take();
        if let Some(serial) = &serial {
            match platform {
                Some(Platform::Ios) => {
                    // PILOT-182 simulators: drop the redirector session handle
                    // BEFORE `proxy.stop()`. Drop closes the control channel,
                    // which tells the SE to remove this worker's per-PID
                    // filter; the accept + refresh tasks abort and the Unix
                    // socket file is unlinked. No host state lingers.
                    //
                    // PILOT-185 physical devices: the ios_redirect slot is
                    // always None on that path, so the take() below is a
                    // no-op — the device's own HTTP proxy setting (installed
                    // via mobileconfig) is the routing mechanism and it
                    // persists across runs by design.
                    #[cfg(target_os = "macos")]
                    {
                        if let Some(redirect) = self.ios_redirect.write().await.take() {
                            drop(redirect);
                            debug!(%serial, "iOS redirector session torn down");
                        }
                    }
                    info!(%serial, "iOS proxy stopped");
                }
                _ => {
                    info!(%serial, "Reverting Android device HTTP proxy");
                    if let Err(e) = adb::shell(serial, "settings put global http_proxy :0").await {
                        warn!(%serial, "Failed to reset http_proxy: {e}");
                    }
                    if let Some(port) = reverse_port {
                        if let Err(e) = adb::remove_reverse(serial, port).await {
                            warn!(%serial, port, "Failed to remove reverse port forward: {e}");
                        }
                    }
                    if let Some(cert_path) = &ca_cert_path {
                        if let Err(e) = adb::shell(serial, &format!("rm -f {cert_path}")).await {
                            warn!(%serial, "Failed to remove CA cert: {e}");
                        }
                    }
                }
            }
        }

        let captured = proxy.stop().await;
        let entries: Vec<proto::CapturedNetworkEntry> = captured
            .into_iter()
            .map(|e| proto::CapturedNetworkEntry {
                method: e.method,
                url: e.url,
                status_code: e.status_code,
                content_type: e.content_type,
                request_size: e.request_size,
                response_size: e.response_size,
                start_time_ms: e.start_time_ms,
                duration_ms: e.duration_ms,
                request_headers_json: crate::network_proxy::headers_to_json_object(
                    &e.request_headers,
                )
                .to_string(),
                response_headers_json: crate::network_proxy::headers_to_json_object(
                    &e.response_headers,
                )
                .to_string(),
                request_body: e.request_body,
                response_body: e.response_body,
                is_https: e.is_https,
                route_action: e.route_action,
            })
            .collect();

        Ok(Response::new(proto::StopNetworkCaptureResponse {
            request_id,
            success: true,
            entries,
            error_message: String::new(),
        }))
    }

    // ─── Physical iOS network profile (PILOT-185) ───

    async fn generate_ios_network_profile(
        &self,
        request: Request<proto::GenerateIosNetworkProfileRequest>,
    ) -> Result<Response<proto::GenerateIosNetworkProfileResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);

        #[cfg(not(target_os = "macos"))]
        {
            return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                request_id,
                success: false,
                error_message: "Physical iOS network profile generation is macOS-only".to_string(),
                profile_path: String::new(),
                host_ip: String::new(),
                port: 0,
                ssid: String::new(),
            }));
        }

        #[cfg(target_os = "macos")]
        {
            if req.udid.is_empty() {
                return Err(Status::invalid_argument("udid is required"));
            }

            // Look up the device to confirm it's a physical iOS device we know
            // about AND grab its human-readable name for the payload label.
            let physical_devices = match ios::device::list_physical_devices().await {
                Ok(list) => list,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to list physical iOS devices: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };
            let Some(device) = physical_devices.iter().find(|d| d.udid == req.udid) else {
                return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                    request_id,
                    success: false,
                    error_message: format!(
                        "No physical iOS device with UDID '{}' is connected. \
                         Plug the device in and re-run.",
                        req.udid
                    ),
                    profile_path: String::new(),
                    host_ip: String::new(),
                    port: 0,
                    ssid: String::new(),
                }));
            };

            let host_ip = match ios::physical_device_proxy::resolve_host_wifi_ip().await {
                Ok(ip) => ip,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to resolve host Wi-Fi IP: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };

            let ssid = if req.ssid.is_empty() {
                match ios::physical_device_proxy::current_wifi_ssid().await {
                    Some(s) => s,
                    None => {
                        return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                            request_id,
                            success: false,
                            error_message:
                                "Could not auto-detect the host's current Wi-Fi SSID.\n\n\
                                 macOS 14+ redacts SSIDs from `ipconfig getsummary` output \
                                 unless the calling process has Location Services permission, \
                                 and `networksetup -getairportnetwork` has been broken since \
                                 Apple removed the `airport` private framework.\n\n\
                                 Fix: pass the SSID explicitly. Example:\n  \
                                 pilot configure-ios-network <udid> --ssid \"MyWiFiNetwork\""
                                    .to_string(),
                            profile_path: String::new(),
                            host_ip: String::new(),
                            port: 0,
                            ssid: String::new(),
                        }));
                    }
                }
            } else {
                req.ssid.clone()
            };

            let port = ios::physical_device_proxy::deterministic_port(&req.udid);
            let device_name = if req.device_name.is_empty() {
                device.name.clone()
            } else {
                req.device_name.clone()
            };

            let mitm_ca = match MitmAuthority::load_or_create() {
                Ok(ca) => ca,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to load Pilot MITM CA: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };
            let ca_pem = match tokio::fs::read_to_string(mitm_ca.ca_pem_path()).await {
                Ok(s) => s,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!(
                            "Failed to read Pilot CA from {:?}: {e}",
                            mitm_ca.ca_pem_path()
                        ),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };

            let inputs = ios::physical_device_proxy::MobileconfigInputs {
                udid: req.udid.clone(),
                device_name,
                ssid: ssid.clone(),
                host_ip,
                port,
                ca_pem,
            };

            let bytes = match ios::physical_device_proxy::generate_mobileconfig(&inputs) {
                Ok(b) => b,
                Err(e) => {
                    return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                        request_id,
                        success: false,
                        error_message: format!("Failed to generate mobileconfig: {e}"),
                        profile_path: String::new(),
                        host_ip: String::new(),
                        port: 0,
                        ssid: String::new(),
                    }));
                }
            };

            let profile_path =
                match ios::physical_device_proxy::write_mobileconfig(&inputs, &bytes).await {
                    Ok(path) => path,
                    Err(e) => {
                        return Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                            request_id,
                            success: false,
                            error_message: format!("Failed to write mobileconfig: {e}"),
                            profile_path: String::new(),
                            host_ip: String::new(),
                            port: 0,
                            ssid: String::new(),
                        }));
                    }
                };

            Ok(Response::new(proto::GenerateIosNetworkProfileResponse {
                request_id,
                success: true,
                error_message: String::new(),
                profile_path: profile_path.to_string_lossy().to_string(),
                host_ip: host_ip.to_string(),
                port: u32::from(port),
                ssid,
            }))
        }
    }

    async fn get_logcat(
        &self,
        request: Request<proto::GetLogcatRequest>,
    ) -> Result<Response<proto::GetLogcatResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        // Fetch logcat with epoch timestamps for reliable filtering
        let output = match adb::shell_lenient(&serial, "logcat -d -v epoch").await {
            Ok(output) => output,
            Err(e) => {
                return Ok(Response::new(proto::GetLogcatResponse {
                    request_id,
                    logcat: String::new(),
                    error_message: format!("Failed to get logcat: {e}"),
                }));
            }
        };

        // Filter by timestamp and package in Rust for cross-device consistency.
        // Logcat `-v epoch` format: "<epoch_secs>.<fractional>  <pid> ..."
        let since_ms = req.since_ms;
        let until_ms = if req.until_ms > 0 {
            req.until_ms
        } else {
            u64::MAX
        };
        let package_name = req.package_name;

        // If package_name is set, resolve its PID(s) for filtering
        let pids: Vec<String> = if !package_name.is_empty() {
            let pid_output = adb::shell_lenient(&serial, &format!("pidof {package_name}"))
                .await
                .unwrap_or_default();
            pid_output.split_whitespace().map(String::from).collect()
        } else {
            Vec::new()
        };

        let need_filter = since_ms > 0 || until_ms < u64::MAX || !pids.is_empty();

        let logcat = if need_filter {
            let since_secs = since_ms as f64 / 1000.0;
            let until_secs = until_ms as f64 / 1000.0;

            output
                .lines()
                .filter(|line| {
                    // Parse epoch timestamp from the beginning of the line
                    let ts_ok = if since_ms > 0 || until_ms < u64::MAX {
                        // Epoch format: "1234567890.123  <pid> ..."
                        line.split_whitespace()
                            .next()
                            .and_then(|ts| ts.parse::<f64>().ok())
                            .map(|ts| ts >= since_secs && ts <= until_secs)
                            .unwrap_or(true) // keep non-parseable lines (e.g. headers)
                    } else {
                        true
                    };

                    let pid_ok = if !pids.is_empty() {
                        // PID is the second whitespace-delimited field in epoch format
                        line.split_whitespace()
                            .nth(1)
                            .map(|pid_field| pids.iter().any(|p| p == pid_field))
                            .unwrap_or(false)
                    } else {
                        true
                    };

                    ts_ok && pid_ok
                })
                .collect::<Vec<&str>>()
                .join("\n")
        } else {
            output
        };

        Ok(Response::new(proto::GetLogcatResponse {
            request_id,
            logcat,
            error_message: String::new(),
        }))
    }

    // ─── App State Snapshot (PILOT-115) ───

    #[instrument(skip_all, fields(request_id))]
    async fn save_app_state(
        &self,
        request: Request<proto::SaveAppStateRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        Self::validate_package_name(&req.package_name)?;
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path is required"));
        }

        let pkg = &req.package_name;
        let local_path = &req.path;

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Physical devices: use `xcrun devicectl device copy from
                    // --domain-type appDataContainer` to pull the app's data
                    // container to a scratch directory, then tar it for
                    // parity with the simulator output shape.
                    let scratch = tempfile::tempdir()
                        .map_err(|e| Status::internal(format!("tempdir: {e}")))?;
                    let scratch_path = scratch.path().to_string_lossy().to_string();
                    if let Err(e) =
                        ios::device::copy_app_container_from_device(&serial, pkg, &scratch_path)
                            .await
                    {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("devicectl copy from failed: {e}"),
                            )
                            .await);
                    }
                    let output = tokio::process::Command::new("tar")
                        .args(["czf", local_path, "-C", &scratch_path, "."])
                        .output()
                        .await;
                    return match output {
                        Ok(out) if out.status.success() => {
                            info!(%pkg, %local_path, "iOS physical app state saved");
                            Ok(Self::success_action_response(request_id))
                        }
                        Ok(out) => {
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_SAVE_FAILED",
                                    format!("tar failed: {stderr}"),
                                )
                                .await)
                        }
                        Err(e) => Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("Failed to run tar: {e}"),
                            )
                            .await),
                    };
                }
                // iOS simulator: app container is on the host filesystem.
                // Use simctl to find it, then tar it directly.
                let container = match ios::device::get_app_container(&serial, pkg).await {
                    Ok(path) => path,
                    Err(e) => {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("Failed to locate app container: {e}"),
                            )
                            .await);
                    }
                };

                // Terminate the app to flush data
                let _ = ios::device::terminate_app(&serial, pkg).await;

                // Create tar.gz archive of the data container
                let output = tokio::process::Command::new("tar")
                    .args(["czf", local_path, "-C", &container, "."])
                    .output()
                    .await;

                match output {
                    Ok(out) if out.status.success() => {
                        info!(%pkg, %local_path, "iOS app state saved");
                        Ok(Self::success_action_response(request_id))
                    }
                    Ok(out) => {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_SAVE_FAILED",
                                format!("tar failed: {stderr}"),
                            )
                            .await)
                    }
                    Err(e) => Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_SAVE_FAILED",
                            format!("Failed to run tar: {e}"),
                        )
                        .await),
                }
            }
            Platform::Android => {
                let device_tmp =
                    format!("/data/local/tmp/pilot-app-state-{}.tar.gz", Uuid::new_v4());
                let data_dir = format!("/data/data/{pkg}");
                let tar_timeout = Duration::from_secs(300);

                // 1. Force-stop the app to avoid data corruption
                if let Err(e) = adb::shell(&serial, &format!("am force-stop {pkg}")).await {
                    warn!(%pkg, "Failed to force-stop app before save: {e}");
                }

                // 2. Determine access strategy: root or run-as
                let is_root = adb::shell_lenient(&serial, "id")
                    .await
                    .map(|out| out.contains("uid=0"))
                    .unwrap_or(false);

                // 3. Create tar.gz archive on device
                let tar_result = if is_root {
                    adb::shell_with_timeout(
                        &serial,
                        &format!("tar czf {device_tmp} -C {data_dir} ."),
                        tar_timeout,
                    )
                    .await
                } else {
                    adb::shell_with_timeout(
                        &serial,
                        &format!("run-as {pkg} tar czf {device_tmp} -C {data_dir} ."),
                        tar_timeout,
                    )
                    .await
                };

                if let Err(e) = tar_result {
                    let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                    return Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_SAVE_FAILED",
                            format!("Failed to archive app data: {e}"),
                        )
                        .await);
                }

                // 4. Pull archive to host
                if let Err(e) = adb::pull_file(&serial, &device_tmp, local_path).await {
                    let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                    return Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_SAVE_FAILED",
                            format!("Failed to pull app state archive: {e}"),
                        )
                        .await);
                }

                // 5. Clean up temp file on device
                let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;

                info!(%pkg, %local_path, "App state saved");
                Ok(Self::success_action_response(request_id))
            }
        }
    }

    #[instrument(skip_all, fields(request_id))]
    async fn restore_app_state(
        &self,
        request: Request<proto::RestoreAppStateRequest>,
    ) -> Result<Response<proto::ActionResponse>, Status> {
        let req = request.into_inner();
        let request_id = Self::request_id(&req.request_id);
        let serial = self.active_serial().await?;

        Self::validate_package_name(&req.package_name)?;
        if req.path.is_empty() {
            return Err(Status::invalid_argument("path is required"));
        }

        let pkg = &req.package_name;
        let local_path = &req.path;

        // Verify local archive exists
        if !std::path::Path::new(local_path).exists() {
            return Err(Status::invalid_argument(format!(
                "App state archive not found: {local_path}"
            )));
        }

        let platform = self.require_platform().await?;
        match platform {
            Platform::Ios => {
                if self.is_active_ios_physical().await {
                    // Physical: extract the archive locally, then push each
                    // top-level child (`Documents`, `Library`, `tmp`) back
                    // into the app container via `devicectl device copy to
                    // --remove-existing-content true`. We terminate the app
                    // first so iOS isn't actively writing to the directories
                    // we're overwriting.
                    let scratch = tempfile::tempdir()
                        .map_err(|e| Status::internal(format!("tempdir: {e}")))?;
                    let scratch_path = scratch.path().to_string_lossy().to_string();
                    let extract = tokio::process::Command::new("tar")
                        .args(["xzf", local_path, "-C", &scratch_path])
                        .output()
                        .await;
                    match extract {
                        Ok(out) if !out.status.success() => {
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            return Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_RESTORE_FAILED",
                                    format!("tar extract failed: {stderr}"),
                                )
                                .await);
                        }
                        Err(e) => {
                            return Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_RESTORE_FAILED",
                                    format!("Failed to run tar: {e}"),
                                )
                                .await);
                        }
                        _ => {}
                    }
                    // Collect top-level children that actually exist in the
                    // archive — we only want to push directories the user
                    // actually saved, so empty runs don't wipe the live data.
                    let mut sources: Vec<String> = Vec::new();
                    for name in ["Documents", "Library", "tmp"] {
                        let candidate = std::path::Path::new(&scratch_path).join(name);
                        if candidate.exists() {
                            sources.push(candidate.to_string_lossy().to_string());
                        }
                    }
                    if sources.is_empty() {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                "Archive contained no Documents/Library/tmp directories"
                                    .to_string(),
                            )
                            .await);
                    }
                    // Wipe the container by uninstalling + reinstalling the
                    // app. `devicectl copy to --remove-existing-content`
                    // alone would leave the app running and racing with
                    // our writes; wiping via reinstall is the same pattern
                    // we use for `clearAppData` and avoids every possible
                    // "process is holding files" edge case. After the
                    // reinstall the container is empty, so the subsequent
                    // copy just lays the saved state on top.
                    let app_path = self
                        .ios_agent_config
                        .read()
                        .await
                        .as_ref()
                        .and_then(|c| c.app_path.clone());
                    let Some(app_path) = app_path else {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                "device.restoreAppState on a physical iOS device requires \
                                 the app bundle path cached at startAgent time. Pilot's \
                                 CLI passes this automatically when `app` is set."
                                    .to_string(),
                            )
                            .await);
                    };
                    if let Err(e) = ios::device::uninstall_app_on_device(&serial, pkg).await {
                        warn!(error = %e, "Pre-restore uninstall failed, continuing");
                    }
                    if let Err(e) = ios::device::install_app_on_device(&serial, &app_path).await {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Pre-restore reinstall failed: {e}"),
                            )
                            .await);
                    }
                    // Give LaunchServices a moment to re-register the
                    // freshly installed bundle before devicectl re-enters
                    // its sandbox to push the container contents.
                    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                    if let Err(e) =
                        ios::device::copy_app_container_to_device(&serial, pkg, &sources).await
                    {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("devicectl copy to failed: {e}"),
                            )
                            .await);
                    }
                    info!(%pkg, %local_path, "iOS physical app state restored");
                    // Reinstalling + pushing the container replaces the app
                    // bundle under the running XCUITest runner. The agent's
                    // cached XCUIApplication references become stale in a
                    // way that causes snapshots to return partial trees
                    // after the next launch — elements present in the
                    // hierarchy dump are missing from findElement. Restart
                    // the agent entirely so the new test session starts
                    // against fresh XCUITest bindings.
                    if let Err(e) = self
                        .restart_ios_agent_for_app(&serial, pkg, false, 10_000)
                        .await
                    {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Agent restart after restore failed: {e}"),
                            )
                            .await);
                    }
                    return Ok(Self::success_action_response(request_id));
                }
                // iOS simulator: extract archive directly into the app container
                let container = match ios::device::get_app_container(&serial, pkg).await {
                    Ok(path) => path,
                    Err(e) => {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Failed to locate app container: {e}"),
                            )
                            .await);
                    }
                };

                // Terminate the app before restoring
                let _ = ios::device::terminate_app(&serial, pkg).await;

                // Extract archive into the data container
                let output = tokio::process::Command::new("tar")
                    .args(["xzf", local_path, "-C", &container])
                    .output()
                    .await;

                match output {
                    Ok(out) if out.status.success() => {
                        info!(%pkg, %local_path, "iOS app state restored");
                        Ok(Self::success_action_response(request_id))
                    }
                    Ok(out) => {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("tar extract failed: {stderr}"),
                            )
                            .await)
                    }
                    Err(e) => Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_RESTORE_FAILED",
                            format!("Failed to run tar: {e}"),
                        )
                        .await),
                }
            }
            Platform::Android => {
                let device_tmp =
                    format!("/data/local/tmp/pilot-app-state-{}.tar.gz", Uuid::new_v4());
                let data_dir = format!("/data/data/{pkg}");
                let tar_timeout = Duration::from_secs(300);

                // 1. Force-stop the app
                if let Err(e) = adb::shell(&serial, &format!("am force-stop {pkg}")).await {
                    warn!(%pkg, "Failed to force-stop app before restore: {e}");
                }

                // 2. Clear app data — creates clean data dir with correct base permissions
                match adb::shell(&serial, &format!("pm clear {pkg}")).await {
                    Ok(output) if !output.trim().starts_with("Success") => {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("pm clear failed: {}", output.trim()),
                            )
                            .await);
                    }
                    Err(e) => {
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Failed to clear app data: {e}"),
                            )
                            .await);
                    }
                    _ => {}
                }

                // 3. Push archive to device
                if let Err(e) = adb::push_file(&serial, local_path, &device_tmp).await {
                    let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                    return Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_RESTORE_FAILED",
                            format!("Failed to push app state archive: {e}"),
                        )
                        .await);
                }

                // 4. Determine access strategy
                let is_root = adb::shell_lenient(&serial, "id")
                    .await
                    .map(|out| out.contains("uid=0"))
                    .unwrap_or(false);

                // 5. Extract archive into app data dir
                let tar_result = if is_root {
                    adb::shell_with_timeout(
                        &serial,
                        &format!("tar xzf {device_tmp} -C {data_dir}"),
                        tar_timeout,
                    )
                    .await
                } else {
                    adb::shell_with_timeout(
                        &serial,
                        &format!("run-as {pkg} tar xzf {device_tmp} -C {data_dir}"),
                        tar_timeout,
                    )
                    .await
                };

                if let Err(e) = tar_result {
                    let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                    return Ok(self
                        .action_error(
                            request_id,
                            "APP_STATE_RESTORE_FAILED",
                            format!("Failed to extract app state archive: {e}"),
                        )
                        .await);
                }

                // 6. Fix ownership and SELinux context (root only)
                if is_root {
                    let uid_output = match adb::shell_lenient(
                        &serial,
                        &format!("stat -c '%u' {data_dir}"),
                    )
                    .await
                    {
                        Ok(output) => output,
                        Err(e) => {
                            let _ =
                                adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                            return Ok(self
                                .action_error(
                                    request_id,
                                    "APP_STATE_RESTORE_FAILED",
                                    format!("Failed to determine app UID via stat: {e}"),
                                )
                                .await);
                        }
                    };
                    let uid = uid_output.trim().to_string();

                    if uid.is_empty() {
                        let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                "Failed to determine app UID: stat returned empty output"
                                    .to_string(),
                            )
                            .await);
                    }

                    if let Err(e) = adb::shell_with_timeout(
                        &serial,
                        &format!("chown -R {uid}:{uid} {data_dir}"),
                        Duration::from_secs(60),
                    )
                    .await
                    {
                        let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Failed to fix ownership on restored app state: {e}"),
                            )
                            .await);
                    }

                    if let Err(e) = adb::shell_with_timeout(
                        &serial,
                        &format!("restorecon -R {data_dir}"),
                        Duration::from_secs(60),
                    )
                    .await
                    {
                        let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;
                        return Ok(self
                            .action_error(
                                request_id,
                                "APP_STATE_RESTORE_FAILED",
                                format!("Failed to fix SELinux context on restored app state: {e}"),
                            )
                            .await);
                    }
                }

                // 7. Clean up temp file
                let _ = adb::shell_lenient(&serial, &format!("rm -f {device_tmp}")).await;

                info!(%pkg, %local_path, "App state restored");
                Ok(Self::success_action_response(request_id))
            }
        }
    }

    // ─── Network Route Interception ───

    type NetworkRouteStream =
        Pin<Box<dyn Stream<Item = Result<proto::NetworkRouteServerMessage, Status>> + Send>>;

    async fn network_route(
        &self,
        request: Request<Streaming<proto::NetworkRouteClientMessage>>,
    ) -> Result<Response<Self::NetworkRouteStream>, Status> {
        info!("NetworkRoute stream opened");

        let mut inbound = request.into_inner();
        let network_proxy = self.network_proxy.clone();

        // Channel for server → client messages. Buffered to avoid blocking
        // the proxy on slow SDK consumers.
        let (to_sdk_tx, mut to_sdk_rx) =
            tokio::sync::mpsc::channel::<proto::NetworkRouteServerMessage>(256);

        let handler = Arc::new(RouteInterceptHandler::new(to_sdk_tx));
        let handler_for_proxy = handler.clone();

        // Store the handler so start_network_capture can install it on
        // newly created proxies (the stream may open before capture starts).
        *self.active_route_handler.write().await = Some(handler.clone());

        // Install the handler on the proxy if one is already running.
        {
            let proxy_guard = network_proxy.read().await;
            if let Some(proxy) = proxy_guard.as_ref() {
                proxy.set_handler(handler_for_proxy.clone()).await;
            }
        }

        // The output stream sends server messages to the client.
        let (out_tx, out_rx) =
            tokio::sync::mpsc::channel::<Result<proto::NetworkRouteServerMessage, Status>>(256);

        // Task: forward to_sdk_rx → out_tx
        let out_tx_fwd = out_tx.clone();
        tokio::spawn(async move {
            while let Some(msg) = to_sdk_rx.recv().await {
                if out_tx_fwd.send(Ok(msg)).await.is_err() {
                    break;
                }
            }
        });

        // Task: read inbound client messages and dispatch
        let handler_for_read = handler.clone();
        let out_tx_read = out_tx;
        let network_proxy_cleanup = network_proxy.clone();
        let active_route_handler_cleanup = self.active_route_handler.clone();
        tokio::spawn(async move {
            while let Some(result) = inbound.message().await.transpose() {
                let msg = match result {
                    Ok(m) => m,
                    Err(e) => {
                        debug!("NetworkRoute inbound error: {e}");
                        break;
                    }
                };

                let Some(inner) = msg.msg else { continue };
                match inner {
                    proto::network_route_client_message::Msg::RegisterRoute(req) => {
                        let route_id = req.route_id.clone();
                        let result = handler_for_read
                            .register_route(route_id.clone(), &req.url_pattern)
                            .await;
                        let resp = proto::NetworkRouteServerMessage {
                            msg: Some(
                                proto::network_route_server_message::Msg::RegisterRouteResponse(
                                    proto::RegisterRouteResponse {
                                        route_id,
                                        success: result.is_ok(),
                                        error_message: result.err().unwrap_or_default(),
                                    },
                                ),
                            ),
                        };
                        if out_tx_read.send(Ok(resp)).await.is_err() {
                            break;
                        }
                    }
                    proto::network_route_client_message::Msg::UnregisterRoute(req) => {
                        let success = handler_for_read.unregister_route(&req.route_id).await;
                        let resp = proto::NetworkRouteServerMessage {
                            msg: Some(
                                proto::network_route_server_message::Msg::UnregisterRouteResponse(
                                    proto::UnregisterRouteResponse {
                                        route_id: req.route_id,
                                        success,
                                    },
                                ),
                            ),
                        };
                        if out_tx_read.send(Ok(resp)).await.is_err() {
                            break;
                        }
                    }
                    proto::network_route_client_message::Msg::RouteDecision(decision) => {
                        handler_for_read.resolve_decision(decision).await;
                    }
                    proto::network_route_client_message::Msg::SubscribeEvents(_) => {
                        handler_for_read.subscribe_events().await;
                    }
                    proto::network_route_client_message::Msg::UnsubscribeEvents(_) => {
                        handler_for_read.unsubscribe_events().await;
                    }
                }
            }

            // Stream closed — clean up
            info!("NetworkRoute stream closed, releasing pending intercepts");
            handler_for_read.release_all_pending().await;

            // Guard cleanup on Arc-pointer identity: if a newer NetworkRoute
            // stream has already installed its handler in between, we must
            // not null out its state when our (now-stale) stream closes.
            // `Arc::ptr_eq` keeps comparison Send-safe (raw `*const T` is
            // not Send, which would break the surrounding `tokio::spawn`).
            let mut stored = active_route_handler_cleanup.write().await;
            let still_ours = stored
                .as_ref()
                .map(|h| Arc::ptr_eq(h, &handler_for_read))
                .unwrap_or(false);
            if still_ours {
                *stored = None;
                drop(stored);
                let proxy_guard = network_proxy_cleanup.read().await;
                if let Some(proxy) = proxy_guard.as_ref() {
                    proxy.clear_handler().await;
                }
            } else {
                debug!("NetworkRoute cleanup: newer handler already installed, skipping clear");
            }
        });

        let output_stream = tokio_stream::wrappers::ReceiverStream::new(out_rx);
        Ok(Response::new(Box::pin(output_stream)))
    }
}

// ─── Helper: Parse ElementInfo from agent JSON ───

pub(crate) fn parse_element_info(data: &Value) -> Option<proto::ElementInfo> {
    let el = if data.get("element").is_some() {
        data.get("element")?
    } else {
        data
    };

    Some(proto::ElementInfo {
        element_id: json_str(el, "elementId"),
        class_name: json_str(el, "className"),
        text: json_str(el, "text"),
        content_description: json_str(el, "contentDescription"),
        resource_id: json_str(el, "resourceId"),
        enabled: json_bool(el, "enabled"),
        visible: json_bool(el, "visible"),
        clickable: json_bool(el, "clickable"),
        focusable: json_bool(el, "focusable"),
        scrollable: json_bool(el, "scrollable"),
        bounds: parse_bounds(el.get("bounds")),
        hint: json_str(el, "hint"),
        checked: json_bool(el, "checked"),
        selected: json_bool(el, "selected"),
        focused: json_bool(el, "focused"),
        role: json_str(el, "role"),
        viewport_ratio: json_float(el, "viewportRatio"),
    })
}

pub(crate) fn parse_element_list(data: &Value) -> Vec<proto::ElementInfo> {
    let arr = data
        .get("elements")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    arr.iter().filter_map(parse_element_info).collect()
}

pub(crate) fn parse_bounds(value: Option<&Value>) -> Option<proto::Bounds> {
    let b = value?;
    Some(proto::Bounds {
        left: b.get("left").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        top: b.get("top").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        right: b.get("right").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        bottom: b.get("bottom").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
    })
}

pub(crate) fn json_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn json_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

pub(crate) fn json_float(v: &Value, key: &str) -> f32 {
    v.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32
}

/// Parse a component name (package/activity) from `dumpsys activity` output.
///
/// The output line looks like:
///   `mResumedActivity: ActivityRecord{abcdef0 u0 com.example.app/.MainActivity t123}`
///
/// Returns `Some((package, activity))` or `None` if parsing fails.
fn parse_component_name(dumpsys_output: &str) -> Option<(String, String)> {
    // Look for a token that matches the pattern: word-chars-and-dots / word-chars-and-dots
    // Component names contain [a-zA-Z0-9._$] separated by a single '/'.
    for token in dumpsys_output.split_whitespace() {
        let token = token.trim_end_matches('}');
        if let Some(slash_pos) = token.find('/') {
            let pkg = &token[..slash_pos];
            let act = &token[slash_pos + 1..];
            // A valid component has a package with at least one dot and a non-empty activity
            if pkg.contains('.')
                && !act.is_empty()
                && pkg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
                && act
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '$')
            {
                return Some((pkg.to_string(), act.to_string()));
            }
        }
    }
    None
}

fn parse_resolved_activity(output: &str, package_name: &str) -> Option<String> {
    let (pkg, activity) = parse_component_name(output)?;
    if pkg == package_name {
        Some(activity)
    } else {
        None
    }
}

/// Best-effort TCP connect from this process out to `host:port`, for testing
/// whether our own LAN listener is reachable from the network interface.
///
/// Used on physical iOS to catch the macOS Application Firewall stealth-mode
/// failure mode: the proxy binds cleanly on `0.0.0.0`, loopback self-tests
/// work, but unsolicited inbound packets from the LAN are silently dropped
/// by the firewall and the device never reaches the proxy.
///
/// Returns `true` if the connection establishes within 1.5 seconds, `false`
/// otherwise. We don't distinguish between "no route", "RST", and "timeout"
/// — any failure means the proxy isn't reachable as the iOS device sees it.
#[cfg(target_os = "macos")]
async fn self_probe_lan_listener(lan_ip: std::net::Ipv4Addr, port: u16) -> bool {
    use tokio::net::TcpStream;
    use tokio::time::timeout;
    let addr = std::net::SocketAddr::new(std::net::IpAddr::V4(lan_ip), port);
    matches!(
        timeout(Duration::from_millis(1_500), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ─── selector_to_json ───

    #[test]
    fn selector_to_json_text() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Text("Login".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["text"], "Login");
    }

    #[test]
    fn selector_to_json_role_with_name() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Role(proto::RoleSelector {
                role: "button".into(),
                name: "Submit".into(),
            })),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["role"]["role"], "button");
        assert_eq!(j["role"]["name"], "Submit");
    }

    #[test]
    fn selector_to_json_content_desc() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::ContentDesc("Back button".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["contentDesc"], "Back button");
    }

    #[test]
    fn selector_to_json_text_contains() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::TextContains("Welcome".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["textContains"], "Welcome");
    }

    #[test]
    fn selector_to_json_hint() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Hint("Enter email".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["hint"], "Enter email");
    }

    #[test]
    fn selector_to_json_class_name() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::ClassName(
                "android.widget.Button".into(),
            )),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["className"], "android.widget.Button");
    }

    #[test]
    fn selector_to_json_test_id() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::TestId("login-btn".into())),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["testId"], "login-btn");
    }

    #[test]
    fn selector_to_json_resource_id() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::ResourceId(
                "com.app:id/btn".into(),
            )),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["resourceId"], "com.app:id/btn");
    }

    #[test]
    fn selector_to_json_xpath() {
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Xpath(
                "//button[@text='OK']".into(),
            )),
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["xpath"], "//button[@text='OK']");
    }

    #[test]
    fn selector_to_json_with_parent() {
        let parent = proto::Selector {
            selector: Some(proto::selector::Selector::ResourceId(
                "com.app:id/toolbar".into(),
            )),
            parent: None,
        };
        let sel = proto::Selector {
            selector: Some(proto::selector::Selector::Text("Save".into())),
            parent: Some(Box::new(parent)),
        };
        let j = selector_to_json(&sel);
        assert_eq!(j["text"], "Save");
        assert_eq!(j["parent"]["resourceId"], "com.app:id/toolbar");
    }

    #[test]
    fn selector_to_json_no_selector_set() {
        let sel = proto::Selector {
            selector: None,
            parent: None,
        };
        let j = selector_to_json(&sel);
        assert_eq!(j, json!({}));
    }

    // ─── parse_element_info ───

    #[test]
    fn parse_element_info_valid() {
        let data = json!({
            "elementId": "e1",
            "className": "android.widget.Button",
            "text": "Click me",
            "contentDescription": "A button",
            "resourceId": "com.app:id/btn",
            "enabled": true,
            "visible": true,
            "clickable": true,
            "focusable": false,
            "scrollable": false,
            "hint": "tap here",
            "checked": false,
            "selected": true,
            "focused": true,
            "role": "button",
            "viewportRatio": 0.75,
            "bounds": { "left": 10, "top": 20, "right": 100, "bottom": 60 }
        });
        let el = parse_element_info(&data).unwrap();
        assert_eq!(el.element_id, "e1");
        assert_eq!(el.class_name, "android.widget.Button");
        assert_eq!(el.text, "Click me");
        assert_eq!(el.content_description, "A button");
        assert_eq!(el.resource_id, "com.app:id/btn");
        assert!(el.enabled);
        assert!(el.visible);
        assert!(el.clickable);
        assert!(!el.focusable);
        assert!(!el.scrollable);
        assert_eq!(el.hint, "tap here");
        assert!(!el.checked);
        assert!(el.selected);
        assert!(el.focused);
        assert_eq!(el.role, "button");
        assert!((el.viewport_ratio - 0.75).abs() < 0.01);
        let b = el.bounds.unwrap();
        assert_eq!((b.left, b.top, b.right, b.bottom), (10, 20, 100, 60));
    }

    #[test]
    fn parse_element_info_missing_fields() {
        let data = json!({});
        let el = parse_element_info(&data).unwrap();
        assert_eq!(el.element_id, "");
        assert_eq!(el.text, "");
        assert!(!el.enabled);
        assert!(!el.focused);
        assert_eq!(el.role, "");
        assert_eq!(el.viewport_ratio, 0.0);
        assert!(el.bounds.is_none());
    }

    #[test]
    fn parse_element_info_nested_element_key() {
        let data = json!({
            "element": {
                "elementId": "nested-1",
                "text": "Nested",
                "enabled": true
            }
        });
        let el = parse_element_info(&data).unwrap();
        assert_eq!(el.element_id, "nested-1");
        assert_eq!(el.text, "Nested");
        assert!(el.enabled);
    }

    // ─── parse_element_list ───

    #[test]
    fn parse_element_list_empty() {
        let data = json!({"elements": []});
        let list = parse_element_list(&data);
        assert!(list.is_empty());
    }

    #[test]
    fn parse_element_list_multiple() {
        let data = json!({
            "elements": [
                {"elementId": "a", "text": "First"},
                {"elementId": "b", "text": "Second"}
            ]
        });
        let list = parse_element_list(&data);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].element_id, "a");
        assert_eq!(list[1].element_id, "b");
        assert_eq!(list[0].text, "First");
        assert_eq!(list[1].text, "Second");
    }

    #[test]
    fn parse_element_list_missing_key() {
        let data = json!({});
        let list = parse_element_list(&data);
        assert!(list.is_empty());
    }

    // ─── parse_bounds ───

    #[test]
    fn parse_bounds_valid() {
        let v = json!({"left": 5, "top": 10, "right": 200, "bottom": 150});
        let b = parse_bounds(Some(&v)).unwrap();
        assert_eq!(b.left, 5);
        assert_eq!(b.top, 10);
        assert_eq!(b.right, 200);
        assert_eq!(b.bottom, 150);
    }

    #[test]
    fn parse_bounds_none() {
        assert!(parse_bounds(None).is_none());
    }

    #[test]
    fn parse_bounds_partial_fields() {
        let v = json!({"left": 1});
        let b = parse_bounds(Some(&v)).unwrap();
        assert_eq!(b.left, 1);
        assert_eq!(b.top, 0);
        assert_eq!(b.right, 0);
        assert_eq!(b.bottom, 0);
    }

    // ─── opt_timeout ───

    #[test]
    fn opt_timeout_zero_returns_none() {
        assert!(opt_timeout(0).is_none());
    }

    #[test]
    fn opt_timeout_positive_returns_some() {
        assert_eq!(opt_timeout(5000), Some(5000));
        assert_eq!(opt_timeout(1), Some(1));
    }

    // ─── json_str / json_bool ───

    #[test]
    fn json_str_present() {
        let v = json!({"name": "hello"});
        assert_eq!(json_str(&v, "name"), "hello");
    }

    #[test]
    fn json_str_missing() {
        let v = json!({});
        assert_eq!(json_str(&v, "name"), "");
    }

    #[test]
    fn json_bool_present() {
        let v = json!({"flag": true});
        assert!(json_bool(&v, "flag"));
    }

    #[test]
    fn json_bool_missing() {
        let v = json!({});
        assert!(!json_bool(&v, "flag"));
    }

    // ─── parse_component_name ───

    #[test]
    fn parse_component_name_typical() {
        let output =
            "  mResumedActivity: ActivityRecord{abcdef0 u0 com.example.app/.MainActivity t123}";
        let (pkg, act) = parse_component_name(output).unwrap();
        assert_eq!(pkg, "com.example.app");
        assert_eq!(act, ".MainActivity");
    }

    #[test]
    fn parse_component_name_full_activity() {
        let output = "  mResumedActivity: ActivityRecord{abc u0 com.example.app/com.example.app.settings.ProfileActivity t5}";
        let (pkg, act) = parse_component_name(output).unwrap();
        assert_eq!(pkg, "com.example.app");
        assert_eq!(act, "com.example.app.settings.ProfileActivity");
    }

    #[test]
    fn parse_component_name_empty_output() {
        assert!(parse_component_name("").is_none());
    }

    #[test]
    fn parse_component_name_no_match() {
        assert!(parse_component_name("  mResumedActivity: null").is_none());
    }

    #[test]
    fn parse_component_name_ignores_paths() {
        // Should not match filesystem paths like /data/local/tmp
        let output = "  mResumedActivity: /data/local/tmp ActivityRecord{abc u0 com.foo/.Bar t1}";
        let (pkg, act) = parse_component_name(output).unwrap();
        assert_eq!(pkg, "com.foo");
        assert_eq!(act, ".Bar");
    }

    #[test]
    fn parse_resolved_activity_brief_output() {
        let output = "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.app/.MainActivity";
        let activity = parse_resolved_activity(output, "com.example.app").unwrap();
        assert_eq!(activity, ".MainActivity");
    }

    #[test]
    fn parse_resolved_activity_full_name() {
        let output = "com.example.app/com.example.app.settings.ProfileActivity";
        let activity = parse_resolved_activity(output, "com.example.app").unwrap();
        assert_eq!(activity, "com.example.app.settings.ProfileActivity");
    }

    #[test]
    fn parse_resolved_activity_rejects_other_package() {
        let output = "com.other.app/.MainActivity";
        assert!(parse_resolved_activity(output, "com.example.app").is_none());
    }
}
