import Foundation

/// Single source of truth for how the agent responds to iOS system dialogs
/// (permission prompts, iCloud Keychain "Save Password?", etc.).
///
/// Policy: **Tapsmith accepts permission prompts by default.** Every code
/// path that taps through a system dialog — the `UIInterruptionMonitor` in
/// TapsmithAgentRunner and the blocking-dialog sweep in CommandHandler —
/// consults these lists, and always prefers an allow-style button over a
/// dismissive one. Dismissive buttons exist only for dialogs that have no
/// allow-style button (e.g. "Save Password?", whose decline is "Not Now").
///
/// Permission-denial labels ("Don't Allow") must never appear in either
/// label list: iOS presents permission prompts exactly once per bundle id,
/// so a single accidental denial of e.g. the notification prompt is
/// permanent — there is no supported reset short of reinstalling the app
/// (PILOT-290). The one sanctioned deny path is an explicitly configured
/// `notificationPermission == "denied"`, which targets only the
/// notification prompt (PILOT-291).
enum SystemDialogPolicy {
    /// Buttons that accept a system prompt, checked first and in order.
    static let allowButtonLabels = [
        "Allow",
        "OK",
        "Allow While Using App",
        "Allow Once",
        "Continue",
        "Dismiss",
    ]

    /// Fallback buttons for dialogs with no allow-style button. "Not Now"
    /// declines iCloud Keychain's "Save Password?" prompt — a dismissal,
    /// not a permission denial (permission prompts use "Don't Allow",
    /// which is deliberately absent).
    static let dismissButtonLabels = [
        "Not Now",
        "Not now",
        "Dismiss",
        "Close",
        "Cancel",
    ]

    /// Configured notification permission policy for the app under test:
    /// "granted", "denied", "prompt", or "" (default). Injected by the
    /// daemon into the runner environment via the patched xctestrun.
    /// Only "denied" changes behavior — the session deliberately declines
    /// the notification prompt so tests can exercise the denied-state UI.
    /// "granted" and "prompt" rely on the default allow-first handling.
    static let notificationPermission =
        ProcessInfo.processInfo.environment["TAPSMITH_NOTIFICATION_PERMISSION"] ?? ""

    /// Both apostrophe variants iOS has used for the deny button.
    static let notificationDenyButtonLabels = ["Don’t Allow", "Don't Allow"]

    /// Whether an alert is the one-shot notification permission prompt
    /// ("“AppName” Would Like to Send You Notifications"). English-only,
    /// like every other label match in the agent.
    static func isNotificationPermissionAlert(_ alertLabel: String) -> Bool {
        return alertLabel.contains("Would Like to Send You Notifications")
    }
}
