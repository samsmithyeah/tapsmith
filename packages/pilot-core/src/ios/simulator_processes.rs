//! Resolve the set of host-visible PIDs belonging to a booted iOS simulator.
//!
//! Used by `ios_redirect` to build the `InterceptConf` PID filter that the
//! macOS Network Extension uses to decide which TCP flows to redirect into
//! Pilot's MITM proxy.
//!
//! ## Why substring-match the command line
//!
//! Two different kinds of processes touch a booted simulator:
//!
//! 1. **Descendants of `launchd_sim`** — apps launched inside the simulator
//!    via `launchctl` or `xcrun simctl spawn` have the simulator's
//!    `launchd_sim` as their parent process. `ps` shows their ppid pointing
//!    directly at the simulator's launchd_sim pid.
//! 2. **Host-side test runners** — processes like `PilotAgentUITests-Runner`
//!    (XCTest host bundles) are launched by `xcodebuild`/`testmanagerd`, so
//!    their ppid chain does NOT lead back to the simulator's launchd_sim.
//!    But their command-line argv references the simulator's data container,
//!    e.g. `/Users/.../CoreSimulator/Devices/<UDID>/data/...`.
//!
//! To catch both, we walk `ps -axo pid,ppid,command` twice:
//!
//! - Find `launchd_sim` for the given UDID and BFS its descendants via
//!   parent-pid links.
//! - Union with any row whose command line contains the literal
//!   `CoreSimulator/Devices/<UDID>` marker.
//!
//! The union is de-duplicated before being returned.

use std::collections::{BTreeSet, HashMap};

use anyhow::{bail, Context, Result};
use tokio::process::Command;

/// Resolve all PIDs belonging to a booted simulator's process tree.
///
/// Returns an empty `Vec` if the simulator is not booted (no `launchd_sim`
/// with a matching UDID) and no host-side processes reference the UDID in
/// their command line.
pub async fn resolve_simulator_pids(udid: &str) -> Result<Vec<u32>> {
    let output = Command::new("ps")
        .args(["-axo", "pid,ppid,command"])
        .output()
        .await
        .context("running `ps -axo pid,ppid,command`")?;
    if !output.status.success() {
        bail!("ps exited with status {:?}", output.status);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_ps_output(&stdout, udid))
}

/// Pure-logic parser used by unit tests with synthetic `ps` output, and by
/// `resolve_simulator_pids` via the `ps` subprocess.
pub(crate) fn parse_ps_output(stdout: &str, udid: &str) -> Vec<u32> {
    let udid_marker = format!("CoreSimulator/Devices/{udid}");

    // Parse rows. We skip any line where pid or ppid doesn't parse — the
    // header row, blank lines, and anything malformed are handled by falling
    // through the `.ok()` checks below.
    let rows: Vec<(u32, u32, &str)> = stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let (pid_str, rest) = trimmed.split_once(|c: char| c.is_whitespace())?;
            let pid: u32 = pid_str.parse().ok()?;
            let rest = rest.trim_start();
            let (ppid_str, command) = rest.split_once(|c: char| c.is_whitespace())?;
            let ppid: u32 = ppid_str.parse().ok()?;
            // `command` is the remainder of the line with its original whitespace,
            // which we need for substring matching against the UDID marker.
            Some((pid, ppid, command.trim_start()))
        })
        .collect();

    let mut result: BTreeSet<u32> = BTreeSet::new();

    // Strategy 1 — BFS from launchd_sim(UDID) down the ppid graph.
    //
    // The simulator's `launchd_sim` row looks like
    //   7117 1 launchd_sim /Users/.../CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
    // and every in-simulator process has ppid chained to this pid (possibly
    // several levels deep).
    let launchd_sim_pid = rows.iter().find_map(|(pid, _ppid, command)| {
        if command.contains("launchd_sim") && command.contains(&udid_marker) {
            Some(*pid)
        } else {
            None
        }
    });
    if let Some(root) = launchd_sim_pid {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, ppid, _) in &rows {
            children.entry(*ppid).or_default().push(*pid);
        }
        let mut frontier = vec![root];
        while let Some(p) = frontier.pop() {
            if result.insert(p) {
                if let Some(kids) = children.get(&p) {
                    frontier.extend(kids);
                }
            }
        }
    }

    // Strategy 2 — include any process whose command line references the
    // simulator's data container (host-side test runners).
    for (pid, _ppid, command) in &rows {
        if command.contains(&udid_marker) {
            result.insert(*pid);
        }
    }

    result.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const UDID_A: &str = "972FB67E-B94F-40EC-9388-7F3EFB761246";
    const UDID_B: &str = "6C21330D-1440-40AC-8E5E-F23F9164C6B6";

    /// Minimal `ps -axo pid,ppid,command` snapshot featuring two booted
    /// simulators, a host-side xcodebuild test runner for a third, and noise.
    ///
    /// Realistic properties:
    /// - Processes whose exec path is under `CoreSimulator/Devices/<UDID>/data/`
    ///   are always children of that same simulator's `launchd_sim` (macOS
    ///   doesn't launch binaries from one simulator's container under another
    ///   simulator's process tree in the wild).
    /// - `PilotAgentUITests-Runner` is an xcodebuild-launched XCTest host
    ///   bundle, so its parent is `xcodebuild`/`testmanagerd`, NOT the
    ///   simulator's `launchd_sim`. This is the case Strategy 2 exists for.
    const PS_SNAPSHOT: &str = "\
  PID  PPID COMMAND
    1     0 /sbin/launchd
  500     1 /usr/libexec/loginwindow
 7117     1 launchd_sim /Users/sam/Library/Developer/CoreSimulator/Devices/6C21330D-1440-40AC-8E5E-F23F9164C6B6/data/var/run/launchd_bootstrap.plist
11320     1 launchd_sim /Users/sam/Library/Developer/CoreSimulator/Devices/972FB67E-B94F-40EC-9388-7F3EFB761246/data/var/run/launchd_bootstrap.plist
14646 11320 /Users/sam/Library/Developer/CoreSimulator/Devices/972FB67E-B94F-40EC-9388-7F3EFB761246/data/Containers/Bundle/Application/F9BAB21E/PilotTestApp.app/PilotTestApp
14700 14646 /Library/CoreSimulator/Volumes/iOS_22B83/Runtimes/iOS 18.2.simruntime/Contents/Resources/RuntimeRoot/usr/bin/python3
18050 11320 /usr/bin/curl --max-time 5 https://httpbin.org/get -o /dev/null
 3491 28457 /Users/sam/Library/Developer/CoreSimulator/Devices/5A3A8684-CAFE-BABE-DEAD-BEEF00000000/data/Containers/Bundle/Application/0CD2681B/PilotAgentUITests-Runner.app/PilotAgentUITests-Runner
28457  1000 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test-without-building
  999   888 /usr/sbin/cfprefsd agent
";

    #[test]
    fn parses_descendants_of_launchd_sim() {
        // For simulator A, `launchd_sim` is pid 11320. Its direct children
        // are 14646 (PilotTestApp) and 18050 (curl from `simctl spawn`).
        // 14646 has a grandchild 14700 (a python3 from the runtime root).
        // Expected UDID_A PID set (in sorted order from the BTreeSet):
        //   11320 (launchd_sim, BFS root)
        //   14646 (PilotTestApp, BFS child; also marker-matches)
        //   14700 (BFS grandchild)
        //   18050 (curl, BFS child)
        let pids = parse_ps_output(PS_SNAPSHOT, UDID_A);
        assert_eq!(pids, vec![11320, 14646, 14700, 18050]);
    }

    #[test]
    fn isolates_different_simulators() {
        let pids_a = parse_ps_output(PS_SNAPSHOT, UDID_A);
        let pids_b = parse_ps_output(PS_SNAPSHOT, UDID_B);
        // Sim B has only launchd_sim — no children in the snapshot.
        assert_eq!(pids_b, vec![7117]);
        // Sims A and B must not overlap (disjoint by construction).
        for pid in &pids_a {
            assert!(!pids_b.contains(pid), "pid {pid} in both sims");
        }
    }

    #[test]
    fn not_booted_returns_empty() {
        let pids = parse_ps_output(PS_SNAPSHOT, "DEADBEEF-0000-0000-0000-000000000000");
        assert!(pids.is_empty());
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let ps = "\
  PID  PPID COMMAND
garbage
    \t   no pid here
11320     1 launchd_sim /a/CoreSimulator/Devices/AAAA/data/var/run/launchd_bootstrap.plist
not-a-pid 1 something
14646 11320 /a/CoreSimulator/Devices/AAAA/app/Bin
";
        let pids = parse_ps_output(ps, "AAAA");
        assert_eq!(pids, vec![11320, 14646]);
    }

    #[test]
    fn catches_xcodebuild_test_runner_via_marker_only() {
        // PilotAgentUITests-Runner (pid 3491) belongs to UDID 5A3A8684...;
        // its ppid chain leads to xcodebuild (28457), not launchd_sim.
        // Strategy 2 must still catch it via the CoreSimulator/Devices
        // substring.
        let pids = parse_ps_output(PS_SNAPSHOT, "5A3A8684-CAFE-BABE-DEAD-BEEF00000000");
        assert_eq!(pids, vec![3491]);
    }
}
