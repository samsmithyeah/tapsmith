import XCTest

/// Entry point for the Pilot iOS on-device agent.
///
/// This is an XCTestCase subclass that starts a TCP socket server and blocks
/// indefinitely, keeping the XCTest runner alive. The socket server accepts
/// JSON-RPC commands from the host daemon and dispatches them to XCUITest.
///
/// Launched via: xcodebuild test-without-building -xctestrun <path> -destination 'id=<udid>'
///
/// Mirrors the Android agent's PilotAgent.kt.
class PilotAgentRunner: XCTestCase {

    private static let defaultPort: UInt16 = 18700
    private static let envTargetBundleId = "PILOT_TARGET_BUNDLE_ID"
    private static let envPort = "PILOT_AGENT_PORT"

    private var socketServer: SocketServer?

    /// The main test method that starts the agent.
    /// This method intentionally never returns — it blocks to keep the XCTest
    /// runner alive so the socket server can continuously accept commands.
    func testRunAgent() {
        let bundleId = ProcessInfo.processInfo.environment[Self.envTargetBundleId] ?? ""
        let port = UInt16(ProcessInfo.processInfo.environment[Self.envPort] ?? "") ?? Self.defaultPort

        NSLog("[PilotAgent] Starting with target bundle: \(bundleId), port: \(port)")

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
        // Auto-dismiss system alerts (e.g., "Open in X?", permission prompts)
        // that would otherwise block XCUITest interactions.
        addUIInterruptionMonitor(withDescription: "System Alert") { alert in
            let allowButtons = ["Open", "Allow", "OK", "Allow While Using App",
                                "Allow Once", "Continue", "Dismiss"]
            for title in allowButtons {
                let button = alert.buttons[title]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }

        app.activate()
        // Step 3: Property-based disable on this instance AFTER activate().
        QuiescenceDisabler.disable(for: app)
        NSLog("[PilotAgent] Quiescence disabled")

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

        NSLog("[PilotAgent] Agent started on port \(port)")

        // Block forever — the socket server runs on its own dispatch queue
        // and this test method must not return to keep the XCTest runner alive.
        socketServer?.start()
    }

    override func tearDown() {
        NSLog("[PilotAgent] Shutting down")
        socketServer?.stop()
        super.tearDown()
    }
}
