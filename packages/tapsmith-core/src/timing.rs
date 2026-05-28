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
    PATH.get_or_init(|| std::env::var("TAPSMITH_TIMING_LOG").ok())
        .as_deref()
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
        let _ = writeln!(f, "[TIMING] pid={pid} {fields}");
    }
}

/// Convenience macro mirroring `format!` arg syntax.
macro_rules! timing_log {
    ($($arg:tt)*) => {
        $crate::timing::log(format_args!($($arg)*))
    };
}
pub(crate) use timing_log;
