use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tonic::{Request, Response, Status};
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
    /// macOS network service name used for proxy (for cleanup, iOS only).
    proxy_network_service: Arc<RwLock<Option<String>>>,
    /// iOS agent launch config (stored for restart on launchApp).
    ios_agent_config: Arc<RwLock<Option<IosAgentConfig>>>,
}

/// Stored iOS agent launch config for restart.
#[derive(Clone)]
struct IosAgentConfig {
    xctestrun_path: String,
    target_package: String,
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
            proxy_network_service: Arc::new(RwLock::new(None)),
            ios_agent_config: Arc::new(RwLock::new(None)),
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
        self.agent
            .write()
            .await
            .send_command(command)
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

        self.agent
            .write()
            .await
            .send_command_with_timeout(command, timeout)
            .await
            .map_err(|e| Status::internal(e.to_string()))
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
            .send_agent_command_with_timeout(
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

        ios::agent_launch::kill_existing_agents_on(serial).await;
        let _ = ios::device::terminate_app(serial, package_name).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        ios::device::launch_app(serial, package_name)
            .await
            .map_err(|e| format!("Failed to relaunch app via simctl before agent restart: {e}"))?;
        tokio::time::sleep(Duration::from_millis(100)).await;

        let agent_port = self.agent.read().await.port();
        ios::agent_launch::start_agent_fresh(
            serial,
            &config.xctestrun_path,
            &config.target_package,
            agent_port,
        )
        .await
        .map_err(|e| format!("Failed to restart iOS agent: {e}"))?;

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
                    "in-runner iOS relaunch failed; trying simctl relaunch"
                );
            }
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
        let proxy = self.network_proxy.write().await.take();
        let serial = self.proxy_device_serial.write().await.take();
        let platform = self.proxy_platform.write().await.take();
        let reverse_port = self.proxy_reverse_port.write().await.take();
        let ca_cert_path = self.proxy_ca_cert_path.write().await.take();
        let _network_service = self.proxy_network_service.write().await.take();

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

                let fallback_cmd = format!("am start -n {package_name}/{activity}");
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
            Ok(()) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
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

                // Apply test-friendly defaults every time the agent starts,
                // not just on first boot — reused simulators may have stale config.
                ios::device::configure_simulator(&serial).await;

                let agent_port = self.agent.read().await.port();
                if let Err(e) = ios::agent_launch::start_agent(
                    &serial,
                    &req.ios_xctestrun_path,
                    &req.target_package,
                    agent_port,
                )
                .await
                {
                    error!(error = %e, "Failed to start iOS agent");
                    return Ok(Response::new(proto::ActionResponse {
                        request_id,
                        success: false,
                        error_type: "AGENT_START_FAILED".to_string(),
                        error_message: e.to_string(),
                        screenshot: Vec::new(),
                    }));
                }

                // Store config for potential agent restart in launchApp
                *self.ios_agent_config.write().await = Some(IosAgentConfig {
                    xctestrun_path: req.ios_xctestrun_path.clone(),
                    target_package: req.target_package.clone(),
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

                if req.clear_data {
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
                    let cmd = format!("am start -n {}/{}", req.package_name, req.activity);
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

                if agent_result.is_err() {
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
                // Use simctl pbpaste to avoid the iOS 16+ paste permission dialog
                // that would crash the XCUITest agent if it accessed UIPasteboard.
                let serial = self.active_serial().await?;
                ios::device::get_clipboard(&serial)
                    .await
                    .map_err(|e| Status::internal(e.to_string()))?
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
                let serial = self.active_serial().await?;
                match req.scheme.as_str() {
                    "dark" | "light" => {}
                    other => {
                        return Err(Status::invalid_argument(format!(
                            "scheme must be 'dark' or 'light', got '{other}'"
                        )));
                    }
                }
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
        if proxy_guard.is_some() {
            return Ok(Response::new(proto::StartNetworkCaptureResponse {
                request_id,
                success: false,
                proxy_port: 0,
                error_message: "Network capture is already running".to_string(),
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

        match platform {
            Platform::Ios => {
                // Network capture on iOS only works for simulators (they share the
                // host network so macOS system proxy routes their traffic through
                // the MITM proxy). Physical iOS devices have their own network
                // stack and no programmatic proxy API.
                let is_simulator = self
                    .device_manager
                    .read()
                    .await
                    .active_device()
                    .map(|d| d.is_emulator)
                    .unwrap_or(true);
                if !is_simulator {
                    return Ok(Response::new(proto::StartNetworkCaptureResponse {
                        request_id,
                        success: false,
                        proxy_port: 0,
                        error_message:
                            "Network capture is not supported on physical iOS devices — only simulators"
                                .to_string(),
                    }));
                }

                // Install CA cert on the iOS simulator's trust store
                if let Err(e) = ios::device::install_ca_cert(&serial, &ca_pem_path).await {
                    let msg = format!(
                        "Failed to install CA cert on simulator: {e} — HTTPS traffic will not be captured"
                    );
                    error!("{msg}");
                    warning = Some(msg);
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

        let proxy = NetworkProxy::start(mitm_ca)
            .await
            .map_err(|e| Status::internal(format!("Failed to start proxy: {e}")))?;
        let host_port = proxy.port();

        match platform {
            Platform::Ios => {
                // iOS simulators share the host network — the proxy is accessible
                // at 127.0.0.1:{host_port}. The CLI configures the macOS system
                // proxy via `networksetup` (one-time admin setup).
                info!(%serial, host_port, "iOS proxy started — CLI will configure macOS system proxy");
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
        let _network_service = self.proxy_network_service.write().await.take();
        if let Some(serial) = &serial {
            match platform {
                Some(Platform::Ios) => {
                    // macOS proxy cleanup is handled by the CLI.
                    info!(%serial, "iOS proxy stopped — CLI handles macOS proxy cleanup");
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
            })
            .collect();

        Ok(Response::new(proto::StopNetworkCaptureResponse {
            request_id,
            success: true,
            entries,
            error_message: String::new(),
        }))
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
