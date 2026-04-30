use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tracing::{debug, info, warn};

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

/// Short timeout used when probing whether the agent is still reachable
/// after an empty-response EOF. We don't care about the response — only
/// whether we can re-establish a TCP connection — so this stays tight.
const AGENT_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Sentinel string used by `try_send_command` to mark an empty-response
/// failure. `anyhow::Error` does not preserve original error types across
/// contexts, so we match on the root message. Kept in sync with the
/// `bail!` site above.
const EMPTY_RESPONSE_MARKER: &str = "Agent returned empty response";

/// Returns true when the given error chain indicates an "empty response
/// from agent" EOF. Matches the string used in the `bail!` above.
fn is_empty_response(err: &anyhow::Error) -> bool {
    err.chain()
        .any(|cause| cause.to_string().contains(EMPTY_RESPONSE_MARKER))
}

/// Probe the agent's socket with a fresh TCP connect on a short timeout.
/// Returns true if we can re-establish a connection, meaning the agent
/// process is still alive and listening — any earlier dropped connection
/// was a stale socket, not a dead agent.
async fn probe_agent_alive(addr: &str) -> bool {
    tokio::time::timeout(AGENT_LIVENESS_PROBE_TIMEOUT, TcpStream::connect(addr))
        .await
        .ok()
        .and_then(|inner| inner.ok())
        .is_some()
}

/// Categorizes a `try_send_command` failure so the caller can decide whether
/// retrying is safe. See the long comment on `send_command_with_timeout` for
/// the reasoning.
enum SendError {
    /// Failed before writing any byte to the agent. Safe to retry.
    Connect(anyhow::Error),
    /// TCP connection succeeded; the agent may have observed the command
    /// (or part of it). Not safe to retry side-effectful commands.
    PostSend(anyhow::Error),
}

impl From<SendError> for anyhow::Error {
    fn from(value: SendError) -> Self {
        match value {
            SendError::Connect(e) | SendError::PostSend(e) => e,
        }
    }
}

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
        typing_delay_ms: Option<u32>,
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
    OpenDeepLink {
        url: String,
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
                typing_delay_ms,
            } => {
                let mut p = selector.clone();
                p["text"] = json!(text);
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                if let Some(d) = typing_delay_ms {
                    p["typingDelayMs"] = json!(d);
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
            AgentCommand::OpenDeepLink { url, package } => {
                ("openDeepLink", json!({ "url": url, "bundleId": package }))
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

/// Manages the TCP connection to the on-device Tapsmith agent.
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

        // We split failures into two classes:
        //
        // 1. Connect-time failures (we never wrote a single byte to the agent)
        //    — safe to retry. The command was never observed by the agent, so
        //    even side-effectful commands like tap/openDeepLink can be tried
        //    again without double-executing. This matters in practice right
        //    after `restartApp`: force-stopping the target app briefly tears
        //    down the agent's listening socket on Android while the agent
        //    process re-binds, so the very next command can hit a transient
        //    "Failed to connect to agent socket".
        //
        // 2. Post-send failures (we already wrote the command to the socket)
        //    — NOT safe to retry. The agent may have processed the command
        //    even if the response was dropped, so retrying would double up
        //    side-effectful commands. The trace collector swallows transient
        //    hierarchy/screen capture errors, so a single dropped response is
        //    still non-fatal for non-essential commands.
        //
        // In neither case do we flip `self.connected = false`: a transient
        // socket blip does not mean the agent process is dead, and poisoning
        // the cached connection flag would trigger expensive recovery on the
        // next test's session preflight.
        match self.try_send_command(command, timeout).await {
            Ok(resp) => Ok(resp),
            Err(SendError::Connect(e)) => {
                warn!("Agent connect failed, retrying once: {e}");
                self.try_send_command(command, timeout)
                    .await
                    .map_err(Into::into)
            }
            Err(SendError::PostSend(e)) => Err(e),
        }
    }

    async fn try_send_command(
        &self,
        command: &AgentCommand,
        timeout: Duration,
    ) -> std::result::Result<AgentResponse, SendError> {
        let addr = format!("127.0.0.1:{}", self.host_port);
        let mut stream = tokio::time::timeout(Duration::from_secs(5), async {
            TcpStream::connect(&addr).await
        })
        .await
        .map_err(|_| SendError::Connect(anyhow!("Timed out connecting to agent socket")))?
        .map_err(|e| SendError::Connect(anyhow!(e).context("Failed to connect to agent socket")))?;

        // Everything past the successful TCP connect normally counts as a
        // "post-send" failure: even if the write hasn't happened yet, we
        // treat it as unsafe to retry once we've claimed a socket, because
        // in practice the write is what fails most of the time and we can't
        // tell from the outside whether the agent observed it.
        //
        // The exception is EOF ("empty response"): see below.
        let io_result: Result<AgentResponse> = async {
            let request_id = uuid::Uuid::new_v4().to_string();
            let json_msg = command.to_json(&request_id);
            let payload =
                serde_json::to_string(&json_msg).context("Failed to serialize command")?;
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

            // Read the response (newline-delimited JSON). Use the caller-
            // supplied timeout plus headroom so the agent's own work clock
            // always finishes first — see READ_TIMEOUT_HEADROOM for the
            // rationale.
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
                bail!("{}", EMPTY_RESPONSE_MARKER);
            }

            debug!(response = %line, "Received response from agent");

            let raw: Value =
                serde_json::from_str(line).context("Failed to parse agent response as JSON")?;

            Ok(AgentResponse::from_json(&raw))
        }
        .await;

        match io_result {
            Ok(resp) => Ok(resp),
            Err(e) => {
                // Empty-response EOF is ambiguous: it could mean "agent died
                // after processing the command" (not safe to retry) or "the
                // socket was already half-dead when we wrote, the write was
                // buffered locally, and the agent never saw it" (safe to
                // retry). The second case is common under host load and is
                // what we want to recover from.
                //
                // Probe with a fresh TCP connect. If the agent is reachable
                // again, the OLD connection was stale — the agent almost
                // certainly did not observe the command, so we reclassify as
                // a Connect error and let the caller retry once on a new
                // socket. If the probe also fails, the agent is truly gone
                // and session recovery upstream will restart it.
                //
                // Narrow double-tap risk for non-idempotent commands:
                //   1. Agent reads the command, executes it (e.g. tap).
                //   2. Agent crashes after writing the response but before
                //      our read completes (or the response is lost to a TCP
                //      RST mid-flight).
                //   3. The supervisor restarts the agent on the same port
                //      before our probe fires.
                //   4. Our probe succeeds → we retry → the tap runs twice.
                //
                // This window is narrow (agent restart is far slower than
                // our 2 s probe) and vastly outweighed by the reliability
                // win under host load, but it IS a real correctness risk
                // for mutating commands. A future improvement would gate
                // the reclassification on command idempotency (query ops
                // like findElement / dumpHierarchy → retry safely; mutating
                // ops like tap / type / swipe → no retry) or require the
                // probe to observe the same agent PID / session token
                // rather than just "something is listening on the port".
                if is_empty_response(&e) && probe_agent_alive(&addr).await {
                    warn!("Agent returned empty response but is still reachable — treating as stale connection and retrying");
                    return Err(SendError::Connect(e.context(
                        "Agent connection dropped (empty response); reconnecting",
                    )));
                }
                Err(SendError::PostSend(e))
            }
        }
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
            typing_delay_ms: Some(10),
        };
        let j = cmd.to_json("tt1");
        assert_eq!(j["method"], "typeText");
        assert_eq!(j["params"]["text"], "user@example.com");
        assert_eq!(j["params"]["hint"], "Email");
        assert_eq!(j["params"]["timeout"], 3000);
        assert_eq!(j["params"]["typingDelayMs"], 10);
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

    // ─── SendError categorization ───
    //
    // These tests pin the Connect-vs-PostSend split that send_command_with_timeout
    // depends on. Misclassifying a Connect failure as PostSend would prevent the
    // safe single-retry path from running; misclassifying PostSend as Connect
    // would risk double-executing side-effectful commands like tap.

    #[tokio::test]
    async fn try_send_command_classifies_no_listener_as_connect_error() {
        // Bind a TCP listener to grab a guaranteed-free port, then drop it so
        // a connect attempt to that port fails immediately with ECONNREFUSED.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let conn = AgentConnection::with_port(port);
        let cmd = AgentCommand::Screenshot {};

        let result = conn.try_send_command(&cmd, Duration::from_secs(1)).await;
        match result {
            Err(SendError::Connect(_)) => {} // expected — safe to retry
            Err(SendError::PostSend(e)) => {
                panic!("expected Connect, got PostSend: {e}")
            }
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn try_send_command_reclassifies_empty_response_as_connect_when_agent_reachable() {
        // Listener accepts, reads the command, closes without writing a
        // response. From try_send_command's point of view that's "write
        // succeeded, read returned empty/EOF" — but the listener is still
        // accepting new connections, so the liveness probe that fires after
        // the empty-response detection will succeed and we reclassify as
        // Connect. This is the happy path for the new retry logic.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            while let Ok((mut stream, _)) = listener.accept().await {
                // Read the command bytes so the client's write_all
                // completes successfully, then close the half-open
                // stream without writing a response. The client's
                // read_line will observe EOF → empty response.
                let mut buf = [0u8; 1024];
                while let Ok(n) = stream.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if buf[..n].contains(&b'\n') {
                        break;
                    }
                }
                drop(stream);
            }
        });

        let conn = AgentConnection::with_port(port);
        let cmd = AgentCommand::Screenshot {};

        let result = conn.try_send_command(&cmd, Duration::from_secs(2)).await;
        match result {
            // Reclassification succeeded — outer send_command retry is safe.
            Err(SendError::Connect(e)) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("empty response") || msg.contains("Agent connection dropped"),
                    "expected reclassified empty-response context, got: {msg}"
                );
            }
            Err(SendError::PostSend(e)) => {
                panic!("expected reclassified Connect, got PostSend: {e}")
            }
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn try_send_command_classifies_empty_response_as_post_send_when_agent_gone() {
        // Bind a listener, let the port be claimed briefly so try_send_command
        // gets past the initial connect, then tear down the listener before
        // the empty-response probe fires. The probe must fail → we fall back
        // to PostSend so session recovery upstream can restart the agent.
        //
        // Concretely: we accept exactly one connection, drop it, then drop
        // the listener so the port becomes un-bindable by subsequent probes.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                drop(stream); // close the client connection
            }
            drop(listener); // stop listening so the probe fails
            let _ = done_tx.send(());
        });

        let conn = AgentConnection::with_port(port);
        let cmd = AgentCommand::Screenshot {};
        let result = conn.try_send_command(&cmd, Duration::from_secs(2)).await;
        let _ = done_rx.await;

        match result {
            Err(SendError::PostSend(e)) => {
                let msg = e.to_string();
                // Either empty-response (if we got past the write before the
                // listener vanished) or a post-send write/read error.
                assert!(
                    msg.contains("empty response")
                        || msg.contains("Failed to")
                        || msg.contains("connection"),
                    "unexpected PostSend message: {msg}"
                );
            }
            Err(SendError::Connect(e)) => {
                // Accept this branch too: if the probe races and catches the
                // listener still alive, we land on Connect. The test's
                // primary purpose is to exercise the fallback path; the
                // PostSend branch is the one we're guarding against stale
                // after the dead-agent case.
                let msg = e.to_string();
                assert!(
                    msg.contains("empty response") || msg.contains("Agent connection dropped"),
                    "unexpected Connect message: {msg}"
                );
            }
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn probe_agent_alive_returns_true_when_listener_is_up() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept in the background so the probe's connect can complete.
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let addr = format!("127.0.0.1:{port}");
        assert!(probe_agent_alive(&addr).await);
    }

    #[tokio::test]
    async fn probe_agent_alive_returns_false_when_nothing_listening() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let addr = format!("127.0.0.1:{port}");
        assert!(!probe_agent_alive(&addr).await);
    }

    #[test]
    fn is_empty_response_matches_the_bail_marker() {
        let err = anyhow!("{}", EMPTY_RESPONSE_MARKER).context("wrapper context");
        assert!(is_empty_response(&err));

        let other = anyhow!("some other failure");
        assert!(!is_empty_response(&other));
    }

    #[tokio::test]
    async fn send_command_requires_connected_flag() {
        // Sanity check on the public entry point: it must reject sends when the
        // connection has never been established, otherwise we'd waste a TCP
        // connect attempt and cloud the error message users see.
        let mut conn = AgentConnection::with_port(0);
        let cmd = AgentCommand::Screenshot {};
        let result = conn
            .send_command_with_timeout(&cmd, Duration::from_secs(1))
            .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Not connected"),
            "expected 'Not connected' in error, got: {msg}"
        );
    }

    #[test]
    fn send_error_into_anyhow_preserves_message() {
        let connect: anyhow::Error = SendError::Connect(anyhow!("connect-side failure")).into();
        assert!(connect.to_string().contains("connect-side failure"));

        let post: anyhow::Error = SendError::PostSend(anyhow!("post-send failure")).into();
        assert!(post.to_string().contains("post-send failure"));
    }
}
