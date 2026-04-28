//! iOS screen recording — simulator and physical-device paths.
//!
//! - **Simulator**: `xcrun simctl io <udid> recordVideo --codec h264 <path>`
//!   writes an MP4 directly to the host filesystem. We spawn the process, then
//!   stop it by sending SIGINT — recordVideo flushes the MOOV atom on signal,
//!   which is required for the resulting file to be playable. Sending SIGTERM
//!   tends to leave un-finalised files.
//! - **Physical device**: there is no first-party Apple CLI for screen
//!   recording a tethered iPhone (`xcrun simctl` is sim-only and `xcrun
//!   devicectl` has no `record` subcommand). We use `ffmpeg -f avfoundation`,
//!   which captures from the iPhone's CoreMediaIO video device that appears on
//!   macOS once the device is paired and trusted. ffmpeg must be on PATH —
//!   the daemon emits an actionable "install ffmpeg" error otherwise.

use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tracing::{debug, info, instrument, warn};

/// Spawn `xcrun simctl io <udid> recordVideo --codec h264 <local_path>` and
/// return the child. The process writes MP4 bytes directly to `local_path` on
/// the host. Stop with `stop_simctl_recording`, which sends SIGINT so the
/// encoder finalises the file.
#[instrument]
pub async fn recordvideo_sim_spawn(udid: &str, local_path: &Path) -> Result<Child> {
    let path_str = local_path
        .to_str()
        .context("recording path must be valid UTF-8")?;

    let mut cmd = Command::new("xcrun");
    cmd.args([
        "simctl",
        "io",
        udid,
        "recordVideo",
        "--codec",
        "h264",
        path_str,
    ])
    .kill_on_drop(true)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    debug!(
        udid,
        path = path_str,
        "Spawning xcrun simctl io recordVideo"
    );
    let child = cmd
        .spawn()
        .context("Failed to spawn xcrun simctl io recordVideo")?;
    Ok(child)
}

/// Stop a simctl recordVideo child by sending SIGINT, which lets the encoder
/// finalise the MP4 (write the MOOV atom). Falls back to a hard kill if the
/// child doesn't exit within `wait`.
pub async fn stop_simctl_recording(mut child: Child, wait: std::time::Duration) -> Result<()> {
    send_sigint(&mut child)?;
    match tokio::time::timeout(wait, child.wait()).await {
        Ok(Ok(_status)) => Ok(()),
        Ok(Err(e)) => Err(anyhow::Error::from(e).context("waiting for simctl recordVideo to exit")),
        Err(_) => {
            warn!("simctl recordVideo did not exit on SIGINT; escalating to kill");
            let _ = child.kill().await;
            Ok(())
        }
    }
}

/// Whether ffmpeg is resolvable on PATH. Cached at the call site by the
/// caller — see `crate::video`.
pub async fn is_ffmpeg_available() -> bool {
    Command::new("which")
        .arg("ffmpeg")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolve the AVFoundation video-device index for a physical iOS device with
/// the given friendly name. Returns the numeric index that ffmpeg expects
/// (the bracketed `[N]` in `ffmpeg -f avfoundation -list_devices true -i ""`).
///
/// Best-effort: if the iPhone isn't visible to AVFoundation (not paired, not
/// trusted, USB cable unplugged) the function returns `None` and the caller
/// surfaces a clear error.
#[instrument]
pub async fn resolve_avfoundation_index(device_name: &str) -> Result<Option<usize>> {
    // ffmpeg writes the device list to stderr and exits 1 (because there's
    // no input given). That's expected — we just want the catalog.
    let output = Command::new("ffmpeg")
        .args(["-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("Failed to run ffmpeg to list AVFoundation devices")?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    let needle_lower = device_name.to_lowercase();

    // Parse the video-device section into (index, name) pairs.
    let mut devices: Vec<(usize, String)> = Vec::new();
    let mut in_video_section = false;
    for line in stderr.lines() {
        if line.contains("AVFoundation video devices") {
            in_video_section = true;
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            in_video_section = false;
            continue;
        }
        if !in_video_section {
            continue;
        }
        // Lines look like: `[AVFoundation indev @ 0x...] [N] Device Name`
        let Some(after_first_bracket) = line.split_once("] [") else {
            continue;
        };
        let rest = after_first_bracket.1;
        let Some((idx_str, name)) = rest.split_once("] ") else {
            continue;
        };
        let Ok(idx) = idx_str.trim().parse::<usize>() else {
            continue;
        };
        devices.push((idx, name.trim().to_string()));
    }

    // Prefer exact match, then fall back to substring.
    let found = devices
        .iter()
        .find(|(_, name)| name.to_lowercase() == needle_lower)
        .or_else(|| {
            devices.iter().find(|(_, name)| {
                let name_lower = name.to_lowercase();
                name_lower.contains(&needle_lower) || needle_lower.contains(&name_lower)
            })
        });

    if let Some((idx, name)) = found {
        debug!(
            device_name,
            avf_name = name.as_str(),
            index = idx,
            "Resolved AVFoundation device index"
        );
        return Ok(Some(*idx));
    }

    debug!(
        device_name,
        "No matching AVFoundation video device found in catalog"
    );
    Ok(None)
}

/// Spawn `ffmpeg -f avfoundation` to record a physical iOS device's screen.
///
/// `device_name` is the user-visible iPhone name (e.g. "Sam's iPhone") used
/// to match the AVFoundation device by name. ffmpeg must be on PATH.
#[instrument]
pub async fn recordvideo_physical_spawn(device_name: &str, local_path: &Path) -> Result<Child> {
    if !is_ffmpeg_available().await {
        bail!(
            "ffmpeg not found on PATH. Physical iOS recording uses ffmpeg's \
             AVFoundation backend. Install with:\n  brew install ffmpeg\n\
             Then re-run with `--video on` to verify."
        );
    }

    let index = match resolve_avfoundation_index(device_name).await? {
        Some(i) => i,
        None => bail!(
            "Could not find an AVFoundation video device matching iPhone name \
             '{device_name}'. Make sure the device is plugged in over USB, \
             paired in Xcode, and that you have accepted the 'Trust This \
             Computer' prompt on the device."
        ),
    };

    let path_str = local_path
        .to_str()
        .context("recording path must be valid UTF-8")?;
    // Encode as h264 with faststart so the resulting MP4 plays in the HTML
    // reporter's <video> element without seek-to-end on load.
    let input = format!("{index}:none");
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-y", // overwrite output if it exists (we already chose a fresh path)
        "-f",
        "avfoundation",
        "-framerate",
        "30",
        "-i",
        &input,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        path_str,
    ])
    .kill_on_drop(true)
    .stdin(Stdio::piped()) // we send "q\n" to ffmpeg to stop it cleanly
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    info!(
        device_name,
        index,
        path = path_str,
        "Spawning ffmpeg for physical iOS recording"
    );
    let child = cmd
        .spawn()
        .context("Failed to spawn ffmpeg for AVFoundation recording")?;
    Ok(child)
}

/// Stop an ffmpeg recording cleanly by writing `q\n` to its stdin. ffmpeg
/// flushes the MP4 trailer on `q`; SIGTERM tends to leave a partially-written
/// file with no MOOV atom.
pub async fn stop_ffmpeg_recording(mut child: Child, wait: std::time::Duration) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    if let Some(stdin) = child.stdin.as_mut() {
        if let Err(e) = stdin.write_all(b"q\n").await {
            warn!(error = %e, "Failed to write 'q' to ffmpeg stdin; falling back to kill");
        }
        let _ = stdin.shutdown().await;
    }

    match tokio::time::timeout(wait, child.wait()).await {
        Ok(Ok(_status)) => Ok(()),
        Ok(Err(e)) => Err(anyhow::Error::from(e).context("waiting for ffmpeg to exit")),
        Err(_) => {
            warn!("ffmpeg did not exit on 'q'; escalating to kill");
            let _ = child.kill().await;
            Ok(())
        }
    }
}

use crate::signal::send_sigint;

#[cfg(test)]
mod tests {
    #[test]
    fn parses_avfoundation_catalog_line() {
        // Lines from `ffmpeg -f avfoundation -list_devices true -i ""` look
        // like `[AVFoundation indev @ 0x7f...] [N] Device Name` — exercise
        // the same split this module's resolver uses, against a fixed sample.
        let line = "[AVFoundation indev @ 0x7f8] [1] Sam's iPhone";
        let after_first = line.split_once("] [").unwrap().1;
        let (idx, name) = after_first.split_once("] ").unwrap();
        assert_eq!(idx.trim(), "1");
        assert_eq!(name.trim(), "Sam's iPhone");
    }
}
