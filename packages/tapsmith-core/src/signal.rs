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

/// This process's parent pid.
pub fn parent_pid() -> u32 {
    // SAFETY: getppid(2) cannot fail.
    unsafe { libc::getppid() as u32 }
}

/// How often the daemon checks whether its parent is still there.
const PARENT_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// True once `original` is no longer our parent: it exited and we were
/// reparented (to launchd/init, or a subreaper on Linux). Comparing against
/// the original pid rather than 1 is what makes subreapers work.
pub(crate) fn parent_has_exited(original: u32, current: u32) -> bool {
    current != original
}

/// Resolve once the process that was our parent at startup has exited.
pub async fn wait_for_parent_exit(original: u32) {
    loop {
        if parent_has_exited(original, parent_pid()) {
            return;
        }
        tokio::time::sleep(PARENT_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reparented_daemon_knows_its_parent_exited() {
        assert!(parent_has_exited(4242, 1));
        // Linux subreaper (systemd --user, tini) adopts orphans instead of 1.
        assert!(parent_has_exited(4242, 777));
        assert!(!parent_has_exited(4242, 4242));
    }

    #[tokio::test]
    async fn waiting_on_a_live_parent_does_not_resolve() {
        let waited = tokio::time::timeout(
            std::time::Duration::from_millis(1500),
            wait_for_parent_exit(parent_pid()),
        )
        .await;
        assert!(waited.is_err(), "our parent (the test runner) is alive");
    }

    #[tokio::test]
    async fn waiting_on_a_parent_that_is_not_ours_resolves_at_once() {
        // Equivalent to "our original parent has gone": getppid() no longer
        // returns it.
        let not_parent = parent_pid().wrapping_add(1);
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            wait_for_parent_exit(not_parent),
        )
        .await
        .expect("resolves immediately");
    }
}
