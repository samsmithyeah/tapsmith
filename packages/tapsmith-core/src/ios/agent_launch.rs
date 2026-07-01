use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::net::TcpStream;
use tokio::process::Command;
use tracing::{debug, info, instrument, warn};

use super::iproxy::{kill_stray_iproxy, IproxyHandle};

/// Stable per-udid DerivedData location for `xcodebuild test-without-building`.
///
/// Without `-derivedDataPath`, every invocation allocates a fresh random
/// DerivedData hash and dumps a multi-GB `.xcresult` bundle there that
/// nothing ever cleans up. Pinning to a stable per-udid location lets
/// subsequent runs reuse (and overwrite) the same directory. Per-udid keying
/// preserves isolation for parallel execution against multiple simulators.
fn derived_data_path_for(udid: &str) -> PathBuf {
    std::env::temp_dir().join("tapsmith-ios-derived").join(udid)
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

/// Launch the TapsmithAgent XCUITest runner on an iOS simulator or physical device.
///
/// This is the iOS equivalent of Android's `am instrument -w dev.tapsmith.agent/.TapsmithAgent`.
/// It runs `xcodebuild test-without-building` with the prebuilt .xctestrun file.
///
/// Environment variables and the target app bundle ID must be injected into the
/// `.xctestrun` plist (not the xcodebuild process env) because XCUITest reads its
/// configuration exclusively from that file.
///
/// Returns `Some(IproxyHandle)` for physical devices — the caller must store
/// the handle for the lifetime of the agent so the USB tunnel stays alive.
/// For simulators (and for the fast-path case where an existing agent is
/// already responding) returns `None` and the caller keeps any existing
/// tracking state unchanged.
#[instrument(skip(xctestrun_path, target_bundle_id))]
pub async fn start_agent(
    udid: &str,
    xctestrun_path: &str,
    target_bundle_id: &str,
    agent_port: u16,
    is_physical: bool,
) -> Result<Option<IproxyHandle>> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        false,
        false,
        agent_port,
        is_physical,
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
    is_physical: bool,
) -> Result<Option<IproxyHandle>> {
    start_agent_impl(
        udid,
        xctestrun_path,
        target_bundle_id,
        true,
        true,
        agent_port,
        is_physical,
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
    is_physical: bool,
) -> Result<Option<IproxyHandle>> {
    let boot_start = std::time::Instant::now();
    // Check if agent is already running by trying to connect
    if !force && ping_agent(agent_port).await.is_ok() {
        info!("iOS agent is already running");
        crate::timing::timing_log!(
            "kind=boot name=agent dur_ms={} reused=true udid={udid}",
            boot_start.elapsed().as_millis()
        );
        // For physical devices, pingable-on-localhost means the caller's
        // iproxy tunnel is still up; no new handle is returned and the
        // caller's existing stored state remains authoritative.
        return Ok(None);
    }

    // Kill any stale xcodebuild processes targeting this device/simulator before
    // starting a new one. Without this, leftover processes from a previous
    // run can hold the port or interfere with the new agent launch.
    kill_existing_agents_on(udid).await;
    if is_physical {
        // Sweep stale iproxy tunnels keyed to this UDID/port so the host
        // port is free before we spawn a fresh one.
        kill_stray_iproxy(udid, agent_port, agent_port).await;
    }

    info!(
        udid,
        xctestrun_path, agent_port, is_physical, "Starting iOS agent via xcodebuild"
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

    // For physical devices, start the USB tunnel BEFORE xcodebuild so a
    // missing libimobiledevice / wrong UDID / stale port fails fast in ~250ms
    // instead of after the ~60s xcodebuild warmup. The tunnel forwards the
    // host's `agent_port` to the same port on the device, where the XCUITest
    // runner will bind its socket once it finishes launching.
    let iproxy_handle = if is_physical {
        Some(
            IproxyHandle::start(udid.to_string(), agent_port, agent_port)
                .await
                .context("Failed to start iproxy USB tunnel for physical iOS device")?,
        )
    } else {
        None
    };

    // Launch xcodebuild test-without-building in background.
    let (mut child, mut stdout_tail, mut stderr_tail) =
        spawn_agent_xcodebuild(&patched_xctestrun, udid, &derived_data_path)?;

    // Wait for the agent to start accepting connections.
    // Freshly booted/cloned simulators can take 90+ seconds for xcodebuild to
    // install and launch the XCUITest runner, especially when multiple
    // xcodebuild processes compete for resources in parallel mode. Physical
    // devices on first run may also trigger a Developer Disk Image mount which
    // adds ~30s to the first-ever invocation — 150s still covers it.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(150);
    // xcodebuild occasionally crashes or exits early on contended CI runners.
    // One in-place relaunch (budget permitting) recovers that case without a
    // full RPC round trip; the first attempt has usually warmed the simulator.
    let mut relaunches_left: u32 = 1;
    loop {
        if tokio::time::Instant::now() > deadline {
            // Kill xcodebuild explicitly so it doesn't outlive this function.
            let _ = child.kill().await;
            // Drop the iproxy handle (if any) so the host port is freed before
            // returning. `drop(iproxy_handle)` is explicit rather than letting
            // scope-drop do it so reviewers can see the cleanup point.
            drop(iproxy_handle);
            let out_lines = stdout_tail.lock().unwrap().join("\n");
            let err_lines = stderr_tail.lock().unwrap().join("\n");
            let target_kind = if is_physical { "device" } else { "simulator" };
            bail!(
                "Timed out waiting for iOS agent to start on {target_kind} {udid} after 150s. \
                 Killed xcodebuild. Check that the XCUITest bundle is built correctly.\n\
                 xcodebuild output (last lines):\n{out_lines}\n\
                 xcodebuild stderr (last lines):\n{err_lines}"
            );
        }

        // If xcodebuild exited, the agent won't come up on this launch.
        // try_wait is non-blocking and reaps the process if it has exited.
        match child.try_wait() {
            Ok(Some(status)) => {
                let out_lines = stdout_tail.lock().unwrap().join("\n");
                let err_lines = stderr_tail.lock().unwrap().join("\n");
                let target_kind = if is_physical { "device" } else { "simulator" };
                let remaining = deadline - tokio::time::Instant::now();
                if relaunches_left > 0 && remaining > Duration::from_secs(30) {
                    relaunches_left -= 1;
                    warn!(
                        udid,
                        %status,
                        "xcodebuild exited before the iOS agent became ready; relaunching once.\n\
                         xcodebuild output (last lines):\n{out_lines}\n\
                         xcodebuild stderr (last lines):\n{err_lines}"
                    );
                    kill_existing_agents_on(udid).await;
                    (child, stdout_tail, stderr_tail) =
                        spawn_agent_xcodebuild(&patched_xctestrun, udid, &derived_data_path)?;
                    continue;
                }
                drop(iproxy_handle);
                bail!(
                    "xcodebuild exited with {status} before the iOS agent became \
                     ready on {target_kind} {udid}.\n\
                     xcodebuild output (last lines):\n{out_lines}\n\
                     xcodebuild stderr (last lines):\n{err_lines}"
                );
            }
            Ok(None) => {} // still running, continue probing
            Err(e) => {
                drop(iproxy_handle);
                bail!("Failed to check xcodebuild status: {e}");
            }
        }

        match ping_agent(agent_port).await {
            Ok(_) => {
                info!(udid, "iOS agent is ready");
                crate::timing::timing_log!(
                    "kind=boot name=agent dur_ms={} reused=false udid={udid}",
                    boot_start.elapsed().as_millis()
                );
                // Hand the child off to a reaper task so the kernel can collect
                // it once xcodebuild eventually exits — without this, dropping
                // the Child without awaiting leaves a zombie until process exit.
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Ok(iproxy_handle);
            }
            Err(_) => {
                debug!("Agent not ready yet, retrying...");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

type OutputTail = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

/// Spawn `xcodebuild test-without-building` for the agent and drain its
/// stdout/stderr into rolling 20-line tails for error reporting.
///
/// The child is returned (not moved into a wait task) so the caller's timeout
/// path can kill it explicitly. Without this, a timeout would leave xcodebuild
/// orphaned until the next kill_existing_agents_on sweep — which may not
/// happen for a long time, or ever, on a failed run.
fn spawn_agent_xcodebuild(
    patched_xctestrun: &str,
    udid: &str,
    derived_data_path: &std::path::Path,
) -> Result<(tokio::process::Child, OutputTail, OutputTail)> {
    use std::sync::{Arc, Mutex};

    let mut cmd = Command::new("xcodebuild");
    cmd.args([
        "test-without-building",
        "-xctestrun",
        patched_xctestrun,
        "-destination",
        &format!("id={udid}"),
        "-derivedDataPath",
        &derived_data_path.to_string_lossy(),
    ]);

    // Capture stdout/stderr so we can diagnose failures.
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("Failed to spawn xcodebuild for iOS agent")?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stderr_tail: OutputTail = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail_writer = stderr_tail.clone();
    let stdout_tail: OutputTail = Arc::new(Mutex::new(Vec::new()));
    let stdout_tail_writer = stdout_tail.clone();

    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild", "{}", line);
                let mut tail = stdout_tail_writer.lock().unwrap();
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!(target: "xcodebuild::stderr", "{}", line);
                let mut tail = stderr_tail_writer.lock().unwrap();
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    });

    Ok((child, stdout_tail, stderr_tail))
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
    // is set in the Xcode project (dev.tapsmith.agent.xctrunner).
    let _ = Command::new("xcrun")
        .args(["simctl", "terminate", udid, "dev.tapsmith.agent.xctrunner"])
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
    // Normalize the source path: strip any `.{mode}.port{N}.patched.xctestrun`
    // suffixes left behind by previous runs so we don't keep accreting suffixes
    // until the filename overflows the 255-byte limit.
    let source_root = strip_patched_suffixes(xctestrun_path);
    let patched_path = format!("{source_root}.{mode}.port{agent_port}.patched.xctestrun");

    // Copy original to patched location
    tokio::fs::copy(xctestrun_path, &patched_path)
        .await
        .context("Failed to copy xctestrun file")?;

    // Resolve __TAPSMITH_PKG__ placeholders left by the prebuilt npm packages.
    // These replace the CI machine's absolute DerivedData paths at package time;
    // here we substitute the actual directory containing the xctestrun file so
    // xcodebuild can find the test runner .app bundle at runtime.
    resolve_pkg_placeholders(&patched_path, xctestrun_path).await?;

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
                format!(":{base}:EnvironmentVariables:TAPSMITH_TARGET_BUNDLE_ID"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:EnvironmentVariables:TAPSMITH_AGENT_PORT"),
                format!("string {agent_port}"),
            ),
            (
                format!(":{base}:TestingEnvironmentVariables:TAPSMITH_TARGET_BUNDLE_ID"),
                format!("string {target_bundle_id}"),
            ),
            (
                format!(":{base}:TestingEnvironmentVariables:TAPSMITH_AGENT_PORT"),
                format!("string {agent_port}"),
            ),
        ];
        if attach_to_running_app {
            k.push((
                format!(":{base}:EnvironmentVariables:TAPSMITH_ATTACH_TO_RUNNING_APP"),
                "string 1".to_string(),
            ));
            k.push((
                format!(":{base}:TestingEnvironmentVariables:TAPSMITH_ATTACH_TO_RUNNING_APP"),
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

/// Replace `__TAPSMITH_PKG__` placeholders in a patched xctestrun plist with the
/// directory that contains the original (unpatched) xctestrun. The prebuilt npm
/// packages use this placeholder to avoid baking in CI-machine absolute paths.
///
/// Uses the `plist` crate to parse and rewrite the plist properly, avoiding XML
/// entity-escaping issues that raw text replacement would hit if the resolved
/// path contained `&`, `<`, or `>`.
async fn resolve_pkg_placeholders(patched_path: &str, original_path: &str) -> Result<()> {
    let bytes = tokio::fs::read(patched_path)
        .await
        .context("Failed to read patched xctestrun")?;
    if !bytes.windows(16).any(|w| w == b"__TAPSMITH_PKG__") {
        return Ok(());
    }

    let pkg_dir = std::path::Path::new(original_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut value: plist::Value =
        plist::from_bytes(&bytes).context("Failed to parse xctestrun plist")?;

    if replace_in_plist_value(&mut value, "__TAPSMITH_PKG__", &pkg_dir) {
        let mut buf = Vec::new();
        plist::to_writer_xml(&mut buf, &value).context("Failed to serialize plist")?;
        tokio::fs::write(patched_path, buf)
            .await
            .context("Failed to write resolved xctestrun")?;
        info!("Resolved __TAPSMITH_PKG__ → {pkg_dir}");
    }

    Ok(())
}

fn replace_in_plist_value(v: &mut plist::Value, from: &str, to: &str) -> bool {
    match v {
        plist::Value::String(s) if s.contains(from) => {
            *s = s.replace(from, to);
            true
        }
        plist::Value::Array(arr) => {
            let mut changed = false;
            for item in arr.iter_mut() {
                changed |= replace_in_plist_value(item, from, to);
            }
            changed
        }
        plist::Value::Dictionary(dict) => {
            let mut changed = false;
            for item in dict.values_mut() {
                changed |= replace_in_plist_value(item, from, to);
            }
            changed
        }
        _ => false,
    }
}

/// Strip any `.{mode}.port{N}.patched.xctestrun` suffixes that previous runs
/// may have appended, returning the original source path (or the input
/// unchanged if it doesn't look patched). Conservative: only matches the exact
/// suffix pattern Tapsmith itself generates.
fn strip_patched_suffixes(path: &str) -> String {
    let mut current = path.to_string();
    loop {
        let Some(stripped) = current.strip_suffix(".patched.xctestrun") else {
            return current;
        };
        // Match `.launch.portNNNN` or `.attach.portNNNN`
        let Some(dot_idx) = stripped.rfind('.') else {
            return current;
        };
        let port_segment = &stripped[dot_idx + 1..];
        if !port_segment.starts_with("port")
            || port_segment.len() <= 4
            || !port_segment[4..].chars().all(|c| c.is_ascii_digit())
        {
            return current;
        }
        let without_port = &stripped[..dot_idx];
        let Some(mode_idx) = without_port.rfind('.') else {
            return current;
        };
        let mode_segment = &without_port[mode_idx + 1..];
        if mode_segment != "launch" && mode_segment != "attach" {
            return current;
        }
        current = without_port[..mode_idx].to_string();
    }
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
            <key>TAPSMITH_AGENT_PORT</key>
            <string>9999</string>
            <key>TAPSMITH_TARGET_BUNDLE_ID</key>
            <string>com.stale.bundle</string>
          </dict>
          <key>TestingEnvironmentVariables</key>
          <dict>
            <key>TAPSMITH_AGENT_PORT</key>
            <string>9999</string>
            <key>TAPSMITH_TARGET_BUNDLE_ID</key>
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
        assert!(contents.contains("TAPSMITH_AGENT_PORT"));
        assert!(contents.contains("TAPSMITH_TARGET_BUNDLE_ID"));
        assert!(contents.contains("UITargetAppBundleIdentifier"));
        // Launch mode must NOT inject the attach flag.
        assert!(!contents.contains("TAPSMITH_ATTACH_TO_RUNNING_APP"));
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
        assert!(contents.contains("TAPSMITH_ATTACH_TO_RUNNING_APP"));
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
    fn strip_patched_suffixes_handles_clean_path() {
        let p = "/tmp/Foo.xctestrun";
        assert_eq!(strip_patched_suffixes(p), p);
    }

    #[test]
    fn strip_patched_suffixes_strips_single_suffix() {
        assert_eq!(
            strip_patched_suffixes("/tmp/Foo.xctestrun.launch.port18800.patched.xctestrun"),
            "/tmp/Foo.xctestrun"
        );
        assert_eq!(
            strip_patched_suffixes("/tmp/Foo.xctestrun.attach.port19000.patched.xctestrun"),
            "/tmp/Foo.xctestrun"
        );
    }

    #[test]
    fn strip_patched_suffixes_strips_chained_suffixes() {
        let chained =
            "/tmp/Foo.xctestrun.launch.port18800.patched.xctestrun.launch.port18802.patched.xctestrun";
        assert_eq!(strip_patched_suffixes(chained), "/tmp/Foo.xctestrun");
    }

    #[test]
    fn strip_patched_suffixes_leaves_unrecognized_alone() {
        // Wrong mode word — must not strip.
        let p = "/tmp/Foo.xctestrun.weird.port18800.patched.xctestrun";
        assert_eq!(strip_patched_suffixes(p), p);
        // Non-numeric port — must not strip.
        let q = "/tmp/Foo.xctestrun.launch.portABC.patched.xctestrun";
        assert_eq!(strip_patched_suffixes(q), q);
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
        let bundle = test_logs.join("Test-TapsmithAgentUITests-2026.04.09_12-00-00.xcresult");
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
