use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::net::TcpStream;
use tokio::process::Command;
use tracing::{debug, info, instrument};

/// Stable per-udid DerivedData location for `xcodebuild test-without-building`.
///
/// Without `-derivedDataPath`, every invocation allocates a fresh random
/// DerivedData hash and dumps a multi-GB `.xcresult` bundle there that
/// nothing ever cleans up. Pinning to a stable per-udid location lets
/// subsequent runs reuse (and overwrite) the same directory. Per-udid keying
/// preserves isolation for parallel execution against multiple simulators.
fn derived_data_path_for(udid: &str) -> PathBuf {
    std::env::temp_dir().join("pilot-ios-derived").join(udid)
}

/// Wipe any prior xcresult bundles before launching xcodebuild.
///
/// xcodebuild always writes a *new* timestamped `Test-*.xcresult` into
/// `Logs/Test/` on each run, so without this we'd accumulate ~1.8GB per
/// invocation inside the pinned DerivedData dir. Removing the dir caps
/// total disk usage to one bundle per simulator.
///
/// A missing path is a no-op (not an error) — first run won't have one.
async fn clear_prior_xcresults(derived_data_path: &Path) -> Result<()> {
    let test_logs = derived_data_path.join("Logs").join("Test");
    match tokio::fs::remove_dir_all(&test_logs).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("Failed to clear {test_logs:?}")),
    }
}

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

    // Pin xcodebuild's output directory and wipe any prior xcresults so
    // disk usage stays bounded across runs. See helper docs for details.
    let derived_data_path = derived_data_path_for(udid);
    if let Err(e) = tokio::fs::create_dir_all(&derived_data_path).await {
        debug!("Failed to create derivedDataPath {derived_data_path:?}: {e}");
    }
    if let Err(e) = clear_prior_xcresults(&derived_data_path).await {
        debug!("{e:#}");
    }

    // Launch xcodebuild test-without-building in background
    let mut cmd = Command::new("xcodebuild");
    cmd.args([
        "test-without-building",
        "-xctestrun",
        &patched_xctestrun,
        "-destination",
        &format!("id={udid}"),
        "-derivedDataPath",
        &derived_data_path.to_string_lossy(),
    ]);

    // Capture stdout/stderr so we can diagnose failures.
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("Failed to spawn xcodebuild for iOS agent")?;

    // Spawn tasks to drain stdout/stderr, collecting the last N lines for
    // error reporting if xcodebuild exits before the agent comes up.
    // Note: we keep `child` in this scope (not moved into a wait task) so the
    // timeout path below can kill it explicitly. Without this, a 150s timeout
    // would leave xcodebuild orphaned until the next kill_existing_agents_on
    // sweep — which may not happen for a long time, or ever, on a failed run.
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

    // Wait for the agent to start accepting connections.
    // Freshly booted/cloned simulators can take 90+ seconds for xcodebuild to
    // install and launch the XCUITest runner, especially when multiple
    // xcodebuild processes compete for resources in parallel mode.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    loop {
        if tokio::time::Instant::now() > deadline {
            // Kill xcodebuild explicitly so it doesn't outlive this function.
            let _ = child.kill().await;
            let tail = stderr_tail.lock().await;
            let last_lines = tail.join("\n");
            bail!(
                "Timed out waiting for iOS agent to start on simulator {udid} after 150s. \
                 Killed xcodebuild. Check that the XCUITest bundle is built correctly.\n\
                 xcodebuild stderr (last lines):\n{last_lines}"
            );
        }

        // If xcodebuild exited, the agent won't come up — fail immediately.
        // try_wait is non-blocking and reaps the process if it has exited.
        match child.try_wait() {
            Ok(Some(status)) => {
                let tail = stderr_tail.lock().await;
                let last_lines = tail.join("\n");
                bail!(
                    "xcodebuild exited with {status} before the iOS agent became \
                     ready on simulator {udid}.\nxcodebuild stderr (last lines):\n{last_lines}"
                );
            }
            Ok(None) => {} // still running, continue probing
            Err(e) => bail!("Failed to check xcodebuild status: {e}"),
        }

        match ping_agent(agent_port).await {
            Ok(_) => {
                info!(udid, "iOS agent is ready");
                // Hand the child off to a reaper task so the kernel can collect
                // it once xcodebuild eventually exits — without this, dropping
                // the Child without awaiting leaves a zombie until process exit.
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
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

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    /// Minimal xctestrun fixture: only the keys patch_xctestrun touches must
    /// exist in the parent path. Empty EnvironmentVariables/TestingEnvironmentVariables
    /// dicts are required because PlistBuddy `Add` cannot create intermediate keys.
    const FIXTURE_EMPTY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>TestConfigurations</key>
  <array>
    <dict>
      <key>TestTargets</key>
      <array>
        <dict>
          <key>EnvironmentVariables</key>
          <dict/>
          <key>TestingEnvironmentVariables</key>
          <dict/>
        </dict>
      </array>
    </dict>
  </array>
</dict>
</plist>
"#;

    /// Same as FIXTURE_EMPTY but pre-populated with stale values, to verify
    /// the delete-then-add semantics.
    const FIXTURE_WITH_STALE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>TestConfigurations</key>
  <array>
    <dict>
      <key>TestTargets</key>
      <array>
        <dict>
          <key>UITargetAppBundleIdentifier</key>
          <string>com.stale.bundle</string>
          <key>EnvironmentVariables</key>
          <dict>
            <key>PILOT_AGENT_PORT</key>
            <string>9999</string>
            <key>PILOT_TARGET_BUNDLE_ID</key>
            <string>com.stale.bundle</string>
          </dict>
          <key>TestingEnvironmentVariables</key>
          <dict>
            <key>PILOT_AGENT_PORT</key>
            <string>9999</string>
            <key>PILOT_TARGET_BUNDLE_ID</key>
            <string>com.stale.bundle</string>
          </dict>
        </dict>
      </array>
    </dict>
  </array>
</dict>
</plist>
"#;

    async fn write_fixture(contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.xctestrun");
        tokio::fs::write(&path, contents).await.unwrap();
        (dir, path)
    }

    #[tokio::test]
    async fn patch_xctestrun_launch_mode_injects_bundle_id_and_port() {
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;

        let patched_path = patch_xctestrun(path.to_str().unwrap(), "com.example.app", false, 18800)
            .await
            .expect("patch should succeed");

        assert!(
            patched_path.ends_with(".launch.port18800.patched.xctestrun"),
            "unexpected patched path: {patched_path}"
        );
        let contents = tokio::fs::read_to_string(&patched_path).await.unwrap();
        assert!(contents.contains("com.example.app"));
        assert!(contents.contains("18800"));
        assert!(contents.contains("PILOT_AGENT_PORT"));
        assert!(contents.contains("PILOT_TARGET_BUNDLE_ID"));
        assert!(contents.contains("UITargetAppBundleIdentifier"));
        // Launch mode must NOT inject the attach flag.
        assert!(!contents.contains("PILOT_ATTACH_TO_RUNNING_APP"));
    }

    #[tokio::test]
    async fn patch_xctestrun_attach_mode_sets_attach_flag() {
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;

        let patched_path = patch_xctestrun(path.to_str().unwrap(), "com.example.app", true, 19000)
            .await
            .expect("patch should succeed");

        assert!(
            patched_path.ends_with(".attach.port19000.patched.xctestrun"),
            "unexpected patched path: {patched_path}"
        );
        let contents = tokio::fs::read_to_string(&patched_path).await.unwrap();
        assert!(contents.contains("PILOT_ATTACH_TO_RUNNING_APP"));
        assert!(contents.contains("19000"));
    }

    #[tokio::test]
    async fn patch_xctestrun_replaces_existing_env_values() {
        // Critical: a source plist that already contains stale values from a
        // previous run must be cleanly overwritten by the delete-then-add
        // sequence — otherwise the runner would keep the wrong port/bundle id.
        let (_dir, path) = write_fixture(FIXTURE_WITH_STALE).await;

        let patched_path =
            patch_xctestrun(path.to_str().unwrap(), "com.fresh.bundle", false, 18800)
                .await
                .expect("patch should succeed");

        let contents = tokio::fs::read_to_string(&patched_path).await.unwrap();
        assert!(contents.contains("com.fresh.bundle"));
        assert!(contents.contains("18800"));
        // Stale values must be gone.
        assert!(
            !contents.contains("com.stale.bundle"),
            "stale bundle id leaked into patched plist:\n{contents}"
        );
        assert!(
            !contents.contains("9999"),
            "stale port leaked into patched plist:\n{contents}"
        );
    }

    #[tokio::test]
    async fn patch_xctestrun_per_port_paths_do_not_collide() {
        // Two parallel workers using the same source xctestrun must produce
        // distinct patched files so they can't stomp on each other.
        let (_dir, path) = write_fixture(FIXTURE_EMPTY).await;
        let src = path.to_str().unwrap();

        let p1 = patch_xctestrun(src, "com.example.app", false, 18800)
            .await
            .unwrap();
        let p2 = patch_xctestrun(src, "com.example.app", false, 18801)
            .await
            .unwrap();
        let p3 = patch_xctestrun(src, "com.example.app", true, 18800)
            .await
            .unwrap();
        assert_ne!(p1, p2);
        assert_ne!(p1, p3);
        assert_ne!(p2, p3);
    }

    #[tokio::test]
    async fn patch_xctestrun_missing_source_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist.xctestrun");

        let result =
            patch_xctestrun(bogus.to_str().unwrap(), "com.example.app", false, 18800).await;
        assert!(result.is_err(), "expected error for missing source file");
    }

    #[test]
    fn derived_data_path_is_stable_per_udid() {
        // Same udid → same path on repeated calls (so xcodebuild reuses
        // the same DerivedData dir instead of leaking a fresh one each run).
        let p1 = derived_data_path_for("ABC-123");
        let p2 = derived_data_path_for("ABC-123");
        assert_eq!(p1, p2);
    }

    #[test]
    fn derived_data_path_is_distinct_per_udid() {
        // Different simulators → different paths so parallel workers don't
        // race on a shared DerivedData directory.
        let p1 = derived_data_path_for("ABC-123");
        let p2 = derived_data_path_for("DEF-456");
        assert_ne!(p1, p2);
    }

    #[test]
    fn derived_data_path_lives_under_temp() {
        // Stays out of the user's $HOME so it's auto-cleaned by the OS and
        // can't pollute Xcode's standard DerivedData dir.
        let p = derived_data_path_for("ABC-123");
        assert!(
            p.starts_with(std::env::temp_dir()),
            "expected path under temp_dir, got {p:?}"
        );
        assert!(p.ends_with("ABC-123"));
    }

    #[tokio::test]
    async fn clear_prior_xcresults_removes_existing_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let test_logs = dir.path().join("Logs").join("Test");
        let bundle = test_logs.join("Test-PilotAgentUITests-2026.04.09_12-00-00.xcresult");
        tokio::fs::create_dir_all(&bundle).await.unwrap();
        tokio::fs::write(bundle.join("Info.plist"), "fake")
            .await
            .unwrap();
        assert!(bundle.exists());

        clear_prior_xcresults(dir.path()).await.unwrap();

        assert!(
            !test_logs.exists(),
            "Logs/Test should be removed but still exists"
        );
    }

    #[tokio::test]
    async fn clear_prior_xcresults_is_noop_when_missing() {
        // First-ever run won't have a prior Logs/Test dir; this must not
        // surface as an error or the agent launch path would fail.
        let dir = tempfile::tempdir().unwrap();
        clear_prior_xcresults(dir.path())
            .await
            .expect("missing path should be a no-op");
    }
}
