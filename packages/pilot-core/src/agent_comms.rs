use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tracing::{debug, info};

use crate::adb;

/// Port the on-device agent listens on (device side).
const AGENT_DEVICE_PORT: u16 = 18700;

/// Default local port we forward to.
const DEFAULT_AGENT_HOST_PORT: u16 = 18700;

/// Default timeout for agent commands.
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Headroom added to the read-side timeout so the daemon always outlasts the
/// agent's own work clock. Without this, an agent command that uses up its
/// full client-supplied timeout (e.g. FindElement(timeout_ms=100)) races the
/// daemon's read timeout — the daemon may give up before the agent's "not
/// found" response arrives, falsely marking the connection as dead and
/// triggering an unnecessary reconnect on the next command.
const READ_TIMEOUT_HEADROOM: Duration = Duration::from_secs(5);

// ─── Agent Command Protocol ───
//
// Commands are serialized as: {"id": "uuid", "method": "methodName", "params": {...}}
// to match what the on-device Android agent expects.

#[derive(Debug, Clone)]
pub enum AgentCommand {
    FindElement {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    FindElements {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    Tap {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    LongPress {
        selector: Value,
        duration_ms: Option<u64>,
        timeout_ms: Option<u64>,
    },
    TypeText {
        selector: Value,
        text: String,
        timeout_ms: Option<u64>,
    },
    ClearText {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    Swipe {
        direction: String,
        start_element: Option<Value>,
        speed: Option<f32>,
        distance: Option<f32>,
        timeout_ms: Option<u64>,
    },
    Scroll {
        container: Option<Value>,
        direction: String,
        scroll_until_visible: Option<Value>,
        distance: Option<f32>,
        timeout_ms: Option<u64>,
    },
    PressKey {
        key: String,
    },
    GetUiHierarchy {},
    WaitForIdle {
        timeout_ms: Option<u64>,
    },
    #[allow(dead_code)]
    Screenshot {},
    DoubleTap {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    DragAndDrop {
        source_selector: Value,
        target_selector: Value,
        timeout_ms: Option<u64>,
    },
    SelectOption {
        selector: Value,
        option: Option<String>,
        index: Option<i32>,
        timeout_ms: Option<u64>,
    },
    PinchZoom {
        selector: Value,
        scale: f32,
        timeout_ms: Option<u64>,
    },
    Focus {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    Blur {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    Highlight {
        selector: Value,
        duration_ms: Option<u64>,
        timeout_ms: Option<u64>,
    },
    TakeElementScreenshot {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    SetClipboard {
        text: String,
    },
    GetClipboard {},
    LaunchApp {
        package: String,
    },
    TerminateApp {
        package: String,
    },
    HideKeyboard {},
    IsKeyboardShown {},
    SetOrientation {
        orientation: String,
    },
    GetOrientation {},
    GetColorScheme {},
    GetAppState {
        package: String,
    },
}

impl AgentCommand {
    /// Serialize into the JSON protocol format: {"id": "...", "method": "...", "params": {...}}
    pub(crate) fn to_json(&self, id: &str) -> Value {
        let (method, params) = match self {
            AgentCommand::FindElement {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("findElement", p)
            }
            AgentCommand::FindElements {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("findElements", p)
            }
            AgentCommand::Tap {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("tap", p)
            }
            AgentCommand::LongPress {
                selector,
                duration_ms,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(d) = duration_ms {
                    p["duration"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("longPress", p)
            }
            AgentCommand::TypeText {
                selector,
                text,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                p["text"] = json!(text);
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("typeText", p)
            }
            AgentCommand::ClearText {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("clearText", p)
            }
            AgentCommand::Swipe {
                direction,
                start_element,
                speed,
                distance,
                timeout_ms,
            } => {
                let mut p = json!({"direction": direction});
                if let Some(se) = start_element {
                    p["startElement"] = se.clone();
                }
                if let Some(s) = speed {
                    p["speed"] = json!(s);
                }
                if let Some(d) = distance {
                    p["distance"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("swipe", p)
            }
            AgentCommand::Scroll {
                container,
                direction,
                scroll_until_visible,
                distance,
                timeout_ms,
            } => {
                let mut p = json!({"direction": direction});
                if let Some(c) = container {
                    p["container"] = c.clone();
                }
                if let Some(sv) = scroll_until_visible {
                    p["scrollTo"] = sv.clone();
                }
                if let Some(d) = distance {
                    p["distance"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("scroll", p)
            }
            AgentCommand::PressKey { key } => ("pressKey", json!({"key": key})),
            AgentCommand::GetUiHierarchy {} => ("getUiHierarchy", json!({})),
            AgentCommand::WaitForIdle { timeout_ms } => {
                let mut p = json!({});
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("waitForIdle", p)
            }
            AgentCommand::Screenshot {} => ("screenshot", json!({})),
            AgentCommand::DoubleTap {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("doubleTap", p)
            }
            AgentCommand::DragAndDrop {
                source_selector,
                target_selector,
                timeout_ms,
            } => {
                let mut p = json!({
                    "source": source_selector,
                    "target": target_selector,
                });
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("dragAndDrop", p)
            }
            AgentCommand::SelectOption {
                selector,
                option,
                index,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(ref opt) = option {
                    p["option"] = json!(opt);
                }
                if let Some(idx) = index {
                    p["index"] = json!(idx);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("selectOption", p)
            }
            AgentCommand::PinchZoom {
                selector,
                scale,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                p["scale"] = json!(scale);
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("pinchZoom", p)
            }
            AgentCommand::Focus {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("focus", p)
            }
            AgentCommand::Blur {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("blur", p)
            }
            AgentCommand::Highlight {
                selector,
                duration_ms,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(d) = duration_ms {
                    p["duration"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("highlight", p)
            }
            AgentCommand::TakeElementScreenshot {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("elementScreenshot", p)
            }
            AgentCommand::SetClipboard { text } => ("setClipboard", json!({"text": text})),
            AgentCommand::GetClipboard {} => ("getClipboard", json!({})),
            AgentCommand::LaunchApp { package } => ("launchApp", json!({ "bundleId": package })),
            AgentCommand::TerminateApp { package } => {
                ("terminateApp", json!({ "bundleId": package }))
            }
            AgentCommand::HideKeyboard {} => ("hideKeyboard", json!({})),
            AgentCommand::IsKeyboardShown {} => ("isKeyboardShown", json!({})),
            AgentCommand::SetOrientation { orientation } => {
                ("setOrientation", json!({ "orientation": orientation }))
            }
            AgentCommand::GetOrientation {} => ("getOrientation", json!({})),
            AgentCommand::GetColorScheme {} => ("getColorScheme", json!({})),
            AgentCommand::GetAppState { package } => {
                ("getAppState", json!({ "bundleId": package }))
            }
        };

        json!({
            "id": id,
            "method": method,
            "params": params
        })
    }
}

/// Response from the on-device agent.
/// Format: {"id": "...", "result": {...}} or {"id": "...", "error": {"type": "...", "message": "..."}}
#[derive(Debug, Clone)]
pub struct AgentResponse {
    pub success: bool,
    pub error: Option<String>,
    pub error_type: Option<String>,
    pub data: Value,
}

impl AgentResponse {
    pub(crate) fn from_json(value: &Value) -> Self {
        if let Some(error) = value.get("error") {
            AgentResponse {
                success: false,
                error: error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                error_type: error.get("type").and_then(|v| v.as_str()).map(String::from),
                data: Value::Null,
            }
        } else {
            AgentResponse {
                success: true,
                error: None,
                error_type: None,
                data: value.get("result").cloned().unwrap_or(Value::Null),
            }
        }
    }
}

// ─── Connection Management ───

/// Manages the TCP connection to the on-device Pilot agent.
#[derive(Debug)]
pub struct AgentConnection {
    connected: bool,
    device_serial: Option<String>,
    host_port: u16,
    is_ios: bool,
}

impl AgentConnection {
    pub fn new() -> Self {
        Self::with_port(DEFAULT_AGENT_HOST_PORT)
    }

    pub fn with_port(host_port: u16) -> Self {
        Self {
            connected: false,
            device_serial: None,
            host_port,
            is_ios: false,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn port(&self) -> u16 {
        self.host_port
    }

    /// Establish port forwarding and verify the agent is reachable.
    /// For Android, sets up ADB port forwarding.
    /// For iOS simulators, no forwarding is needed (shared localhost).
    pub async fn connect(&mut self, serial: &str) -> Result<()> {
        self.connect_for_platform(serial, false).await
    }

    /// Connect to an iOS agent (skip ADB port forwarding).
    pub async fn connect_ios(&mut self, serial: &str) -> Result<()> {
        self.connect_for_platform(serial, true).await
    }

    async fn connect_for_platform(&mut self, serial: &str, ios: bool) -> Result<()> {
        self.is_ios = ios;

        if !ios {
            // Android: Set up ADB port forwarding
            adb::forward_port(serial, self.host_port, AGENT_DEVICE_PORT)
                .await
                .context("Failed to set up ADB port forwarding to agent")?;
        }
        // iOS simulator: agent listens on localhost directly, no forwarding needed

        // Try to connect and send a ping
        match self.ping_agent().await {
            Ok(_) => {
                self.connected = true;
                self.device_serial = Some(serial.to_string());
                info!(
                    serial,
                    platform = if ios { "ios" } else { "android" },
                    "Connected to on-device agent"
                );
                Ok(())
            }
            Err(e) => {
                if !ios {
                    // Clean up the forwarding on failure
                    let _ = adb::remove_forward(serial, self.host_port).await;
                }
                bail!("Agent is not responding on device {serial}: {e}. Is the agent app running?");
            }
        }
    }

    /// Disconnect and clean up port forwarding.
    #[allow(dead_code)]
    pub async fn disconnect(&mut self) {
        if !self.is_ios {
            if let Some(ref serial) = self.device_serial {
                let _ = adb::remove_forward(serial, self.host_port).await;
            }
        }
        self.connected = false;
        self.device_serial = None;
        debug!("Agent disconnected");
    }

    /// Send a command to the agent and wait for a response.
    pub async fn send_command(&mut self, command: &AgentCommand) -> Result<AgentResponse> {
        self.send_command_with_timeout(command, DEFAULT_COMMAND_TIMEOUT)
            .await
    }

    /// Send a command with a specific timeout.
    pub async fn send_command_with_timeout(
        &mut self,
        command: &AgentCommand,
        timeout: Duration,
    ) -> Result<AgentResponse> {
        if !self.connected {
            bail!("Not connected to agent. Call StartAgent or connect first.");
        }

        // Send the command with a single attempt. We deliberately do NOT
        // retry on failure: many failure modes (e.g. "Agent returned empty
        // response" — agent processed the command but the response was
        // dropped) mean the command already executed once on the agent, so
        // retrying it would double-execute side-effectful commands like tap
        // or openDeepLink. We also do NOT flip `self.connected = false` on a
        // single failed command — a transient hierarchy dump failure does
        // not mean the agent process is dead, and poisoning the cached
        // connection flag would falsely trigger expensive recovery on the
        // next test's session preflight. The flag only flips on an explicit
        // disconnect; the trace collector swallows transient hierarchy/screen
        // capture errors so a single dropped response is non-fatal.
        self.try_send_command(command, timeout).await
    }

    async fn try_send_command(
        &self,
        command: &AgentCommand,
        timeout: Duration,
    ) -> Result<AgentResponse> {
        let addr = format!("127.0.0.1:{}", self.host_port);
        let mut stream = tokio::time::timeout(Duration::from_secs(5), async {
            TcpStream::connect(&addr).await
        })
        .await
        .map_err(|_| anyhow!("Timed out connecting to agent socket"))?
        .context("Failed to connect to agent socket")?;

        let request_id = uuid::Uuid::new_v4().to_string();
        let json_msg = command.to_json(&request_id);
        let payload = serde_json::to_string(&json_msg).context("Failed to serialize command")?;
        debug!(payload = %payload, "Sending command to agent");

        // Write the command as a newline-delimited JSON message
        stream
            .write_all(payload.as_bytes())
            .await
            .context("Failed to write to agent socket")?;
        stream
            .write_all(b"\n")
            .await
            .context("Failed to write newline to agent socket")?;
        stream.flush().await?;

        // Read the response (newline-delimited JSON). Use the caller-supplied
        // timeout plus headroom so the agent's own work clock always finishes
        // first — see READ_TIMEOUT_HEADROOM for the rationale.
        let read_timeout = timeout + READ_TIMEOUT_HEADROOM;
        let reader = BufReader::new(&mut stream);
        let mut line = String::new();

        tokio::time::timeout(read_timeout, async {
            let mut reader = reader;
            reader
                .read_line(&mut line)
                .await
                .context("Failed to read from agent socket")
        })
        .await
        .map_err(|_| anyhow!("Agent command timed out after {read_timeout:?}"))??;

        let line = line.trim();
        if line.is_empty() {
            bail!("Agent returned empty response");
        }

        debug!(response = %line, "Received response from agent");

        let raw: Value =
            serde_json::from_str(line).context("Failed to parse agent response as JSON")?;

        Ok(AgentResponse::from_json(&raw))
    }

    async fn ping_agent(&self) -> Result<()> {
        let addr = format!("127.0.0.1:{}", self.host_port);
        let mut stream = tokio::time::timeout(Duration::from_secs(3), async {
            TcpStream::connect(&addr).await
        })
        .await
        .map_err(|_| anyhow!("Timed out connecting to agent"))?
        .context("Agent socket not reachable")?;

        // Send a simple ping
        let ping = r#"{"command":"ping"}"#;
        stream.write_all(ping.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;

        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();

        tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line))
            .await
            .map_err(|_| anyhow!("Agent did not respond to ping"))??;

        debug!("Agent ping successful");
        Ok(())
    }

    #[allow(dead_code)]
    async fn reconnect(&mut self, serial: &str) -> Result<()> {
        info!(serial, "Attempting to reconnect to agent");
        self.connected = false;

        // Re-establish ADB port forwarding (Android only; iOS uses localhost directly)
        if !self.is_ios {
            let _ = adb::remove_forward(serial, self.host_port).await;
            adb::forward_port(serial, self.host_port, AGENT_DEVICE_PORT).await?;
        }

        match self.ping_agent().await {
            Ok(_) => {
                self.connected = true;
                info!("Reconnected to agent");
                Ok(())
            }
            Err(e) => {
                bail!("Failed to reconnect to agent: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ─── AgentCommand::to_json ───

    #[test]
    fn to_json_find_element() {
        let cmd = AgentCommand::FindElement {
            selector: json!({"text": "Login"}),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("req-1");
        assert_eq!(j["id"], "req-1");
        assert_eq!(j["method"], "findElement");
        assert_eq!(j["params"]["text"], "Login");
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_find_element_no_timeout() {
        let cmd = AgentCommand::FindElement {
            selector: json!({"text": "OK"}),
            timeout_ms: None,
        };
        let j = cmd.to_json("r2");
        assert_eq!(j["method"], "findElement");
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_find_elements() {
        let cmd = AgentCommand::FindElements {
            selector: json!({"className": "Button"}),
            timeout_ms: Some(1000),
        };
        let j = cmd.to_json("r3");
        assert_eq!(j["method"], "findElements");
        assert_eq!(j["params"]["className"], "Button");
        assert_eq!(j["params"]["timeout"], 1000);
    }

    #[test]
    fn to_json_tap() {
        let cmd = AgentCommand::Tap {
            selector: json!({"testId": "submit"}),
            timeout_ms: None,
        };
        let j = cmd.to_json("t1");
        assert_eq!(j["method"], "tap");
        assert_eq!(j["params"]["testId"], "submit");
    }

    #[test]
    fn to_json_long_press() {
        let cmd = AgentCommand::LongPress {
            selector: json!({"text": "Item"}),
            duration_ms: Some(2000),
            timeout_ms: Some(10000),
        };
        let j = cmd.to_json("lp1");
        assert_eq!(j["method"], "longPress");
        assert_eq!(j["params"]["text"], "Item");
        assert_eq!(j["params"]["duration"], 2000);
        assert_eq!(j["params"]["timeout"], 10000);
    }

    #[test]
    fn to_json_long_press_no_optionals() {
        let cmd = AgentCommand::LongPress {
            selector: json!({"text": "X"}),
            duration_ms: None,
            timeout_ms: None,
        };
        let j = cmd.to_json("lp2");
        assert!(j["params"].get("duration").is_none());
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_type_text() {
        let cmd = AgentCommand::TypeText {
            selector: json!({"hint": "Email"}),
            text: "user@example.com".into(),
            timeout_ms: Some(3000),
        };
        let j = cmd.to_json("tt1");
        assert_eq!(j["method"], "typeText");
        assert_eq!(j["params"]["text"], "user@example.com");
        assert_eq!(j["params"]["hint"], "Email");
        assert_eq!(j["params"]["timeout"], 3000);
    }

    #[test]
    fn to_json_clear_text() {
        let cmd = AgentCommand::ClearText {
            selector: json!({"resourceId": "input"}),
            timeout_ms: None,
        };
        let j = cmd.to_json("ct1");
        assert_eq!(j["method"], "clearText");
        assert_eq!(j["params"]["resourceId"], "input");
    }

    #[test]
    fn to_json_swipe() {
        let cmd = AgentCommand::Swipe {
            direction: "up".into(),
            start_element: Some(json!({"text": "list"})),
            speed: Some(1.5),
            distance: Some(0.8),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("sw1");
        assert_eq!(j["method"], "swipe");
        assert_eq!(j["params"]["direction"], "up");
        assert_eq!(j["params"]["startElement"]["text"], "list");
        assert_eq!(j["params"]["speed"], 1.5);
        assert_eq!(j["params"]["distance"], json!(0.800000011920929)); // f32 precision
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_swipe_minimal() {
        let cmd = AgentCommand::Swipe {
            direction: "down".into(),
            start_element: None,
            speed: None,
            distance: None,
            timeout_ms: None,
        };
        let j = cmd.to_json("sw2");
        assert_eq!(j["params"]["direction"], "down");
        assert!(j["params"].get("startElement").is_none());
        assert!(j["params"].get("speed").is_none());
    }

    #[test]
    fn to_json_scroll() {
        let cmd = AgentCommand::Scroll {
            container: Some(json!({"resourceId": "list"})),
            direction: "down".into(),
            scroll_until_visible: Some(json!({"text": "End"})),
            distance: Some(0.5),
            timeout_ms: Some(8000),
        };
        let j = cmd.to_json("sc1");
        assert_eq!(j["method"], "scroll");
        assert_eq!(j["params"]["direction"], "down");
        assert_eq!(j["params"]["container"]["resourceId"], "list");
        assert_eq!(j["params"]["scrollTo"]["text"], "End");
    }

    #[test]
    fn to_json_press_key() {
        let cmd = AgentCommand::PressKey {
            key: "KEYCODE_BACK".into(),
        };
        let j = cmd.to_json("pk1");
        assert_eq!(j["method"], "pressKey");
        assert_eq!(j["params"]["key"], "KEYCODE_BACK");
    }

    #[test]
    fn to_json_get_ui_hierarchy() {
        let cmd = AgentCommand::GetUiHierarchy {};
        let j = cmd.to_json("ui1");
        assert_eq!(j["method"], "getUiHierarchy");
        assert_eq!(j["params"], json!({}));
    }

    #[test]
    fn to_json_wait_for_idle() {
        let cmd = AgentCommand::WaitForIdle {
            timeout_ms: Some(10000),
        };
        let j = cmd.to_json("wi1");
        assert_eq!(j["method"], "waitForIdle");
        assert_eq!(j["params"]["timeout"], 10000);
    }

    #[test]
    fn to_json_wait_for_idle_no_timeout() {
        let cmd = AgentCommand::WaitForIdle { timeout_ms: None };
        let j = cmd.to_json("wi2");
        assert_eq!(j["method"], "waitForIdle");
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_screenshot() {
        let cmd = AgentCommand::Screenshot {};
        let j = cmd.to_json("ss1");
        assert_eq!(j["method"], "screenshot");
        assert_eq!(j["params"], json!({}));
    }

    // ─── New Element Actions (PILOT-2) ───

    #[test]
    fn to_json_double_tap() {
        let cmd = AgentCommand::DoubleTap {
            selector: json!({"text": "Button"}),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("dt1");
        assert_eq!(j["method"], "doubleTap");
        assert_eq!(j["params"]["text"], "Button");
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_drag_and_drop() {
        let cmd = AgentCommand::DragAndDrop {
            source_selector: json!({"text": "Item 1"}),
            target_selector: json!({"text": "Drop Zone"}),
            timeout_ms: Some(10000),
        };
        let j = cmd.to_json("dd1");
        assert_eq!(j["method"], "dragAndDrop");
        assert_eq!(j["params"]["source"]["text"], "Item 1");
        assert_eq!(j["params"]["target"]["text"], "Drop Zone");
        assert_eq!(j["params"]["timeout"], 10000);
    }

    #[test]
    fn to_json_select_option_by_text() {
        let cmd = AgentCommand::SelectOption {
            selector: json!({"role": {"role": "combobox", "name": ""}}),
            option: Some("Option 2".into()),
            index: None,
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("so1");
        assert_eq!(j["method"], "selectOption");
        assert_eq!(j["params"]["option"], "Option 2");
        assert!(j["params"].get("index").is_none());
    }

    #[test]
    fn to_json_select_option_by_index() {
        let cmd = AgentCommand::SelectOption {
            selector: json!({"text": "Dropdown"}),
            option: None,
            index: Some(2),
            timeout_ms: None,
        };
        let j = cmd.to_json("so2");
        assert_eq!(j["method"], "selectOption");
        assert_eq!(j["params"]["index"], 2);
        assert!(j["params"].get("option").is_none());
    }

    #[test]
    fn to_json_pinch_zoom() {
        let cmd = AgentCommand::PinchZoom {
            selector: json!({"text": "Map"}),
            scale: 2.0,
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("pz1");
        assert_eq!(j["method"], "pinchZoom");
        assert_eq!(j["params"]["scale"], 2.0);
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_focus() {
        let cmd = AgentCommand::Focus {
            selector: json!({"hint": "Email"}),
            timeout_ms: Some(3000),
        };
        let j = cmd.to_json("f1");
        assert_eq!(j["method"], "focus");
        assert_eq!(j["params"]["hint"], "Email");
        assert_eq!(j["params"]["timeout"], 3000);
    }

    #[test]
    fn to_json_blur() {
        let cmd = AgentCommand::Blur {
            selector: json!({"hint": "Email"}),
            timeout_ms: None,
        };
        let j = cmd.to_json("b1");
        assert_eq!(j["method"], "blur");
        assert_eq!(j["params"]["hint"], "Email");
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_highlight() {
        let cmd = AgentCommand::Highlight {
            selector: json!({"text": "Submit"}),
            duration_ms: Some(2000),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("h1");
        assert_eq!(j["method"], "highlight");
        assert_eq!(j["params"]["duration"], 2000);
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_highlight_no_optionals() {
        let cmd = AgentCommand::Highlight {
            selector: json!({"text": "X"}),
            duration_ms: None,
            timeout_ms: None,
        };
        let j = cmd.to_json("h2");
        assert!(j["params"].get("duration").is_none());
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_take_element_screenshot() {
        let cmd = AgentCommand::TakeElementScreenshot {
            selector: json!({"resourceId": "profile_image"}),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("es1");
        assert_eq!(j["method"], "elementScreenshot");
        assert_eq!(j["params"]["resourceId"], "profile_image");
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_id_is_passed_through() {
        let cmd = AgentCommand::PressKey {
            key: "ENTER".into(),
        };
        let j = cmd.to_json("my-custom-id-123");
        assert_eq!(j["id"], "my-custom-id-123");
    }

    // ─── AgentResponse::from_json ───

    #[test]
    fn from_json_success() {
        let raw = json!({
            "id": "r1",
            "result": {"elementId": "e1", "text": "Hello"}
        });
        let resp = AgentResponse::from_json(&raw);
        assert!(resp.success);
        assert!(resp.error.is_none());
        assert!(resp.error_type.is_none());
        assert_eq!(resp.data["elementId"], "e1");
        assert_eq!(resp.data["text"], "Hello");
    }

    #[test]
    fn from_json_error() {
        let raw = json!({
            "id": "r2",
            "error": {
                "type": "ELEMENT_NOT_FOUND",
                "message": "Could not find element matching selector"
            }
        });
        let resp = AgentResponse::from_json(&raw);
        assert!(!resp.success);
        assert_eq!(
            resp.error.as_deref(),
            Some("Could not find element matching selector")
        );
        assert_eq!(resp.error_type.as_deref(), Some("ELEMENT_NOT_FOUND"));
        assert_eq!(resp.data, Value::Null);
    }

    #[test]
    fn from_json_null_result() {
        let raw = json!({"id": "r3"});
        let resp = AgentResponse::from_json(&raw);
        assert!(resp.success);
        assert_eq!(resp.data, Value::Null);
    }

    #[test]
    fn from_json_success_with_object_result() {
        let raw = json!({
            "id": "r4",
            "result": null
        });
        let resp = AgentResponse::from_json(&raw);
        assert!(resp.success);
        assert_eq!(resp.data, Value::Null);
    }
}
