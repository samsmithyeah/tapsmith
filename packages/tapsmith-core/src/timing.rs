//! Lightweight opt-in timing instrumentation for performance investigation.
//!
//! Enabled only when the `TAPSMITH_TIMING_LOG` env var points at a file;
//! otherwise every call is a cheap no-op. Logs go to a file (not `tracing`)
//! because the SDK spawns the daemon with `stdio: 'ignore'`, so stderr/stdout
//! would be discarded. Used to break down where iOS e2e wall-clock goes
//! (agent boot vs. per-command device latency vs. app reset).
//!
//! Line format (one per event, easy to grep/aggregate):
//!   [TIMING] pid=<n> kind=<boot|cmd|reset> name=<str> dur_ms=<n> ok=<bool> ...

use std::io::Write;
use std::sync::OnceLock;

fn timing_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let path = std::env::var("TAPSMITH_TIMING_LOG").ok()?;
        // Create the parent directory once, up front, so per-write opens don't
        // fail silently when the caller points at a not-yet-existing dir.
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        Some(path)
    })
    .as_deref()
}

/// Whether timing capture is enabled. Cheap (reads a cached `OnceLock`).
/// Callers should gate any non-trivial work that only exists to build a
/// timing line behind this, since macro arguments are evaluated eagerly.
pub fn enabled() -> bool {
    timing_path().is_some()
}

/// Append one timing line to the configured log file. No-op when
/// `TAPSMITH_TIMING_LOG` is unset. Opens-appends per call: this is low
/// frequency (one line per agent command) so the simplicity is worth it, and
/// O_APPEND writes of short lines are atomic enough for our aggregation.
pub fn log(fields: std::fmt::Arguments<'_>) {
    let Some(path) = timing_path() else {
        return;
    };
    let pid = std::process::id();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        // Format the whole line first, then emit it in a single `write_all`.
        // Under O_APPEND a one-shot write keeps concurrent writers' lines from
        // interleaving, which `writeln!`'s multiple syscalls would allow.
        let line = format!("[TIMING] pid={pid} {fields}\n");
        let _ = f.write_all(line.as_bytes());
    }
}

/// Convenience macro mirroring `format!` arg syntax.
macro_rules! timing_log {
    ($($arg:tt)*) => {
        $crate::timing::log(format_args!($($arg)*))
    };
}
pub(crate) use timing_log;
