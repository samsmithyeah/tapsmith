// Unit tests for LaunchAccessibilityCheck (PILOT-462): when the agent checks
// that the app it just launched is reachable through accessibility, which
// probe results call for a relaunch, and how many relaunches it allows.

import Foundation

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

// The error XCTest returns from app.snapshot() when the app process has no
// accessibility server (seen on simulators whose data container was orphaned).
let axDisabled = "Error Domain=com.apple.dt.xctest.automation-support.error Code=8 "
    + "\"Error getting main window kAXErrorAPIDisabled\" "
    + "UserInfo={NSLocalizedDescription=Error getting main window kAXErrorAPIDisabled}"

// Gating: only the agent's own launch of a named target app is checked.
do {
    expect("checks the app it launched",
           LaunchAccessibilityCheck.shouldCheck(attachToRunningApp: false, bundleId: "dev.tapsmith.testapp"))
    expect("never checks in attach mode (the running app must be left alone)",
           !LaunchAccessibilityCheck.shouldCheck(attachToRunningApp: true, bundleId: "dev.tapsmith.testapp"))
    expect("never checks without a target bundle id",
           !LaunchAccessibilityCheck.shouldCheck(attachToRunningApp: false, bundleId: ""))
}

// Classification: only the accessibility-unreachable signature is actionable.
do {
    expect("a successful probe is reachable",
           LaunchAccessibilityCheck.classify(probeError: nil) == .reachable)
    expect("kAXErrorAPIDisabled is unreachable",
           LaunchAccessibilityCheck.classify(probeError: axDisabled) == .unreachable)
    expect("the bare code name is unreachable too (NSException text)",
           LaunchAccessibilityCheck.classify(probeError: "kAXErrorAPIDisabled") == .unreachable)
    expect("an unrelated snapshot error is not a reason to relaunch",
           LaunchAccessibilityCheck.classify(probeError: "Application is not running") == .otherError)
    expect("a timeout is not a reason to relaunch",
           LaunchAccessibilityCheck.classify(probeError: "Timed out while evaluating UI query") == .otherError)
    expect("isUnreachable mirrors classify for the dump path",
           LaunchAccessibilityCheck.isAccessibilityUnreachable(axDisabled)
           && !LaunchAccessibilityCheck.isAccessibilityUnreachable("Application is not running"))
}

// The relaunch loop: relaunch only while unreachable and attempts remain.
do {
    var probes: [String?] = [axDisabled, nil]
    var relaunches = 0
    let outcome = LaunchAccessibilityCheck.run(
        probe: { probes.removeFirst() },
        relaunch: { relaunches += 1 })
    expect("one relaunch heals an unreachable first launch", outcome == .reachable && relaunches == 1)
}
do {
    var relaunches = 0
    var probeCount = 0
    let outcome = LaunchAccessibilityCheck.run(
        probe: { probeCount += 1; return axDisabled },
        relaunch: { relaunches += 1 })
    expect("gives up after maxRelaunches",
           outcome == .unreachable && relaunches == LaunchAccessibilityCheck.maxRelaunches)
    expect("probes once more after the last relaunch", probeCount == LaunchAccessibilityCheck.maxRelaunches + 1)
    expect("allows two relaunches", LaunchAccessibilityCheck.maxRelaunches == 2)
}
do {
    var relaunches = 0
    let outcome = LaunchAccessibilityCheck.run(
        probe: { "Application is not running" },
        relaunch: { relaunches += 1 })
    expect("an unrelated error ends the check without relaunching", outcome == .otherError && relaunches == 0)
}
do {
    var relaunches = 0
    let outcome = LaunchAccessibilityCheck.run(probe: { nil }, relaunch: { relaunches += 1 })
    expect("a healthy launch is probed once and never relaunched", outcome == .reachable && relaunches == 0)
}

// The message the dump path returns instead of XCUITest's "Interrupting test".
do {
    let msg = LaunchAccessibilityCheck.unreachableMessage(bundleId: "dev.tapsmith.testapp")
    expect("message names the app", msg.contains("dev.tapsmith.testapp"))
    expect("message says what to do", msg.lowercased().contains("relaunch"))
    expect("message does not leak XCUITest internals", !msg.contains("Interrupting test"))
}

if failures > 0 {
    print("\(failures) LaunchAccessibilityCheck test(s) failed")
    exit(1)
}
print("All LaunchAccessibilityCheck tests passed")
