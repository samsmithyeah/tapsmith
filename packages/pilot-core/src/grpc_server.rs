use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tonic::{Request, Response, Status};
use tracing::{error, info, instrument};
use uuid::Uuid;

use crate::adb;
use crate::agent_comms::{AgentCommand, AgentConnection, AgentResponse};
use crate::device::DeviceManager;
use crate::proto;
use crate::screenshot;

pub struct PilotServiceImpl {
    device_manager: Arc<RwLock<DeviceManager>>,
    agent: Arc<RwLock<AgentConnection>>,
}

impl PilotServiceImpl {
    pub fn new(
        device_manager: Arc<RwLock<DeviceManager>>,
        agent: Arc<RwLock<AgentConnection>>,
    ) -> Self {
        Self {
            device_manager,
            agent,
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

    async fn error_screenshot(&self) -> Vec<u8> {
        let serial = self
            .device_manager
            .read()
            .await
            .active_serial()
            .map(String::from);
        screenshot::capture_for_error(serial.as_deref()).await
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

        let serial = self.active_serial().await?;

        match screenshot::capture(&serial).await {
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

        info!(serial = %serial, "Starting agent connection");

        // If a target package was specified, launch it via am instrument or similar
        if !req.target_package.is_empty() {
            let instrument_cmd = format!(
                "am instrument -w -e targetPackage {} com.pilot.agent/.PilotInstrumentation",
                req.target_package
            );

            // Launch instrumentation in the background on the device
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

        // Connect to the agent
        let mut agent = self.agent.write().await;
        match agent.connect(&serial).await {
            Ok(()) => Ok(Response::new(proto::ActionResponse {
                request_id,
                success: true,
                error_type: String::new(),
                error_message: String::new(),
                screenshot: Vec::new(),
            })),
            Err(e) => {
                error!(error = %e, "Failed to connect to agent");
                let screenshot = screenshot::capture_for_error(Some(&serial)).await;
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
}
