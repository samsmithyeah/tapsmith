import XCTest

/// Entry point for the Tapsmith iOS on-device agent.
///
/// This is an XCTestCase subclass that starts a TCP socket server and blocks
/// indefinitely, keeping the XCTest runner alive. The socket server accepts
/// JSON-RPC commands from the host daemon and dispatches them to XCUITest.
///
/// Launched via: xcodebuild test-without-building -xctestrun <path> -destination 'id=<udid>'
///
/// Mirrors the Android agent's TapsmithAgent.kt.
class TapsmithAgentRunner: XCTestCase {

    private static let defaultPort: UInt16 = 18700
    private static let envTargetBundleId = "TAPSMITH_TARGET_BUNDLE_ID"
    private static let envPort = "TAPSMITH_AGENT_PORT"
    private static let envAttachToRunningApp = "TAPSMITH_ATTACH_TO_RUNNING_APP"

    private var socketServer: SocketServer?

    /// The main test method that starts the agent.
    /// This method intentionally never returns — it blocks to keep the XCTest
    /// runner alive so the socket server can continuously accept commands.
    func testRunAgent() {
        let bundleId = ProcessInfo.processInfo.environment[Self.envTargetBundleId] ?? ""
        let port = UInt16(ProcessInfo.processInfo.environment[Self.envPort] ?? "") ?? Self.defaultPort
        let attachToRunningApp = ProcessInfo.processInfo.environment[Self.envAttachToRunningApp] == "1"

        NSLog("[TapsmithAgent] Starting with target bundle: \(bundleId), port: \(port)")

        // Create the XCUIApplication for the target app
        let app: XCUIApplication
        if bundleId.isEmpty {
            app = XCUIApplication()
        } else {
            app = XCUIApplication(bundleIdentifier: bundleId)
        }

        // Disable XCUITest's quiescence waiting — this is the single biggest
        // performance win. Without this, every action (tap, type, swipe) blocks
        // for 30+ seconds because XCUITest waits for the app to become "idle".
        // React Native apps are never idle (JS bridge timers always running).
        //
        // Step 0: Verify swizzle targets exist before attempting to disable.
        // Logs warnings if Xcode changed the private APIs we depend on.
        let _ = QuiescenceDisabler.verifySwizzleTargetsExist()
        // Step 1: Runtime swizzle BEFORE activate() — affects the class itself.
        QuiescenceDisabler.disableViaRuntime()
        // Step 2: Nuclear option — swizzle ALL quiescence methods on EVERY
        // XCTest class that might check quiescence. Different code paths
        // (XCUICoordinate.tap vs XCUIElement.tap vs app.activate) call
        // quiescence checks on different classes.
        let classNames = [
            "XCUIApplicationProcess",
            "XCUIApplicationImpl",
            "XCUICoordinate",
            "XCUIElement",
            "XCUIElementQuery",
            "XCUIApplication",
        ]
        for className in classNames {
            if let cls = NSClassFromString(className) {
                QuiescenceDisabler.disableAllQuiescenceMethods(on: cls)
            }
        }
        // Auto-dismiss permission prompts that would otherwise block XCUITest
        // interactions.
        // NOTE: deliberately does not handle the deep-link "Open in <app>?"
        // confirmation. The daemon taps it through acceptOpenInAppDialog while
        // simctl openurl is pending, before XCUITest interactions can race it.
        addUIInterruptionMonitor(withDescription: "System Alert") { alert in
            // Deliberate deny: when the session is configured with
            // notificationPermission == "denied", decline the notification
            // prompt (and only that prompt) so tests can exercise the
            // app's denied-state UI. Everything else stays allow-first.
            if SystemDialogPolicy.notificationPermission == "denied",
               SystemDialogPolicy.isNotificationPermissionAlert(alert.label) {
                for title in SystemDialogPolicy.notificationDenyButtonLabels {
                    let button = alert.buttons[title]
                    if button.exists {
                        button.tap()
                        NSLog("[TapsmithAgent] Declined notification prompt per configured policy")
                        return true
                    }
                }
                // No recognized deny button (localized simulator, or Apple
                // changed the wording). Never fall through to the allow
                // labels: iOS records notification authorization once per
                // bundle id, so a single Allow here would permanently
                // contradict the configured denied policy.
                NSLog("[TapsmithAgent] Notification prompt has no recognized deny button; leaving it unhandled (label: \(alert.label))")
                return false
            }
            for title in SystemDialogPolicy.allowButtonLabels {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }

        if attachToRunningApp {
            // When the daemon has already relaunched the app via simctl, attach
            // without triggering another runner-mediated launch. This avoids
            // Xcode 26 restoring stale navigation state during restartApp().
            app.activate()
        } else {
            // launch() implicitly terminates a running instance first, and on
            // a busy SpringBoard that terminate+relaunch handshake is the
            // classic "Timed out attempting to launch app" trigger. Terminate
            // explicitly so launch() always starts from a clean slate; a
            // not-running app makes this a fast no-op.
            app.terminate()
            app.launch()
        }
        // Step 3: Property-based disable on this instance AFTER launch().
        QuiescenceDisabler.disable(for: app)
        NSLog("[TapsmithAgent] Quiescence disabled")

        // Initialize all components
        let elementFinder = ElementFinder(app: app)
        let snapshotFinder = SnapshotElementFinder(app: app)
        let actionExecutor = ActionExecutor(app: app)
        let waitEngine = WaitEngine(app: app)
        let hierarchyDumper = HierarchyDumper(app: app)
        let commandHandler = CommandHandler(
            app: app,
            elementFinder: elementFinder,
            snapshotFinder: snapshotFinder,
            actionExecutor: actionExecutor,
            waitEngine: waitEngine,
            hierarchyDumper: hierarchyDumper
        )

        socketServer = SocketServer(port: port, commandHandler: commandHandler)

        NSLog("[TapsmithAgent] Agent started on port \(port)")

        // Block forever — the socket server runs on its own dispatch queue
        // and this test method must not return to keep the XCTest runner alive.
        socketServer?.start()
    }

    override func tearDown() {
        NSLog("[TapsmithAgent] Shutting down")
        socketServer?.stop()
        super.tearDown()
    }
}
