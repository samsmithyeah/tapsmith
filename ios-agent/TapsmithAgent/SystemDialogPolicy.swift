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
/// list: iOS presents permission prompts exactly once per bundle id, so a
/// single accidental denial of e.g. the notification prompt is permanent —
/// there is no supported reset short of reinstalling the app (PILOT-290).
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
}
