use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::net::TcpStream;
use tokio::process::Command;
use tracing::{debug, info, instrument};

/// Launch the PilotAgent XCUITest runner on an iOS simulator.
///
/// This is the iOS equivalent of Android's `am instrument -w dev.pilot.agent/.PilotAgent`.
/// It runs `xcodebuild test-without-building` with the prebuilt .xctestrun file.
///
/// Environment variables and the target app bundle ID must be injected into the
/// `.xctestrun` plist (not the xcodebuild process env) because XCUITest reads its
/// configuration exclusively from that file.
#[instrument(skip(xctestrun_path, target_bundle_id))]
pub async fn start_agent(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    agent_port: u16,
) -> Result<()> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        false,
        false,
        agent_port,
    )
    .await
}

/// Start the agent, optionally forcing a fresh launch even if an agent
/// appears to be running on the port. Used after kill_existing_agents
/// where the stale runner may still briefly respond to pings.
pub async fn start_agent_fresh(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    agent_port: u16,
) -> Result<()> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        true,
        true,
        agent_port,
    )
    .await
}

async fn start_agent_impl(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    force: bool,
    attach_to_running_app: bool,
    agent_port: u16,
) -> Result<()> {
    // Check if agent is already running by trying to connect
    if !force && ping_agent(agent_port).await.is_ok() {
        info!("iOS agent is already running");
        return Ok(());
    }

    // Kill any stale xcodebuild processes targeting this simulator before
    // starting a new one. Without this, leftover processes from a previous
    // run can hold the port or interfere with the new agent launch.
    kill_existing_agents_on(udid).await;

    info!(
        udid,
        xctestrun_path, agent_port, "Starting iOS agent via xcodebuild"
    );

    // Patch the xctestrun file to inject target bundle ID and env vars.
    // xcodebuild process env vars don't reach the XCUITest runner — they must
    // be in the plist's EnvironmentVariables / TestingEnvironmentVariables dicts.
    let patched_xctestrun = patch_xctestrun(
        xctestrun_path,
        target_bundle_id,
        attach_to_running_app,
        agent_port,
    )
    .await
    .context("Failed to patch xctestrun file")?;

    // Launch xcodebuild test-without-building in background
    let mut cmd = Command::new("xcodebuild");
    cmd.args([
        "test-without-building",
        "-xctestrun",
        &patched_xctestrun,
        "-destination",
        &format!("id={udid}"),
    ]);

    // Capture stdout/stderr so we can diagnose failures.
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("Failed to spawn xcodebuild for iOS agent")?;

    // Spawn tasks to drain stdout/stderr, collecting the last N lines for
    // error reporting if xcodebuild exits before the agent comes up.
    let mut child = child;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    use std::sync::Arc;
    use tokio::sync::Mutex;

    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail_writer = stderr_tail.clone();

    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild", "{}", line);
            }
        }
    });
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild::stderr", "{}", line);
                let mut tail = stderr_tail_writer.lock().await;
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });

    // Track xcodebuild exit so we can fail fast instead of polling for 150s.
    let exit_status: Arc<Mutex<Option<std::process::ExitStatus>>> = Arc::new(Mutex::new(None));
    let exit_writer = exit_status.clone();
    tokio::spawn(async move {
        if let Ok(status) = child.wait().await {
            *exit_writer.lock().await = Some(status);
        }
    });

    // Wait for the agent to start accepting connections.
    // Freshly booted/cloned simulators can take 90+ seconds for xcodebuild to
    // install and launch the XCUITest runner, especially when multiple
    // xcodebuild processes compete for resources in parallel mode.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    loop {
        if tokio::time::Instant::now() > deadline {
            bail!(
                "Timed out waiting for iOS agent to start on simulator {udid}. \
                 Check that the XCUITest bundle is built correctly."
            );
        }

        // If xcodebuild exited, the agent won't come up — fail immediately.
        if let Some(status) = *exit_status.lock().await {
            let tail = stderr_tail.lock().await;
            let last_lines = tail.join("\n");
            bail!(
                "xcodebuild exited with {status} before the iOS agent became \
                 ready on simulator {udid}.\nxcodebuild stderr (last lines):\n{last_lines}"
            );
        }

        match ping_agent(agent_port).await {
            Ok(_) => {
                info!(udid, "iOS agent is ready");
                return Ok(());
            }
            Err(_) => {
                debug!("Agent not ready yet, retrying...");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

/// Kill any existing xcodebuild test-without-building processes and the agent.
/// Called before restarting the agent in launchApp/restartApp.
///
/// Kills both the host-side xcodebuild process AND the simulator-side runner
/// app. Without killing the runner app, it keeps listening on its port and
/// `start_agent` would skip launching a new one.
pub async fn kill_existing_agents_on(udid: &str) {
    // Kill host-side xcodebuild targeting this specific simulator.
    // Match on the destination id= argument to avoid killing agents for other simulators.
    let pattern = format!("xcodebuild test-without-building.*id={udid}");
    let _ = Command::new("pkill").args(["-f", &pattern]).output().await;

    // Kill the runner app on the simulator — xcrun simctl terminate
    // targets the simulator process, not the host. The runner's bundle ID
    // is set in the Xcode project (dev.pilot.agent.xctrunner).
    let _ = Command::new("xcrun")
        .args(["simctl", "terminate", udid, "dev.pilot.agent.xctrunner"])
        .output()
        .await;

    // Brief pause for processes to die and port to be released
    tokio::time::sleep(Duration::from_millis(1000)).await;
}

/// Backward-compatible version that terminates on all booted simulators.
#[allow(dead_code)]
pub async fn kill_existing_agents() {
    kill_existing_agents_on("booted").await;
}

/// Create a patched copy of the `.xctestrun` plist that includes the target
/// application bundle ID and the agent's environment variables.
///
/// Uses PlistBuddy to modify a copy — the original file is left untouched.
async fn patch_xctestrun(
    xctestrun_path: &str,
    target_bundle_id: &str,
    attach_to_running_app: bool,
    agent_port: u16,
) -> Result<String> {
    let mode = if attach_to_running_app {
        "attach"
    } else {
        "launch"
    };
    let patched_path = format!("{xctestrun_path}.{mode}.port{agent_port}.patched.xctestrun");

    // Copy original to patched location
    tokio::fs::copy(xctestrun_path, &patched_path)
        .await
        .context("Failed to copy xctestrun file")?;

    let base = "TestConfigurations:0:TestTargets:0";
    let plist_buddy = "/usr/libexec/PlistBuddy";

    // PlistBuddy "Add" fails if the key already exists, which leaves stale
    // values from a previous run. Use "Delete" then "Add" for each key so we
    // always write the current values. Delete failures (key doesn't exist) are
    // expected and harmless.
    let keys: Vec<(String, String)> = {
        let mut k = vec![
            (
                format!(":{base}:UITargetAppBundleIdentifier"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:EnvironmentVariables:PILOT_TARGET_BUNDLE_ID"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:EnvironmentVariables:PILOT_AGENT_PORT"),
                format!("string {agent_port}"),
            ),
            (
                format!(":{base}:TestingEnvironmentVariables:PILOT_TARGET_BUNDLE_ID"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:TestingEnvironmentVariables:PILOT_AGENT_PORT"),
                format!("string {agent_port}"),
            ),
        ];
        if attach_to_running_app {
            k.push((
                format!(":{base}:EnvironmentVariables:PILOT_ATTACH_TO_RUNNING_APP"),
                "string 1".to_string(),
            ));
            k.push((
                format!(":{base}:TestingEnvironmentVariables:PILOT_ATTACH_TO_RUNNING_APP"),
                "string 1".to_string(),
            ));
        }
        k
    };

    // First pass: delete all keys (failures are expected if keys don't exist yet)
    let mut del_cmd = tokio::process::Command::new(plist_buddy);
    for (key, _) in &keys {
        del_cmd.arg("-c").arg(format!("Delete {key}"));
    }
    del_cmd.arg(&patched_path);
    let _ = del_cmd.output().await;

    // Second pass: add all keys (failures here are real errors)
    let mut add_cmd = tokio::process::Command::new(plist_buddy);
    for (key, type_and_value) in &keys {
        add_cmd.arg("-c").arg(format!("Add {key} {type_and_value}"));
    }
    add_cmd.arg(&patched_path);
    let output = add_cmd.output().await.context("Failed to run PlistBuddy")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("PlistBuddy failed to patch xctestrun: {stderr}");
    }

    info!("Patched xctestrun at {patched_path}");
    Ok(patched_path)
}

/// Ping the iOS agent to check if it's running.
async fn ping_agent(port: u16) -> Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let stream = tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow::anyhow!("Connection timeout"))?
        .context("Failed to connect")?;

    // Send a ping command
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);

    let ping_msg = r#"{"id":"ping","method":"ping","params":{}}"#;
    writer.write_all(format!("{ping_msg}\n").as_bytes()).await?;

    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(5), buf_reader.read_line(&mut response))
        .await
        .map_err(|_| anyhow::anyhow!("Ping response timeout"))??;

    if response.contains("pong") {
        Ok(())
    } else {
        bail!("Unexpected ping response: {response}")
    }
}
