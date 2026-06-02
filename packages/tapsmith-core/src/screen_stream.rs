//! Android screen video stream: drives `adb screenrecord` (H.264), parses the
//! byte stream into access units, and forwards them on a channel. Respawns
//! across screenrecord's 180s cap so the stream is continuous.

use crate::{adb, h264};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Handle to a running screen stream. Drop it to stop capture (the spawned
/// task observes the closed channel, kills the child, and exits).
pub struct ScreenStreamHandle {
    pub rx: mpsc::Receiver<h264::AccessUnit>,
}

/// Scale a device resolution down so its long edge is at most `max`, preserving
/// aspect ratio, with even dimensions (H.264 requires even width/height).
fn fit_size(dw: u32, dh: u32, max: u32) -> (u32, u32) {
    let long = dw.max(dh);
    let (mut w, mut h) = if long > max && long > 0 {
        let s = max as f64 / long as f64;
        (
            ((dw as f64) * s).round() as u32,
            ((dh as f64) * s).round() as u32,
        )
    } else {
        (dw, dh)
    };
    w -= w % 2;
    h -= h % 2;
    (w.max(2), h.max(2))
}

/// Start streaming H.264 access units from the device. Drop the returned
/// handle (its `rx`) to stop. `max_size` caps the long edge (aspect-preserved).
pub fn start(serial: String, max_size: Option<u32>, bit_rate: Option<u32>) -> ScreenStreamHandle {
    let (tx, rx) = mpsc::channel::<h264::AccessUnit>(64);
    tokio::spawn(async move {
        // Resolve the capture size once, preserving the device aspect ratio.
        // A square `--size` would letterboxes a portrait screen, so we scale the
        // real resolution. If the query fails, fall back to native (None).
        let size: Option<(u32, u32)> = match adb::display_size(&serial).await {
            // Always route through fit_size so dimensions are even (H.264 requires
            // it — odd native/override dims make screenrecord fail). With no cap,
            // use the long edge so it only rounds to even, never downscales.
            Ok((dw, dh)) => Some(fit_size(dw, dh, max_size.unwrap_or_else(|| dw.max(dh)))),
            Err(e) => {
                warn!(error = %e, "failed to query display size; using native resolution");
                None
            }
        };
        loop {
            // Stop if the consumer dropped the receiver.
            if tx.is_closed() {
                break;
            }
            let segment_started = tokio::time::Instant::now();
            let mut child = match adb::screenrecord_h264_spawn(&serial, size, bit_rate) {
                Ok(c) => c,
                Err(e) => {
                    warn!(error = %e, "screenrecord spawn failed; stopping screen stream");
                    break;
                }
            };
            let mut stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    warn!("screenrecord child had no stdout; stopping");
                    break;
                }
            };
            let mut parser = h264::Parser::new();
            let mut readbuf = vec![0u8; 64 * 1024];
            let mut stop = false;
            loop {
                let n = match stdout.read(&mut readbuf).await {
                    Ok(0) => {
                        debug!("screenrecord segment ended; respawning");
                        break;
                    }
                    Ok(n) => n,
                    Err(e) => {
                        warn!(error = %e, "screenrecord read error; respawning");
                        break;
                    }
                };
                for au in parser.push(&readbuf[..n]) {
                    if tx.send(au).await.is_err() {
                        stop = true;
                        break;
                    }
                }
                if stop {
                    break;
                }
            }
            // kill_on_drop handles killing the segment child on respawn/stop.
            let _ = child.start_kill();
            let _ = child.wait().await;
            if stop {
                break;
            }
            // Back off if the segment died almost immediately: screenrecord
            // exiting on error (device locked/unauthorized/unsupported opts)
            // would otherwise respawn in a tight loop and peg the CPU. Normal
            // ~180s segments and the first spawn are unaffected.
            if segment_started.elapsed() < std::time::Duration::from_secs(1) {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
        debug!("screen stream task exited");
    });
    ScreenStreamHandle { rx }
}

#[cfg(test)]
mod tests {
    use super::fit_size;

    #[test]
    fn portrait_scales_to_cap_preserving_aspect_even_dims() {
        // 1080x2400 capped at 720 long edge → 324x720 (aspect kept, even).
        assert_eq!(fit_size(1080, 2400, 720), (324, 720));
    }

    #[test]
    fn landscape_scales_on_width() {
        assert_eq!(fit_size(2400, 1080, 720), (720, 324));
    }

    #[test]
    fn smaller_than_cap_is_unchanged_but_even() {
        assert_eq!(fit_size(540, 960, 1080), (540, 960));
        assert_eq!(fit_size(541, 961, 1080), (540, 960)); // rounded to even
    }
}
