//! PILOT-182 — iOS Network Extension redirector lifecycle.
//!
//! Spawns the `Mitmproxy Redirector.app` launcher, accepts the control
//! channel from the System Extension, sends a per-simulator PID
//! `InterceptConf`, and bridges every intercepted TCP flow into
//! [`crate::network_proxy::handle_transparent_tcp`]. A background refresh
//! task polls `ps` every [`PID_REFRESH_INTERVAL`] and pushes an updated
//! `InterceptConf` if the simulator's process tree has changed.
//!
//! The lifecycle is anchored by the [`IosRedirect`] handle; dropping it
//! aborts the refresh, accept, and launcher-drain tasks and unlinks the
//! Unix socket file. The System Extension itself is a macOS system-wide
//! singleton and is NOT torn down — other Pilot daemons (concurrent workers
//! against other simulators) continue to use it independently.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use futures_util::SinkExt;
use prost::Message;
use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tracing::{debug, error, info, warn};

use crate::ios::simulator_processes;
use crate::ipc;
use crate::mitm_ca::MitmAuthority;
use crate::network_proxy::{handle_transparent_tcp, ProxyState};

/// How often the PID refresh task re-queries `ps` and pushes a new
/// `InterceptConf` if the simulator's process tree has changed. Short enough
/// to catch newly-spawned test-app child processes before they race through
/// a quick HTTP call; long enough to keep the `ps` cost negligible.
const PID_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

/// Max size of a `NewFlow` proto handshake. The real protocol messages are
/// only a few bytes; this cap rejects anything pathological.
const NEW_FLOW_MAX_LEN: usize = 64 * 1024;

/// How long to wait for the System Extension to connect back to our
/// listener after spawning the launcher binary.
const CONTROL_CHANNEL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for a write to the SE control channel before giving up.
/// Guards against hangs if the SE stops draining its side (crash, suspension,
/// kernel quirk) — without this, the refresh task and the initial conf send
/// on the startup fast path could block indefinitely.
const CONTROL_CHANNEL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// Handle to a running redirector session. Dropping it aborts the
/// background tasks and unlinks the Unix socket file.
pub struct IosRedirect {
    accept_handle: JoinHandle<()>,
    refresh_handle: JoinHandle<()>,
    launcher_handle: JoinHandle<()>,
    listener_path: PathBuf,
}

impl IosRedirect {
    /// Bring up a redirector session for a specific simulator UDID.
    ///
    /// 1. Resolves the simulator's initial PID set via
    ///    [`simulator_processes::resolve_simulator_pids`].
    /// 2. Binds a per-daemon Unix listener at
    ///    `/tmp/pilot-redirector-<daemon-pid>.sock` (unlinking any stale
    ///    file left over from a SIGKILL'd previous daemon).
    /// 3. Spawns the `Mitmproxy Redirector.app` launcher binary, telling it
    ///    where to connect. The launcher is a short-lived helper that
    ///    hands our listener path to the System Extension and then exits
    ///    cleanly with status 0.
    /// 4. Accepts the control-channel connection from the SE (10 s timeout).
    /// 5. Sends the initial `InterceptConf` over the control channel,
    ///    wrapped in the length-delimited framing that the SE expects.
    /// 6. Spawns the background refresh task (owns the control channel and
    ///    periodically updates the PID filter).
    /// 7. Spawns the background accept task (owns the listener and routes
    ///    every new flow connection into
    ///    [`handle_transparent_tcp`]).
    ///
    /// Returns only after the SE has connected back and accepted the
    /// initial `InterceptConf` — so the caller can rely on the filter
    /// being active before the first test action runs.
    pub async fn start(
        udid: String,
        proxy_state: Arc<Mutex<ProxyState>>,
        mitm_ca: Arc<MitmAuthority>,
    ) -> Result<Self> {
        let initial_pids = simulator_processes::resolve_simulator_pids(&udid)
            .await
            .context("resolving initial simulator PID set")?;
        if initial_pids.is_empty() {
            warn!(%udid, "no simulator processes found — InterceptConf will be empty");
        } else {
            debug!(%udid, pids = initial_pids.len(), "resolved initial simulator PID set");
        }

        // The Unix socket MUST live in `/tmp`, not under the per-user
        // `$TMPDIR` (`/var/folders/<xxx>/T/`). The macOS System Extension
        // runs in a different security domain than the calling user's
        // shell and cannot reach per-user TMPDIR paths — trying to bind
        // there silently causes the SE to never connect, and we time out
        // on the control channel accept. `mitmproxy_rs` upstream uses
        // `/tmp/mitmproxy-<pid>` for the same reason.
        //
        // The pid suffix is still unique per worker daemon, so concurrent
        // workers don't collide. The theoretical symlink-planting risk of
        // a world-writable `/tmp` is not relevant to our threat model
        // (developer machine, single user) — and `remove_file` before
        // `bind` below closes the narrow pre-creation window.
        let listener_path =
            PathBuf::from(format!("/tmp/pilot-redirector-{}.sock", std::process::id()));
        if let Err(e) = std::fs::remove_file(&listener_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e).with_context(|| {
                    format!("removing stale Unix socket at {}", listener_path.display())
                });
            }
        }
        let listener = UnixListener::bind(&listener_path)
            .with_context(|| format!("binding listener at {}", listener_path.display()))?;

        let redirector_bin =
            resolve_redirector_path().context("locating Mitmproxy Redirector.app")?;
        info!(
            redirector = %redirector_bin.display(),
            listener = %listener_path.display(),
            "spawning redirector launcher"
        );

        // The launcher binary is a short-lived process that tells the SE
        // where to dial, then exits with status 0. Its stdout/stderr are
        // drained in a background task for diagnostics. We do NOT wait for
        // its exit here — we wait for the SE to connect back to our listener,
        // which is the real signal that the session is alive. The handle is
        // tracked so `Drop` can abort it if we're torn down before it exits.
        let launcher_path = listener_path.clone();
        let launcher_handle = tokio::spawn(async move {
            let out = Command::new(&redirector_bin)
                .arg(&launcher_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await;
            match out {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    if !stdout.trim().is_empty() {
                        info!("[redirector/stdout] {}", stdout.trim());
                    }
                    if !stderr.trim().is_empty() {
                        info!("[redirector/stderr] {}", stderr.trim());
                    }
                    if !out.status.success() {
                        warn!("redirector launcher exited with {:?}", out.status);
                    } else {
                        debug!("redirector launcher exited cleanly");
                    }
                }
                Err(e) => error!("failed to spawn redirector launcher: {e}"),
            }
        });

        let (control_stream, _) = timeout(CONTROL_CHANNEL_TIMEOUT, listener.accept())
            .await
            .context("timed out waiting for System Extension to connect")?
            .context("accepting System Extension control channel")?;
        debug!("System Extension control channel connected");

        let mut control = Framed::new(control_stream, LengthDelimitedCodec::new());
        send_intercept_conf(&mut control, &initial_pids)
            .await
            .context("sending initial InterceptConf")?;
        debug!(pids = initial_pids.len(), "initial InterceptConf accepted");

        // Refresh task owns the control channel for the remainder of the
        // session. It polls `ps` every PID_REFRESH_INTERVAL and writes a
        // new InterceptConf iff the PID set has changed.
        let refresh_udid = udid.clone();
        let refresh_handle = tokio::spawn(async move {
            pid_refresh_loop(refresh_udid, control, initial_pids).await;
        });

        // Accept task owns the listener and spawns one per-flow handler
        // task for every intercepted connection from the SE.
        let accept_handle = tokio::spawn(async move {
            accept_flow_loop(listener, proxy_state, mitm_ca).await;
        });

        Ok(Self {
            accept_handle,
            refresh_handle,
            launcher_handle,
            listener_path,
        })
    }
}

impl Drop for IosRedirect {
    fn drop(&mut self) {
        self.accept_handle.abort();
        self.refresh_handle.abort();
        self.launcher_handle.abort();
        if let Err(e) = std::fs::remove_file(&self.listener_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                debug!(
                    path = %self.listener_path.display(),
                    "failed to unlink Unix socket on drop: {e}"
                );
            }
        }
    }
}

/// Encode and write an `InterceptConf` with the given PIDs to the SE's
/// control channel. The PIDs are sent as decimal-string actions, which the
/// SE matches exactly against each flow's originating PID.
///
/// Wrapped in [`CONTROL_CHANNEL_WRITE_TIMEOUT`] — a stuck SE (crash,
/// suspension, kernel quirk) must never block the caller indefinitely. The
/// initial send from [`IosRedirect::start`] is on the startup fast path and
/// the refresh-loop send runs every two seconds, so any hang would propagate
/// directly into the test runner.
async fn send_intercept_conf(
    control: &mut Framed<UnixStream, LengthDelimitedCodec>,
    pids: &[u32],
) -> Result<()> {
    let conf = ipc::InterceptConf {
        actions: pids.iter().map(|p| p.to_string()).collect(),
    };
    let bytes = Bytes::from(conf.encode_to_vec());
    match timeout(CONTROL_CHANNEL_WRITE_TIMEOUT, control.send(bytes)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e).context("writing InterceptConf to control channel"),
        Err(_) => bail!(
            "timed out writing InterceptConf to SE control channel after {}s",
            CONTROL_CHANNEL_WRITE_TIMEOUT.as_secs()
        ),
    }
}

/// Loop forever: every [`PID_REFRESH_INTERVAL`], re-resolve the simulator's
/// PID tree and push a new `InterceptConf` if the set has changed.
///
/// Exits when (a) the refresh task is aborted by `IosRedirect::drop`, or
/// (b) the control channel write fails (typically because the SE closed
/// its side, which happens if the whole daemon is tearing down).
async fn pid_refresh_loop(
    udid: String,
    mut control: Framed<UnixStream, LengthDelimitedCodec>,
    initial_pids: Vec<u32>,
) {
    let mut last: HashSet<u32> = initial_pids.into_iter().collect();
    let mut interval = tokio::time::interval(PID_REFRESH_INTERVAL);
    // Delay missed ticks rather than bunching them — a slow `ps` under load
    // shouldn't cause a tight-loop burst of refreshes catching up.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate initial tick — the caller already sent the
    // initial InterceptConf.
    interval.tick().await;

    loop {
        interval.tick().await;
        let pids = match simulator_processes::resolve_simulator_pids(&udid).await {
            Ok(p) => p,
            Err(e) => {
                warn!(%udid, "PID refresh failed: {e}");
                continue;
            }
        };
        let next: HashSet<u32> = pids.iter().copied().collect();
        if next == last {
            continue;
        }
        debug!(
            %udid,
            added = next.difference(&last).count(),
            removed = last.difference(&next).count(),
            total = next.len(),
            "updating InterceptConf"
        );
        if let Err(e) = send_intercept_conf(&mut control, &pids).await {
            warn!(%udid, "InterceptConf update failed: {e}");
            return;
        }
        last = next;
    }
}

/// Loop forever: accept new Unix socket connections from the SE (each is
/// one intercepted flow) and spawn a per-flow handler task.
///
/// Exits when the listener is dropped by `IosRedirect::drop` (the aborted
/// task's owned values are released on panic, which drops the listener).
async fn accept_flow_loop(
    listener: UnixListener,
    proxy_state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let state = proxy_state.clone();
                let ca = mitm_ca.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_flow(stream, state, ca).await {
                        debug!("flow handler error: {e:#}");
                    }
                });
            }
            Err(e) => {
                debug!("flow accept loop exiting: {e}");
                return;
            }
        }
    }
}

/// Decode the length-prefixed `NewFlow` proto handshake from an accepted
/// flow connection, then hand the rest of the stream to the transparent-
/// TCP MITM handler. UDP flows are logged and dropped (out of scope for
/// PILOT-182; can be revisited when QUIC/DNS capture is on the roadmap).
async fn handle_flow(
    mut stream: UnixStream,
    proxy_state: Arc<Mutex<ProxyState>>,
    mitm_ca: Arc<MitmAuthority>,
) -> Result<()> {
    // Manual u32_be + read_exact (not Framed::into_inner) — avoids the
    // codec-buffer-leftover hazard. After this, `stream` is positioned
    // exactly at the first TCP byte with nothing buffered.
    let len = stream.read_u32().await.context("reading NewFlow length")? as usize;
    if len > NEW_FLOW_MAX_LEN {
        bail!("NewFlow handshake too large: {len} bytes");
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .context("reading NewFlow body")?;
    let new_flow = ipc::NewFlow::decode(&*buf).context("decoding NewFlow")?;

    let Some(msg) = new_flow.message else {
        bail!("NewFlow.message missing oneof");
    };

    match msg {
        ipc::new_flow::Message::Tcp(tcp) => {
            let remote = tcp
                .remote_address
                .context("TcpFlow.remote_address missing")?;
            let tunnel = tcp.tunnel_info.unwrap_or_default();
            debug!(
                host = %remote.host,
                port = remote.port,
                pid = ?tunnel.pid,
                process = ?tunnel.process_name,
                "intercepted TCP flow"
            );
            handle_transparent_tcp(
                stream,
                remote.host,
                remote.port as u16,
                proxy_state,
                mitm_ca,
            )
            .await;
            Ok(())
        }
        ipc::new_flow::Message::Udp(udp) => {
            let tunnel = udp.tunnel_info.unwrap_or_default();
            debug!(
                pid = ?tunnel.pid,
                process = ?tunnel.process_name,
                "intercepted UDP flow — dropping (PILOT-182 scope is TCP/HTTP only)"
            );
            Ok(())
        }
    }
}

/// Locate the `Mitmproxy Redirector.app` launcher binary via a fallback
/// chain: env override → `/Applications` (mitmproxy unpacked it via sudo) →
/// cached extract under `~/.pilot/redirector/` → on-demand extract from
/// the brew cask tarball.
///
/// Returns a clear error with install instructions if none of the above
/// paths yields a usable binary.
fn resolve_redirector_path() -> Result<PathBuf> {
    // 1. Environment override (for CI, dev rigs, vendored bundles).
    if let Ok(env_path) = std::env::var("PILOT_REDIRECTOR_APP") {
        let p = PathBuf::from(env_path);
        if p.exists() {
            return Ok(p);
        }
        warn!(
            path = %p.display(),
            "PILOT_REDIRECTOR_APP set but path does not exist — trying fallbacks"
        );
    }

    // 2. /Applications/Mitmproxy Redirector.app — mitmproxy's own runtime
    //    unpack location (requires prior `sudo mitmproxy --mode local:...`).
    const APP_PATH: &str =
        "/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector";
    if Path::new(APP_PATH).exists() {
        return Ok(PathBuf::from(APP_PATH));
    }

    // 3. Cached extract from a previous brew-tar extraction.
    let cached = cached_extract_bin()?;
    if cached.exists() {
        return Ok(cached);
    }

    // 4. On-demand extract from the brew cask tarball.
    if let Some(tar_path) = find_brew_tarball() {
        extract_brew_tarball(&tar_path)
            .with_context(|| format!("extracting {}", tar_path.display()))?;
        if cached.exists() {
            return Ok(cached);
        }
    }

    let home = dirs::home_dir().unwrap_or_default();
    let cache_hint = home
        .join(".pilot/redirector/Mitmproxy Redirector.app")
        .display()
        .to_string();
    bail!(
        "Mitmproxy Redirector.app not found. Pilot searched (in order):\n\
         \n\
           1. $PILOT_REDIRECTOR_APP (if set)\n\
           2. /Applications/Mitmproxy Redirector.app\n\
           3. {cache_hint}\n\
           4. The mitmproxy brew cask tarball (not installed?)\n\
         \n\
         Install prerequisites:\n\
           brew install mitmproxy\n\
         Then one of:\n\
           a) `sudo mitmproxy --mode local:Safari` (one-time, unpacks redirector to /Applications/)\n\
           b) Re-run `pilot test` — Pilot will extract the redirector from the brew cask into {cache_hint}\n\
         \n\
         After the redirector is installed, approve its Network Extension in\n\
         System Settings → General → Login Items & Extensions → Network Extensions,\n\
         then re-run your command.\n\
         \n\
         Or set PILOT_REDIRECTOR_APP to the full path of an existing Mitmproxy Redirector binary."
    )
}

/// Path to the cached extract of the redirector bundle under
/// `~/.pilot/redirector/Mitmproxy Redirector.app/...`.
fn cached_extract_bin() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(".pilot/redirector/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector"))
}

/// Find the `Mitmproxy Redirector.app.tar` shipped inside the mitmproxy
/// brew cask, if present. Supports both Apple Silicon (`/opt/homebrew`)
/// and Intel (`/usr/local`) homebrew prefixes.
fn find_brew_tarball() -> Option<PathBuf> {
    for caskroom in [
        "/opt/homebrew/Caskroom/mitmproxy",
        "/usr/local/Caskroom/mitmproxy",
    ] {
        let caskroom_path = Path::new(caskroom);
        if !caskroom_path.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(caskroom_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let tar = entry.path().join(
                "mitmproxy.app/Contents/Resources/mitmproxy_macos/Mitmproxy Redirector.app.tar",
            );
            if tar.exists() {
                return Some(tar);
            }
        }
    }
    None
}

/// Extract the brew-shipped redirector tar into the cache directory. Uses
/// the system `tar` binary (always present on macOS) to preserve the code
/// signature's extended attributes, which a pure-Rust tar crate can't
/// promise out of the box.
///
/// **Concurrency**: multiple pilot-core workers may race to extract at
/// startup. We extract to a per-process temporary directory first and then
/// atomically `rename` the `.app` bundle into place. If another worker won
/// the race, our rename fails with EEXIST and we clean up — the winner's
/// content is used by everyone. This avoids a half-written cache under a
/// tar process kill or a racing writer.
fn extract_brew_tarball(tar_path: &Path) -> Result<()> {
    let home = dirs::home_dir().context("no home directory")?;
    let cache_dir = home.join(".pilot/redirector");
    let target_app = cache_dir.join("Mitmproxy Redirector.app");

    // Fast path: another worker already extracted before us.
    if target_app.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(&cache_dir)
        .with_context(|| format!("creating {}", cache_dir.display()))?;

    // Extract into a per-process sibling directory. Multiple workers can
    // run simultaneously; their tmp dirs don't collide.
    let tmp_dir = cache_dir.join(format!(".redirector.tmp.{}", std::process::id()));
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir)
            .with_context(|| format!("removing stale {}", tmp_dir.display()))?;
    }
    std::fs::create_dir_all(&tmp_dir).with_context(|| format!("creating {}", tmp_dir.display()))?;

    // Cleanup guard — drop() removes the tmp dir on any early return.
    struct TmpDirGuard<'a>(&'a Path);
    impl Drop for TmpDirGuard<'_> {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0);
        }
    }
    let guard = TmpDirGuard(&tmp_dir);

    let status = std::process::Command::new("tar")
        .arg("-xf")
        .arg(tar_path)
        .arg("-C")
        .arg(&tmp_dir)
        .status()
        .context("running tar")?;
    if !status.success() {
        bail!("tar -xf {} failed with {:?}", tar_path.display(), status);
    }

    let tmp_app = tmp_dir.join("Mitmproxy Redirector.app");
    if !tmp_app.exists() {
        bail!(
            "tar extracted {} but {} was not created",
            tar_path.display(),
            tmp_app.display()
        );
    }

    // Atomic rename into place. If the target already exists (another worker
    // won the race), `rename` fails with EEXIST on macOS; that's fine, both
    // workers end up using the winner's content (identical either way).
    match std::fs::rename(&tmp_app, &target_app) {
        Ok(_) => {
            info!(
                cache = %target_app.display(),
                "extracted Mitmproxy Redirector.app from brew cask tarball"
            );
        }
        Err(_) if target_app.exists() => {
            debug!(
                target = %target_app.display(),
                "another worker extracted the redirector first — using theirs"
            );
        }
        Err(e) => {
            return Err(e).with_context(|| {
                format!("renaming {} to {}", tmp_app.display(), target_app.display())
            });
        }
    }
    drop(guard); // explicit cleanup of any leftover tmp files
    Ok(())
}
