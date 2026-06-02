//! Android screen video stream: drives `adb screenrecord` (H.264), parses the
//! byte stream into access units, and forwards them on a channel. Respawns
//! across screenrecord's 180s cap so the stream is continuous.

use crate::{adb, h264};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Handle to a running screen stream. Drop it to stop capture (the spawned
/// task observes the closed channel, kills the child, and exits).
// TODO(Task 4): remove once the StreamScreen gRPC handler consumes this.
#[allow(dead_code)]
pub struct ScreenStreamHandle {
    pub rx: mpsc::Receiver<h264::AccessUnit>,
}

/// Start streaming H.264 access units from the device. Drop the returned
/// handle (its `rx`) to stop.
// TODO(Task 4): remove once the StreamScreen gRPC handler calls this.
#[allow(dead_code)]
pub fn start(serial: String, max_size: Option<u32>, bit_rate: Option<u32>) -> ScreenStreamHandle {
    let (tx, rx) = mpsc::channel::<h264::AccessUnit>(64);
    tokio::spawn(async move {
        loop {
            // Stop if the consumer dropped the receiver.
            if tx.is_closed() {
                break;
            }
            let mut child = match adb::screenrecord_h264_spawn(&serial, max_size, bit_rate) {
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
        }
        debug!("screen stream task exited");
    });
    ScreenStreamHandle { rx }
}
