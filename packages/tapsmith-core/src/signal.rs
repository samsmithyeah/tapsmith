use anyhow::{bail, Result};
use tokio::process::Child;

/// Send SIGINT to a child process, letting it shut down gracefully.
///
/// Returns `Ok(())` if the child already exited. On non-Unix platforms
/// falls back to `start_kill()` (SIGKILL equivalent).
pub fn send_sigint(child: &mut Child) -> Result<()> {
    if let Ok(Some(_)) = child.try_wait() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let Some(pid) = child.id() else {
            bail!("child has no PID; cannot signal");
        };
        // SAFETY: child is still running (try_wait returned None) and we hold
        // the Child handle, so the PID cannot have been recycled.
        let ret = unsafe { libc::kill(pid as i32, libc::SIGINT) };
        if ret != 0 {
            let err = std::io::Error::last_os_error();
            bail!("failed to send SIGINT to child (pid {pid}): {err}");
        }
    }
    #[cfg(not(unix))]
    {
        child
            .start_kill()
            .map_err(|e| anyhow::anyhow!("failed to kill child: {e}"))?;
    }
    Ok(())
}
