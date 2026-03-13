use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tracing::{debug, info, warn};

use crate::adb;

/// Port the on-device agent listens on (device side).
const AGENT_DEVICE_PORT: u16 = 18700;

/// Local port we forward to.
const AGENT_HOST_PORT: u16 = 18700;

/// Default timeout for agent commands.
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

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
    Screenshot {},
}

impl AgentCommand {
    /// Serialize into the JSON protocol format: {"id": "...", "method": "...", "params": {...}}
    pub(crate) fn to_json(&self, id: &str) -> Value {
        let (method, params) = match self {
            AgentCommand::FindElement { selector, timeout_ms } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("findElement", p)
            }
            AgentCommand::FindElements { selector, timeout_ms } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("findElements", p)
            }
            AgentCommand::Tap { selector, timeout_ms } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("tap", p)
            }
            AgentCommand::LongPress { selector, duration_ms, timeout_ms } => {
                let mut p = selector.clone();
                if let Some(d) = duration_ms { p["duration"] = json!(d); }
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("longPress", p)
            }
            AgentCommand::TypeText { selector, text, timeout_ms } => {
                let mut p = selector.clone();
                p["text"] = json!(text);
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("typeText", p)
            }
            AgentCommand::ClearText { selector, timeout_ms } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("clearText", p)
            }
            AgentCommand::Swipe { direction, start_element, speed, distance, timeout_ms } => {
                let mut p = json!({"direction": direction});
                if let Some(se) = start_element { p["startElement"] = se.clone(); }
                if let Some(s) = speed { p["speed"] = json!(s); }
                if let Some(d) = distance { p["distance"] = json!(d); }
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("swipe", p)
            }
            AgentCommand::Scroll { container, direction, scroll_until_visible, distance, timeout_ms } => {
                let mut p = json!({"direction": direction});
                if let Some(c) = container { p["container"] = c.clone(); }
                if let Some(sv) = scroll_until_visible { p["scrollTo"] = sv.clone(); }
                if let Some(d) = distance { p["distance"] = json!(d); }
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("scroll", p)
            }
            AgentCommand::PressKey { key } => {
                ("pressKey", json!({"key": key}))
            }
            AgentCommand::GetUiHierarchy {} => {
                ("getUiHierarchy", json!({}))
            }
            AgentCommand::WaitForIdle { timeout_ms } => {
                let mut p = json!({});
                if let Some(t) = timeout_ms { p["timeout"] = json!(t); }
                ("waitForIdle", p)
            }
            AgentCommand::Screenshot {} => {
                ("screenshot", json!({}))
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
                error: error.get("message").and_then(|v| v.as_str()).map(String::from),
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
}

impl AgentConnection {
    pub fn new() -> Self {
        Self {
            connected: false,
            device_serial: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// Establish port forwarding and verify the agent is reachable.
    pub async fn connect(&mut self, serial: &str) -> Result<()> {
        // Set up ADB port forwarding
        adb::forward_port(serial, AGENT_HOST_PORT, AGENT_DEVICE_PORT)
            .await
            .context("Failed to set up ADB port forwarding to agent")?;

        // Try to connect and send a ping
        match self.ping_agent().await {
            Ok(_) => {
                self.connected = true;
                self.device_serial = Some(serial.to_string());
                info!(serial, "Connected to on-device agent");
                Ok(())
            }
            Err(e) => {
                // Clean up the forwarding on failure
                let _ = adb::remove_forward(serial, AGENT_HOST_PORT).await;
                bail!("Agent is not responding on device {serial}: {e}. Is the agent app running?");
            }
        }
    }

    /// Disconnect and clean up port forwarding.
    pub async fn disconnect(&mut self) {
        if let Some(ref serial) = self.device_serial {
            let _ = adb::remove_forward(serial, AGENT_HOST_PORT).await;
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

        // Attempt the command, reconnect once on connection failure
        match self.try_send_command(command, timeout).await {
            Ok(resp) => Ok(resp),
            Err(e) => {
                warn!("Agent command failed, attempting reconnect: {e}");

                if let Some(serial) = self.device_serial.clone() {
                    self.reconnect(&serial).await?;
                    self.try_send_command(command, timeout).await
                } else {
                    Err(e)
                }
            }
        }
    }

    async fn try_send_command(
        &self,
        command: &AgentCommand,
        timeout: Duration,
    ) -> Result<AgentResponse> {
        let mut stream = tokio::time::timeout(Duration::from_secs(5), async {
            TcpStream::connect(format!("127.0.0.1:{AGENT_HOST_PORT}")).await
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

        // Read the response (newline-delimited JSON)
        let reader = BufReader::new(&mut stream);
        let mut line = String::new();

        tokio::time::timeout(timeout, async {
            let mut reader = reader;
            reader
                .read_line(&mut line)
                .await
                .context("Failed to read from agent socket")
        })
        .await
        .map_err(|_| anyhow!("Agent command timed out after {timeout:?}"))??;

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
        let mut stream =
            tokio::time::timeout(Duration::from_secs(3), async {
                TcpStream::connect(format!("127.0.0.1:{AGENT_HOST_PORT}")).await
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

    async fn reconnect(&mut self, serial: &str) -> Result<()> {
        info!(serial, "Attempting to reconnect to agent");
        self.connected = false;

        // Re-establish port forwarding
        let _ = adb::remove_forward(serial, AGENT_HOST_PORT).await;
        adb::forward_port(serial, AGENT_HOST_PORT, AGENT_DEVICE_PORT).await?;

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
        assert_eq!(resp.error.as_deref(), Some("Could not find element matching selector"));
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
