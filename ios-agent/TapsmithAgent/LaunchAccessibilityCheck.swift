import Foundation

/// Checks that the app the agent launched at startup is reachable through
/// accessibility, and relaunches it when it is not (PILOT-462).
///
/// On a simulator whose app data container was orphaned (its container-manager
/// metadata deleted — older Tapsmith daemons did this on every clearData), the
/// first launch of the app after each boot has no accessibility server: every
/// XCUITest query fails with `kAXErrorAPIDisabled`, a hierarchy dump burns
/// ~16 s and ends in XCTest's "Interrupting test". A relaunch of the app heals
/// that process, so the agent relaunches before it reports ready instead of
/// leaving the first command to fail.
///
/// Pure logic only — the probe and relaunch are passed in — so it is unit
/// tested on the host (Tests/LaunchAccessibilityCheckTests).
enum LaunchAccessibilityCheck {
    enum Outcome: Equatable {
        /// The probe succeeded.
        case reachable
        /// The app has no accessibility server (`kAXErrorAPIDisabled`).
        case unreachable
        /// The probe failed for some other reason. Not ours to fix here:
        /// startup carries on exactly as it would without the check.
        case otherError
    }

    /// Relaunches allowed before giving up. One heals the observed case; the
    /// second covers a relaunch that races the simulator settling.
    static let maxRelaunches = 2

    /// Only the agent's own launch of a named target app is checked. Attach
    /// mode must leave the running app (and its navigation state) alone, and
    /// without a bundle id there is no target app to relaunch.
    static func shouldCheck(attachToRunningApp: Bool, bundleId: String) -> Bool {
        !attachToRunningApp && !bundleId.isEmpty
    }

    /// Whether an XCUITest error (a Swift error's description or an
    /// NSException's reason) says the app has no accessibility server.
    static func isAccessibilityUnreachable(_ errorDescription: String) -> Bool {
        errorDescription.contains("kAXErrorAPIDisabled")
    }

    /// Classify a probe result: `nil` means the probe succeeded.
    static func classify(probeError: String?) -> Outcome {
        guard let probeError else { return .reachable }
        return isAccessibilityUnreachable(probeError) ? .unreachable : .otherError
    }

    /// Probe, and while the app is unreachable and relaunches remain, relaunch
    /// and probe again. `probe` returns the error description, or nil on
    /// success. Returns the last probe's outcome.
    static func run(probe: () -> String?, relaunch: () -> Void) -> Outcome {
        var outcome = classify(probeError: probe())
        var relaunches = 0
        while outcome == .unreachable && relaunches < maxRelaunches {
            relaunch()
            relaunches += 1
            outcome = classify(probeError: probe())
        }
        return outcome
    }

    /// The error a hierarchy dump returns when the app is unreachable, in place
    /// of XCUITest's internal "Interrupting test".
    static func unreachableMessage(bundleId: String) -> String {
        let app = bundleId.isEmpty ? "The app" : "The app \(bundleId)"
        return "\(app) is not reachable through accessibility (kAXErrorAPIDisabled), so its "
            + "screen cannot be read. Relaunch the app (launchApp, or tapsmith_launch_app in MCP) "
            + "and try again; if it keeps happening, reinstall the app on this simulator."
    }
}
