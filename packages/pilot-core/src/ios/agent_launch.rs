use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::net::TcpStream;
use tokio::process::Command;
use tracing::{debug, info, instrument};

/// Port the iOS agent listens on.
const AGENT_PORT: u16 = 18700;

/// Launch the PilotAgent XCUITest runner on an iOS simulator.
///
/// This is the iOS equivalent of Android's `am instrument -w dev.pilot.agent/.PilotAgent`.
/// It runs `xcodebuild test-without-building` with the prebuilt .xctestrun file.
///
/// Environment variables and the target app bundle ID must be injected into the
/// `.xctestrun` plist (not the xcodebuild process env) because XCUITest reads its
/// configuration exclusively from that file.
#[instrument(skip(xctestrun_path, target_bundle_id))]
pub async fn start_agent(udid: &str, xctestrun_path: &str, target_bundle_id: &str) -> Result<()> {
    start_agent_impl(udid, xctestrun_path, target_bundle_id, false).await
}

/// Start the agent, optionally forcing a fresh launch even if an agent
/// appears to be running on the port. Used after kill_existing_agents
/// where the stale runner may still briefly respond to pings.
pub async fn start_agent_fresh(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
) -> Result<()> {
    start_agent_impl(udid, xctestrun_path, target_bundle_id, true).await
}

async fn start_agent_impl(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    force: bool,
) -> Result<()> {
    // Check if agent is already running by trying to connect
    if !force && ping_agent().await.is_ok() {
        info!("iOS agent is already running");
        return Ok(());
    }

    info!(udid, xctestrun_path, "Starting iOS agent via xcodebuild");

    // Patch the xctestrun file to inject target bundle ID and env vars.
    // xcodebuild process env vars don't reach the XCUITest runner — they must
    // be in the plist's EnvironmentVariables / TestingEnvironmentVariables dicts.
    let patched_xctestrun = patch_xctestrun(xctestrun_path, target_bundle_id)
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

    // Spawn a task to drain stdout/stderr and log it
    let mut child = child;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
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
            }
        }
    });

    // Wait for the agent to start accepting connections
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if tokio::time::Instant::now() > deadline {
            bail!(
                "Timed out waiting for iOS agent to start on simulator {udid}. \
                 Check that the XCUITest bundle is built correctly."
            );
        }

        match ping_agent().await {
            Ok(_) => {
                info!(udid, "iOS agent is ready");
                return Ok(());
            }
            Err(_) => {
                debug!("Agent not ready yet, retrying...");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// Kill any existing xcodebuild test-without-building processes and the agent.
/// Called before restarting the agent in launchApp/restartApp.
///
/// Kills both the host-side xcodebuild process AND the simulator-side runner
/// app. Without killing the runner app, it keeps listening on port 18700 and
/// `start_agent` would skip launching a new one.
pub async fn kill_existing_agents_on(udid: &str) {
    // Kill host-side xcodebuild
    let _ = Command::new("pkill")
        .args(["-f", "xcodebuild test-without-building"])
        .output()
        .await;

    // Kill the runner app on the simulator — xcrun simctl terminate
    // targets the simulator process, not the host. The runner's bundle ID
    // is set in the Xcode project (dev.pilot.agent.xctrunner).
    let _ = Command::new("xcrun")
        .args(["simctl", "terminate", udid, "dev.pilot.agent.xctrunner"])
        .output()
        .await;

    // Brief pause for processes to die and port 18700 to be released
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
async fn patch_xctestrun(xctestrun_path: &str, target_bundle_id: &str) -> Result<String> {
    let patched_path = format!("{xctestrun_path}.patched.xctestrun");

    // Copy original to patched location
    tokio::fs::copy(xctestrun_path, &patched_path)
        .await
        .context("Failed to copy xctestrun file")?;

    let base = "TestConfigurations:0:TestTargets:0";
    let plist_buddy = "/usr/libexec/PlistBuddy";

    // PlistBuddy "Add" fails if key exists, so we use it for new keys and
    // accept non-zero exit (some keys may already exist from a previous run).
    let commands = vec![
        format!("Add :{base}:UITargetAppBundleIdentifier string {target_bundle_id}"),
        format!("Add :{base}:EnvironmentVariables:PILOT_TARGET_BUNDLE_ID string {target_bundle_id}"),
        format!("Add :{base}:EnvironmentVariables:PILOT_AGENT_PORT string {AGENT_PORT}"),
        format!("Add :{base}:TestingEnvironmentVariables:PILOT_TARGET_BUNDLE_ID string {target_bundle_id}"),
        format!("Add :{base}:TestingEnvironmentVariables:PILOT_AGENT_PORT string {AGENT_PORT}"),
    ];

    let mut cmd = std::process::Command::new(plist_buddy);
    for c in &commands {
        cmd.arg("-c").arg(c);
    }
    cmd.arg(&patched_path);

    let output = cmd.output().context("Failed to run PlistBuddy")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // PlistBuddy returns non-zero if any command fails (e.g. key already exists).
        // Log but don't fail — the key may already be set from a previous run.
        debug!("PlistBuddy warnings (may be benign): {stderr}");
    }

    info!("Patched xctestrun at {patched_path}");
    Ok(patched_path)
}

/// Ping the iOS agent to check if it's running.
async fn ping_agent() -> Result<()> {
    let addr = format!("127.0.0.1:{AGENT_PORT}");
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
