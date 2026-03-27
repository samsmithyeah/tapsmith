import XCTest
import Foundation

/// Routes incoming JSON commands to the appropriate handler.
///
/// JSON protocol:
///   Request:  {"id": "uuid", "method": "methodName", "params": {...}}
///   Response: {"id": "uuid", "result": {...}}
///         or: {"id": "uuid", "error": {"type": "...", "message": "..."}}
///
/// Mirrors the Android agent's CommandHandler.kt.
class CommandHandler {
    private let app: XCUIApplication
    private let elementFinder: ElementFinder
    private let snapshotFinder: SnapshotElementFinder
    private let actionExecutor: ActionExecutor
    private let waitEngine: WaitEngine
    private let hierarchyDumper: HierarchyDumper

    /// Cache of last clipboard text set via setClipboard.
    private var lastClipboardText = ""

    init(
        app: XCUIApplication,
        elementFinder: ElementFinder,
        snapshotFinder: SnapshotElementFinder,
        actionExecutor: ActionExecutor,
        waitEngine: WaitEngine,
        hierarchyDumper: HierarchyDumper
    ) {
        self.app = app
        self.elementFinder = elementFinder
        self.snapshotFinder = snapshotFinder
        self.actionExecutor = actionExecutor
        self.waitEngine = waitEngine
        self.hierarchyDumper = hierarchyDumper
    }

    func handle(rawJson: String) -> String {
        guard let data = rawJson.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return errorResponse(id: nil, type: "PARSE_ERROR", message: "Invalid JSON")
        }

        let id = json["id"] as? String
        guard let method = json["method"] as? String else {
            return errorResponse(id: id, type: "INVALID_REQUEST", message: "Missing 'method' field")
        }

        let params = json["params"] as? [String: Any] ?? [:]

        do {
            let result = try dispatch(method: method, params: params)
            return successResponse(id: id, result: result)
        } catch let error as AgentError {
            return errorResponse(id: id, type: error.type, message: error.message)
        } catch {
            NSLog("[PilotCommand] Error handling method '\(method)': \(error)")
            return errorResponse(id: id, type: "INTERNAL_ERROR", message: error.localizedDescription)
        }
    }

    // MARK: - Coordinate-based actions (fast path)

    /// Get the center point of an element from the snapshot bounds cache.
    /// This avoids XCUIElement queries which trigger slow quiescence on Xcode 26.
    private func snapshotCenter(for elementId: String) -> CGPoint? {
        guard let bounds = snapshotFinder.getBounds(elementId) else { return nil }
        guard bounds.width > 0 && bounds.height > 0 else { return nil }
        return CGPoint(x: bounds.midX, y: bounds.midY)
    }

    // MARK: - Element Resolution

    /// Resolve an element from params, supporting both elementId (cached) and selector-based lookup.
    private func resolveElement(_ params: [String: Any]) throws -> ElementInfo {
        if let elementId = params["elementId"] as? String {
            // Try snapshot finder cache first, then fall back to old cache
            if let info = try? snapshotFinder.getElementInfo(elementId) {
                return info
            }
            return try elementFinder.getElementInfo(elementId)
        }
        let selector = SelectorParser.parse(params)
        // Use snapshot-based finding for speed (single IPC call)
        return try snapshotFinder.findElement(selector)
    }

    /// Get the XCUIElement for an element ID, checking both caches.
    private func getXCUIElement(_ elementId: String) throws -> XCUIElement {
        if let elem = try? snapshotFinder.getElement(elementId) {
            return elem
        }
        return try elementFinder.getElement(elementId)
    }

    // MARK: - Dispatch

    private func dispatch(method: String, params: [String: Any]) throws -> [String: Any] {
        switch method {

        // ─── Element Finding ───

        case "findElement":
            let selector = SelectorParser.parse(params)
            let parentId = params["parentId"] as? String
            let timeout = params["timeout"] as? Int64 ?? 10000
            let element: ElementInfo

            // Use snapshot-based finding (fast) for top-level queries.
            // Fall back to wait engine for queries that need polling.
            if parentId == nil {
                do {
                    element = try snapshotFinder.findElement(selector)
                } catch {
                    if timeout > 1000 {
                        // Element not in current snapshot — poll with wait engine
                        element = try waitEngine.waitForElement(selector, timeoutMs: timeout, elementFinder: elementFinder)
                    } else {
                        throw error
                    }
                }
            } else {
                element = try elementFinder.findElement(selector, parentId: parentId)
            }
            return element.toDict()

        case "findElements":
            let selector = SelectorParser.parse(params)
            let parentId = params["parentId"] as? String
            // Use snapshot finder for speed
            if parentId == nil {
                let elements = try snapshotFinder.findElements(selector)
                return ["elements": elements.map { $0.toDict() }]
            }
            let elements = try elementFinder.findElements(selector, parentId: parentId)
            return ["elements": elements.map { $0.toDict() }]

        // ─── Tap Actions ───

        case "tap":
            let x = params["x"] as? Int ?? -1
            let y = params["y"] as? Int ?? -1
            if x >= 0 && y >= 0 {
                actionExecutor.tapCoordinates(x: x, y: y)
            } else {
                let element = try resolveElement(params)
                // Prefer coordinate-based tap from snapshot bounds (fast, no quiescence wait)
                if let center = snapshotCenter(for: element.elementId) {
                    actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                } else {
                    let xcElem = try getXCUIElement(element.elementId)
                    try actionExecutor.tap(xcElem)
                }
            }
            return ["success": true]

        case "doubleTap":
            let element = try resolveElement(params)
            if let center = snapshotCenter(for: element.elementId) {
                actionExecutor.doubleTapCoordinates(x: Int(center.x), y: Int(center.y))
            } else {
                let xcElem = try getXCUIElement(element.elementId)
                try actionExecutor.doubleTap(xcElem)
            }
            return ["success": true]

        case "longPress":
            let duration = params["duration"] as? Int64 ?? 1000
            let x = params["x"] as? Int ?? -1
            let y = params["y"] as? Int ?? -1
            if x >= 0 && y >= 0 {
                actionExecutor.longPressCoordinates(x: x, y: y, durationMs: duration)
            } else {
                let element = try resolveElement(params)
                if let center = snapshotCenter(for: element.elementId) {
                    actionExecutor.longPressCoordinates(x: Int(center.x), y: Int(center.y), durationMs: duration)
                } else {
                    let xcElem = try getXCUIElement(element.elementId)
                    try actionExecutor.longPress(xcElem, durationMs: duration)
                }
            }
            return ["success": true]

        // ─── Text Input ───

        case "typeText":
            let text = params["text"] as? String ?? ""
            let selectorKeys = ["role", "id", "contentDesc", "className", "testId", "hint", "textContains", "elementId"]
            let hasSelector = selectorKeys.contains { params[$0] != nil }
            if hasSelector {
                // Remove "text" from params before resolving selector
                var selectorParams = params
                selectorParams.removeValue(forKey: "text")
                let element = try resolveElement(selectorParams)
                // Tap at coordinates to focus, wait for keyboard, then type
                if let center = snapshotCenter(for: element.elementId) {
                    actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                    // Wait for the keyboard to appear after focus tap.
                    // Maestro waits for app.keyboards.firstMatch.exists but that
                    // triggers quiescence. Use a fixed delay instead.
                    Thread.sleep(forTimeInterval: 0.5)
                    actionExecutor.typeTextWithoutFocus(text)
                } else {
                    let xcElem = try getXCUIElement(element.elementId)
                    try actionExecutor.typeText(xcElem, text: text)
                }
            } else {
                actionExecutor.typeTextWithoutFocus(text)
            }
            return ["success": true]

        case "clearText":
            let element = try resolveElement(params)
            // Tap to focus, triple-tap to select all, then delete
            if let center = snapshotCenter(for: element.elementId) {
                // Triple-tap to select all text in the field
                actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                Thread.sleep(forTimeInterval: 0.1)
                actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                Thread.sleep(forTimeInterval: 0.05)
                actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                Thread.sleep(forTimeInterval: 0.1)
                // Delete selected text
                actionExecutor.typeTextWithoutFocus("\u{8}") // backspace
            } else {
                let xcElem = try getXCUIElement(element.elementId)
                try actionExecutor.clearText(xcElem)
            }
            return ["success": true]

        // ─── Swipe / Scroll ───

        case "swipe":
            let direction = params["direction"] as? String ?? "up"
            let speed = params["speed"] as? Int ?? 5000
            let distance = params["distance"] as? Double ?? 0.5
            if let elementId = params["elementId"] as? String {
                let xcElem = try getXCUIElement(elementId)
                try actionExecutor.swipe(xcElem, direction: direction, speed: speed, distance: distance)
            } else if let startElement = params["startElement"] as? [String: Any] {
                let startSel = SelectorParser.parse(startElement)
                let startEl = try waitEngine.waitForElement(startSel, timeoutMs: 10000, elementFinder: elementFinder)
                let xcElem = try getXCUIElement(startEl.elementId)
                try actionExecutor.swipe(xcElem, direction: direction, speed: speed, distance: distance)
            } else {
                try actionExecutor.swipeScreen(direction: direction, speed: speed, distance: distance)
            }
            return ["success": true]

        case "scroll":
            let direction = params["direction"] as? String ?? "down"
            let targetSelector: ElementSelector?
            if let scrollTo = params["scrollTo"] as? [String: Any] {
                targetSelector = SelectorParser.parse(scrollTo)
            } else {
                targetSelector = nil
            }
            if let container = params["container"] as? [String: Any] {
                let containerSel = SelectorParser.parse(container)
                let containerEl = try waitEngine.waitForElement(containerSel, timeoutMs: 10000, elementFinder: elementFinder)
                let xcElem = try getXCUIElement(containerEl.elementId)
                try actionExecutor.scroll(xcElem, direction: direction, targetSelector: targetSelector)
            } else if let elementId = params["elementId"] as? String {
                let xcElem = try getXCUIElement(elementId)
                try actionExecutor.scroll(xcElem, direction: direction, targetSelector: targetSelector)
            } else {
                try actionExecutor.scrollScreen(direction: direction, targetSelector: targetSelector)
            }
            return ["success": true]

        // ─── Key Press ───

        case "pressKey":
            let key = params["key"] as? String ?? ""
            try actionExecutor.pressKey(key)
            return ["success": true]

        // ─── Drag and Drop ───

        case "dragAndDrop":
            guard let sourceParams = params["source"] as? [String: Any],
                  let targetParams = params["target"] as? [String: Any]
            else {
                throw AgentError.invalidRequest("dragAndDrop requires 'source' and 'target' params")
            }
            let sourceSel = SelectorParser.parse(sourceParams)
            let targetSel = SelectorParser.parse(targetParams)
            let timeout = params["timeout"] as? Int64 ?? 10000
            let sourceEl = try waitEngine.waitForElement(sourceSel, timeoutMs: timeout, elementFinder: elementFinder)
            let targetEl = try waitEngine.waitForElement(targetSel, timeoutMs: timeout, elementFinder: elementFinder)
            let sourceXC = try getXCUIElement(sourceEl.elementId)
            let targetXC = try getXCUIElement(targetEl.elementId)
            try actionExecutor.dragTo(source: sourceXC, target: targetXC)
            return ["success": true]

        // ─── Select Option ───

        case "selectOption":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            if let optionText = params["option"] as? String {
                try actionExecutor.selectOption(xcElem, optionText: optionText)
            } else if let index = params["index"] as? Int, index >= 0 {
                try actionExecutor.selectOptionByIndex(xcElem, index: index)
            } else {
                throw AgentError.invalidSelector("selectOption requires either 'option' (string) or 'index' (int)")
            }
            return ["success": true]

        // ─── Pinch Zoom ───

        case "pinchZoom":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            let scale = Float(params["scale"] as? Double ?? 1.0)
            try actionExecutor.pinchZoom(xcElem, scale: scale)
            return ["success": true]

        // ─── Focus / Blur ───

        case "focus":
            let element = try resolveElement(params)
            if let center = snapshotCenter(for: element.elementId) {
                actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
            } else {
                let xcElem = try getXCUIElement(element.elementId)
                try actionExecutor.focus(xcElem)
            }
            return ["success": true]

        case "blur":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            try actionExecutor.blur(xcElem)
            return ["success": true]

        case "highlight":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            let duration = params["duration"] as? Int64 ?? 1000
            try actionExecutor.highlight(xcElem, durationMs: duration)
            return ["success": true]

        // ─── Screenshots ───

        case "screenshot":
            let screenshot = XCUIScreen.main.screenshot()
            let pngData = screenshot.pngRepresentation
            let base64 = pngData.base64EncodedString()
            return ["data": base64, "format": "png"]

        case "elementScreenshot":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            let screenshot = xcElem.screenshot()
            let pngData = screenshot.pngRepresentation
            let base64 = pngData.base64EncodedString()
            return ["data": base64, "format": "png"]

        // ─── UI Hierarchy ───

        case "getUiHierarchy":
            let xml = hierarchyDumper.dump()
            return ["hierarchy": xml]

        // ─── Wait ───

        case "waitForIdle":
            let timeout = params["timeout"] as? Int64 ?? 5000
            waitEngine.waitForIdle(timeoutMs: timeout)
            return ["success": true]

        case "waitForElement":
            let selector = SelectorParser.parse(params)
            let timeout = params["timeout"] as? Int64 ?? 10000
            let element = try waitEngine.waitForElement(selector, timeoutMs: timeout, elementFinder: elementFinder)
            return element.toDict()

        // ─── Clipboard ───

        case "setClipboard":
            let text = params["text"] as? String ?? ""
            lastClipboardText = text
            UIPasteboard.general.string = text
            return ["success": true]

        case "getClipboard":
            let text = UIPasteboard.general.string ?? lastClipboardText
            return ["text": text]

        // ─── App Lifecycle ───

        case "launchApp":
            // Relaunch the app via XCUIApplication.launch().
            // This terminates any running instance and starts a fresh
            // process, re-establishing the accessibility bridge without
            // requiring an agent restart.
            app.launch()
            Thread.sleep(forTimeInterval: 0.5)
            return ["success": true]

        case "terminateApp":
            let bundleId = params["bundleId"] as? String ?? params["package"] as? String
            if let bundleId = bundleId {
                let targetApp = XCUIApplication(bundleIdentifier: bundleId)
                targetApp.terminate()
            } else {
                app.terminate()
            }
            return ["success": true]

        case "getAppState":
            let bundleId = params["bundleId"] as? String ?? params["package"] as? String ?? ""
            let targetApp = XCUIApplication(bundleIdentifier: bundleId)
            let state: String
            switch targetApp.state {
            case .notRunning: state = "stopped"
            case .runningBackground, .runningBackgroundSuspended: state = "background"
            case .runningForeground: state = "foreground"
            case .unknown: state = "stopped"
            @unknown default: state = "stopped"
            }
            return ["state": state]

        case "currentPackage":
            // On iOS, report the target app's bundle ID
            // XCUIApplication doesn't expose bundleID directly.
            // The target bundle ID is set via environment variable at launch.
            let bundleId = ProcessInfo.processInfo.environment["PILOT_TARGET_BUNDLE_ID"] ?? ""
            return ["package": bundleId]

        case "openDeepLink":
            // Deep links are handled by the daemon via xcrun simctl openurl
            // The agent can also open URLs via the app
            let uri = params["uri"] as? String ?? ""
            if !uri.isEmpty {
                let safariApp = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
                safariApp.launch()
                // Navigate to URL
                let urlField = safariApp.textFields.firstMatch
                if urlField.waitForExistence(timeout: 5) {
                    urlField.tap()
                    urlField.typeText(uri + "\n")
                }
            }
            return ["success": true]

        // ─── Orientation ───

        case "setOrientation":
            let orientation = params["orientation"] as? String ?? "portrait"
            switch orientation.lowercased() {
            case "landscape":
                XCUIDevice.shared.orientation = .landscapeLeft
            case "portrait":
                XCUIDevice.shared.orientation = .portrait
            default:
                throw AgentError.actionFailed("Unknown orientation: \(orientation). Use portrait/landscape.")
            }
            return ["success": true]

        case "getOrientation":
            let orientation: String
            switch XCUIDevice.shared.orientation {
            case .landscapeLeft, .landscapeRight: orientation = "landscape"
            default: orientation = "portrait"
            }
            return ["orientation": orientation]

        // ─── Keyboard ───

        case "isKeyboardShown":
            // Use snapshot to check for keyboard instead of app.keyboards.count
            // which triggers quiescence waiting on Xcode 26.
            let snapshot = try? app.snapshot()
            let dict = snapshot.map { $0.dictionaryRepresentation } ?? [:]
            let shown = hasKeyboardInSnapshot(dict)
            return ["shown": shown]

        case "hideKeyboard":
            // Dismiss the keyboard using a tiny swipe gesture (Maestro's approach).
            // A small vertical swipe triggers keyboard dismissal via the scroll
            // interaction, bypassing keyboardShouldPersistTaps.
            Thread.sleep(forTimeInterval: 0.3) // Let keyboard fully appear/settle
            let screenSize = app.windows.firstMatch.frame.size
            let midX = CGFloat(screenSize.width / 2)
            let midY = CGFloat(screenSize.height / 2)
            // Try vertical swipe first
            if !EventSynthesizer.swipe(
                from: CGPoint(x: midX, y: midY),
                to: CGPoint(x: midX, y: midY - screenSize.height * 0.03),
                duration: 0.05
            ) {
                // Fallback: tap above keyboard area
                actionExecutor.tapCoordinates(x: Int(midX), y: 15)
            }
            Thread.sleep(forTimeInterval: 0.5) // Wait for dismiss animation
            // If keyboard is still showing, try horizontal swipe
            _ = EventSynthesizer.swipe(
                from: CGPoint(x: midX, y: midY),
                to: CGPoint(x: midX - screenSize.width * 0.03, y: midY),
                duration: 0.05
            )
            Thread.sleep(forTimeInterval: 0.3)
            return ["success": true]

        // ─── Color Scheme ───

        case "setColorScheme":
            // Color scheme changes are typically handled by the daemon via xcrun simctl ui
            // The agent cannot directly change the system appearance
            let scheme = params["scheme"] as? String ?? "light"
            NSLog("[PilotCommand] setColorScheme '\(scheme)' — handled by daemon via simctl")
            return ["success": true]

        case "getColorScheme":
            let style = UITraitCollection.current.userInterfaceStyle
            let scheme: String
            switch style {
            case .dark: scheme = "dark"
            default: scheme = "light"
            }
            return ["scheme": scheme]

        // ─── Permissions ───

        case "grantPermission", "revokePermission":
            // Permissions are handled by the daemon via xcrun simctl privacy
            NSLog("[PilotCommand] \(method) — handled by daemon via simctl")
            return ["success": true]

        // ─── Ping ───

        case "ping":
            return ["pong": true]

        default:
            throw AgentError.actionFailed("Unknown method: \(method)")
        }
    }

    // MARK: - JSON Response Builders

    private func successResponse(id: String?, result: [String: Any]) -> String {
        let response: [String: Any] = [
            "id": id as Any? ?? NSNull(),
            "result": result,
        ]
        return jsonString(response) ?? "{\"id\":null,\"error\":{\"type\":\"INTERNAL_ERROR\",\"message\":\"Failed to serialize response\"}}"
    }

    private func errorResponse(id: String?, type: String, message: String) -> String {
        let response: [String: Any] = [
            "id": id as Any? ?? NSNull(),
            "error": [
                "type": type,
                "message": message,
            ],
        ]
        return jsonString(response) ?? "{\"id\":null,\"error\":{\"type\":\"INTERNAL_ERROR\",\"message\":\"Failed to serialize error response\"}}"
    }

    private func jsonString(_ dict: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Check if a keyboard is visible in the snapshot tree by looking for
    /// the Keyboard element type (elementType 56 = XCUIElement.ElementType.keyboard).
    private func hasKeyboardInSnapshot(_ dict: [XCUIElement.AttributeName: Any]) -> Bool {
        if let typeRaw = dict[XCUIElement.AttributeName(rawValue: "elementType")] as? UInt,
           typeRaw == XCUIElement.ElementType.keyboard.rawValue {
            return true
        }
        if let children = dict[XCUIElement.AttributeName(rawValue: "children")] as? [[XCUIElement.AttributeName: Any]] {
            for child in children {
                if hasKeyboardInSnapshot(child) { return true }
            }
        }
        return false
    }
}
