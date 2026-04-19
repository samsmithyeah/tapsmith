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
    private var app: XCUIApplication
    private var elementFinder: ElementFinder
    private var snapshotFinder: SnapshotElementFinder
    private var actionExecutor: ActionExecutor
    private var waitEngine: WaitEngine
    private var hierarchyDumper: HierarchyDumper

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

    private func targetBundleId(fallback params: [String: Any]? = nil) -> String {
        if let bundleId = params?["bundleId"] as? String, !bundleId.isEmpty { return bundleId }
        if let package = params?["package"] as? String, !package.isEmpty { return package }
        return ProcessInfo.processInfo.environment["PILOT_TARGET_BUNDLE_ID"] ?? ""
    }

    /// Dismiss any blocking iOS system dialog currently covering the app
    /// (e.g. "Save Password?", "Allow Notifications?", iCloud Keychain
    /// prompts). Returns true if a dialog was dismissed. Intended for
    /// physical iOS devices where iOS system UI can cover the app between
    /// test actions; simulators rarely show these dialogs.
    ///
    /// Some dialogs are hosted by SpringBoard (notifications, location
    /// permission prompts). Others — notably iCloud Keychain's "Save
    /// Password?" prompt — are presented as a remote view controller
    /// inside the target app's process via AuthenticationServices, so
    /// they appear under the target app's hierarchy, not SpringBoard.
    /// We check both. Order of labels matters — "Not Now" / "Don't Allow"
    /// come before "OK"/"Continue" so we never accidentally accept a
    /// permission grant when the intent was to decline.
    @discardableResult
    private func dismissBlockingSystemDialogs() -> Bool {
        let dismissalLabels = [
            "Not Now",
            "Don’t Allow",
            "Don't Allow",
            "Not now",
            "Dismiss",
            "Close",
            "Cancel",
        ]
        let sources: [XCUIApplication] = [
            app,
            XCUIApplication(bundleIdentifier: "com.apple.springboard"),
        ]
        for source in sources {
            for label in dismissalLabels {
                let button = source.buttons[label]
                if button.exists && button.isHittable {
                    button.tap()
                    Thread.sleep(forTimeInterval: 0.25)
                    return true
                }
            }
        }
        return false
    }

    /// Recreate the XCUIApplication and helper objects so the runner can
    /// rebind to a freshly relaunched app process without restarting xctrunner.
    private func rebindApp(bundleId: String? = nil) -> XCUIApplication {
        let resolvedBundleId = bundleId ?? targetBundleId()
        let refreshedApp = resolvedBundleId.isEmpty
            ? XCUIApplication()
            : XCUIApplication(bundleIdentifier: resolvedBundleId)
        // Re-apply instance-level quiescence disable on the new app object.
        // Class-level swizzling persists, but setWaitForQuiescence:false
        // is per-process-instance and needs to be set on each new XCUIApplication.
        QuiescenceDisabler.disable(for: refreshedApp)
        app = refreshedApp
        elementFinder = ElementFinder(app: refreshedApp)
        snapshotFinder = SnapshotElementFinder(app: refreshedApp)
        actionExecutor = ActionExecutor(app: refreshedApp)
        waitEngine = WaitEngine(app: refreshedApp)
        hierarchyDumper = HierarchyDumper(app: refreshedApp)
        return refreshedApp
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
    /// Returns nil if bounds are off-screen (e.g., scroll view children with
    /// stale snapshot coordinates), falling through to the XCUIElement path.
    private func snapshotCenter(for elementId: String) -> CGPoint? {
        guard let bounds = snapshotFinder.getBounds(elementId) else { return nil }
        guard bounds.width > 0 && bounds.height > 0 else { return nil }
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        // Reject off-screen coordinates — snapshot frames for scroll view
        // children can be stale/parent-relative, causing taps to miss.
        let screen = snapshotFinder.screenSize
        guard center.x >= 0 && center.y >= 0
                && center.x <= screen.width && center.y <= screen.height else {
            return nil
        }
        return center
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
                    // Before falling through to the wait engine, check for
                    // blocking iOS system dialogs (Save Password, Allow
                    // Notifications, etc.) that may be covering the target.
                    // Common on physical devices — iCloud Keychain can pop
                    // up after a sign-in tap and obscure post-login UI. If
                    // we dismiss one, try the snapshot once more before
                    // polling.
                    if dismissBlockingSystemDialogs() {
                        do {
                            let retried = try snapshotFinder.findElement(selector)
                            return retried.toDict()
                        } catch {
                            // Fall through to wait engine
                        }
                    }
                    if timeout >= 1000 {
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
                if let center = snapshotCenter(for: element.elementId) {
                    actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                } else {
                    let xcElem = try getXCUIElement(element.elementId)
                    try actionExecutor.tap(xcElem)
                }
            }
            // Force-flush pending touch events: take a snapshot() which does
            // a round-trip through the XCTest daemon. This acts as a barrier,
            // ensuring all pending XPC events (including the synthesized touch)
            // have been fully processed before we return. Without this, the
            // next command's snapshot IPC can race with touch delivery.
            touchBarrier()
            return ["success": true]

        case "doubleTap":
            let element = try resolveElement(params)
            if let center = snapshotCenter(for: element.elementId) {
                actionExecutor.doubleTapCoordinates(x: Int(center.x), y: Int(center.y))
            } else {
                let xcElem = try getXCUIElement(element.elementId)
                try actionExecutor.doubleTap(xcElem)
            }
            touchBarrier()
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
            touchBarrier()
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
            // The clearText backspace loop calls `resolveElement(params)`
            // between iterations to read a fresh `value`. If the caller
            // passed `elementId` only, that path returns the cached
            // snapshot info (whose `text` was captured at original
            // snapshot time) and the loop exits on iteration 1 thinking
            // "no progress" even when backspaces are working. Selectors
            // re-snapshot via the snapshot finder, so we require one.
            let selectorKeys = ["role", "id", "contentDesc", "className",
                                "testId", "hint", "textContains", "text",
                                "xpath"]
            let hasSelector = selectorKeys.contains { params[$0] != nil }
            if params["elementId"] != nil && !hasSelector {
                throw AgentError.invalidRequest(
                    "clearText requires a selector — elementId-only would " +
                        "reuse a stale snapshot value between iterations"
                )
            }
            let element = try resolveElement(params)
            // Refuse to "clear" non-text elements. The backspace loop below
            // assumes `element.text` reflects the editable value; on a
            // wrapper / button / static text it would compare against the
            // accessibility label, decide there's no progress, and exit
            // having typed up to one batch of backspaces — silently
            // mis-targeting whichever field happens to be focused.
            let textFieldClassNames: Set<String> = [
                "XCUIElementTypeTextField",
                "XCUIElementTypeSecureTextField",
                "XCUIElementTypeTextView",
                "XCUIElementTypeSearchField",
            ]
            guard textFieldClassNames.contains(element.className) else {
                throw AgentError.actionFailed(
                    "clearText only works on text input elements (got className=\(element.className))"
                )
            }
            // iOS text fields don't have a reliable "select all" gesture
            // (triple-tap selects a word; Cmd+A often misses on RN-wrapped
            // controls). Focus the field, try Cmd+A+Delete as a fast path,
            // then fall through to per-character backspaces if the field
            // isn't yet empty (common on RN wrappers that intercept Cmd+A).
            // We loop the backspace path because autocorrect / suggestion
            // bar / RN bridge updates can grow or shrink the value between
            // batches, so a single batch sized off the initial snapshot is
            // brittle.
            if let center = snapshotCenter(for: element.elementId) {
                actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
                Thread.sleep(forTimeInterval: 0.1)
            } else if let xcElem = try? getXCUIElement(element.elementId), xcElem.isHittable {
                xcElem.tap()
                // Match the snapshot path's 0.1s wait so the upcoming
                // Cmd+A / backspace keypress doesn't race the field
                // becoming first-responder.
                Thread.sleep(forTimeInterval: 0.1)
            } else {
                // Neither path could focus the field. Sending backspaces with
                // nothing focused either silently no-ops or mis-targets
                // whichever element happens to be focused — both worse than
                // failing loudly.
                throw AgentError.actionFailed(
                    "clearText could not focus element \(element.elementId): " +
                        "snapshot bounds were off-screen and the XCUIElement is not hittable"
                )
            }

            // Fast path: Cmd+A then a single backspace. Works on native
            // UITextField and on simulators with a hardware-keyboard
            // mapping; silently no-ops on RN-wrapped controls (which
            // typically don't honor Cmd+A) where we fall through to the
            // per-character loop.
            //
            // We deliberately use `\u{8}` (backspace) instead of
            // `XCUIKeyboardKey.delete` because:
            //   - if Cmd+A took, the keyboard backspace deletes the
            //     entire selection — fast clear in one event
            //   - if Cmd+A didn't take, the cursor is at the end and
            //     backspace deletes one trailing character. That's
            //     still progress; the loop below handles the rest.
            // Sending Delete after a failed selection would either
            // forward-delete (data loss past the cursor) or no-op
            // depending on the IME, hence the safer backspace.
            if EventSynthesizer.keyPress(key: "a", modifiers: .command) {
                Thread.sleep(forTimeInterval: 0.05)
                actionExecutor.typeTextWithoutFocus("\u{8}")
                Thread.sleep(forTimeInterval: 0.05)
                let afterSelectAll = (try? resolveElement(params)) ?? element
                if (afterSelectAll.text ?? "").isEmpty {
                    return ["success": true]
                }
                // Cmd+A didn't take (or deleted only one char). Fall
                // through to the per-character backspace loop, which
                // re-reads the value before each batch.
            }

            // Cap iterations so a misbehaving field can't hang the agent. The
            // per-iteration cap of 256 keystrokes covers any realistic field
            // length; multiple iterations let us mop up post-autocorrect
            // residue.
            let maxIterations = 16
            let perIterationCap = 256
            var lastLength: Int = .max
            var finalLength: Int = .max
            var iterationsRun = 0
            var stalled = false
            for _ in 0..<maxIterations {
                iterationsRun += 1
                let refreshed = (try? resolveElement(params)) ?? element
                let displayed = refreshed.text ?? ""
                finalLength = displayed.count
                if displayed.isEmpty {
                    // `deriveDisplayText` returns nil when the field's
                    // value equals its placeholder, so a snapshot-empty
                    // `text` could mean either "field is truly empty
                    // (placeholder showing)" or "user typed content that
                    // happens to differ from the placeholder but the
                    // snapshot lagged". Read the live `XCUIElement.value`
                    // directly to disambiguate. If the live value is
                    // non-empty AND differs from the placeholder, we have
                    // residual content the snapshot mis-classified —
                    // backspace a fresh batch instead of declaring success.
                    if let xc = try? getXCUIElement(refreshed.elementId),
                       let live = xc.value as? String,
                       !live.isEmpty,
                       live != (refreshed.hint ?? "") {
                        finalLength = live.count
                        // Update lastLength so the stall detector sees this
                        // iteration's length. Without it, lastLength stays
                        // at .max and the next iteration always passes the
                        // shrinking check — a true stall on this branch
                        // would never trip and we'd burn the full
                        // iteration cap before failing.
                        lastLength = finalLength
                        let count = min(finalLength, perIterationCap)
                        actionExecutor.typeTextWithoutFocus(
                            String(repeating: "\u{8}", count: count)
                        )
                        continue
                    }
                    break
                }
                // Exit only if the value isn't *shrinking*. Comparing whole
                // strings would prematurely stop on attributed-string /
                // autocorrect compositions where the visible text changes
                // but length still drops between batches; comparing length
                // tolerates that as progress.
                if displayed.count >= lastLength {
                    stalled = true
                    break
                }
                lastLength = displayed.count
                // String.count counts grapheme clusters — matches keyboard
                // backspace granularity for ASCII and composed emoji.
                let count = min(displayed.count, perIterationCap)
                actionExecutor.typeTextWithoutFocus(String(repeating: "\u{8}", count: count))
            }
            // If we didn't fully clear, surface the failure rather than
            // silently returning success with residual text in the field.
            // Distinguish "stalled" (backspaces aren't shrinking the value —
            // the field is rejecting input or the snapshot is stale) from
            // "hit the iteration cap" (the field is genuinely larger than
            // maxIterations × perIterationCap can clear) so the operator
            // knows whether to investigate the field or raise the cap.
            if finalLength > 0 {
                let reason = stalled
                    ? "backspace stopped shrinking the value " +
                        "(field rejected input or snapshot is stale)"
                    : "exhausted the \(maxIterations)-iteration cap " +
                        "(\(maxIterations * perIterationCap) keystrokes); " +
                        "field is larger than expected"
                throw AgentError.actionFailed(
                    "clearText could not empty element \(element.elementId): " +
                        "\(finalLength) grapheme cluster(s) remain after " +
                        "\(iterationsRun) iteration\(iterationsRun == 1 ? "" : "s") — \(reason)"
                )
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
            // Swipe generates scroll momentum that continues for 500ms+.
            // Use a longer settle than the standard touchBarrier so the
            // next command's snapshot doesn't capture mid-momentum positions.
            Thread.sleep(forTimeInterval: 0.2)
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
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
            let sourceEl: ElementInfo
            let targetEl: ElementInfo
            do {
                sourceEl = try snapshotFinder.findElement(sourceSel)
            } catch {
                sourceEl = try waitEngine.waitForElement(sourceSel, timeoutMs: timeout, elementFinder: elementFinder)
            }
            do {
                targetEl = try snapshotFinder.findElement(targetSel)
            } catch {
                targetEl = try waitEngine.waitForElement(targetSel, timeoutMs: timeout, elementFinder: elementFinder)
            }
            // Use snapshot bounds to avoid XCUIElement .frame IPC which can
            // trigger quiescence waits and hang/crash the XCTest session.
            let sourceFrame = snapshotFinder.getBounds(sourceEl.elementId)
                ?? CGRect(x: CGFloat(sourceEl.bounds.left), y: CGFloat(sourceEl.bounds.top),
                          width: CGFloat(sourceEl.bounds.width), height: CGFloat(sourceEl.bounds.height))
            let targetFrame = snapshotFinder.getBounds(targetEl.elementId)
                ?? CGRect(x: CGFloat(targetEl.bounds.left), y: CGFloat(targetEl.bounds.top),
                          width: CGFloat(targetEl.bounds.width), height: CGFloat(targetEl.bounds.height))
            try actionExecutor.drag(from: sourceFrame, to: targetFrame)
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
            let scale = Float(params["scale"] as? Double ?? 1.0)
            // Keep iOS pinch best-effort for now. XCUITest pinch APIs and
            // lower-level synthesized multi-touch are still destabilizing the
            // runner on Xcode 26, and the current e2e coverage only asserts
            // that the command completes without crashing the session.
            actionExecutor.pinch(at: .zero, scale: scale)
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
            // Reactivate the app via XCUIApplication.activate().
            // If the app was terminated, this launches a fresh process.
            // If running in background, this brings it to foreground.
            let targetApp = rebindApp(bundleId: targetBundleId(fallback: params))
            targetApp.activate()
            // Brief wait for the app to settle.
            Thread.sleep(forTimeInterval: 0.15)
            // Quick check for system dialogs without blocking.
            // Only check one button with a very short timeout to stay within
            // the daemon's 4-second command timeout for launchApp.
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let openButton = springboard.buttons["Open"]
            if openButton.exists {
                openButton.tap()
                Thread.sleep(forTimeInterval: 0.1)
            }
            // Dismiss "Save Password?" dialog from iOS Passwords framework.
            let notNow = springboard.buttons["Not Now"]
            if notNow.exists {
                notNow.tap()
                Thread.sleep(forTimeInterval: 0.1)
            }
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
            // On simulators the daemon handles deep links via
            // `xcrun simctl openurl`. On physical devices there's no
            // equivalent host-side mechanism, so the daemon routes here
            // and we call `XCUIApplication.open(url:)` which delivers the
            // URL via the target app's scene. This is Apple's supported
            // XCUITest path for URL-scheme deep links.
            let urlString = params["url"] as? String ?? ""
            guard !urlString.isEmpty, let url = URL(string: urlString) else {
                throw AgentError.actionFailed("openDeepLink: missing or invalid URL")
            }
            let bundleId = targetBundleId(fallback: params)
            let targetApp = rebindApp(bundleId: bundleId)
            // XCUIApplication.open(_:) requires iOS 16.4+. Our deployment
            // target is 15.0 to keep the runner compatible with older
            // devices, so we gate the call at runtime.
            if #available(iOS 16.4, *) {
                targetApp.open(url)
                Thread.sleep(forTimeInterval: 0.3)
                return ["success": true]
            } else {
                throw AgentError.actionFailed(
                    "openDeepLink requires iOS 16.4 or newer on physical devices"
                )
            }

        // ─── Orientation ───

        case "setOrientation":
            let orientation = params["orientation"] as? String ?? "portrait"
            let target: UIDeviceOrientation
            switch orientation.lowercased() {
            case "landscape":
                target = .landscapeLeft
            case "portrait":
                target = .portrait
            default:
                throw AgentError.actionFailed("Unknown orientation: \(orientation). Use portrait/landscape.")
            }
            // On simulators XCUIDevice.orientation is a straightforward
            // write. On physical devices iOS re-reads the accelerometer
            // almost immediately after the set and can revert if nothing is
            // driving UI re-layout. Write → settle → re-verify → optionally
            // retry once so the subsequent `getOrientation` observes the
            // requested state. If it still doesn't stick, fall through so
            // the caller sees whatever the device settled on — rotation
            // outside of Pilot's control is a valid platform state.
            XCUIDevice.shared.orientation = target
            Thread.sleep(forTimeInterval: 0.4)
            if XCUIDevice.shared.orientation != target {
                XCUIDevice.shared.orientation = target
                Thread.sleep(forTimeInterval: 0.4)
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
            // Check if keyboard is actually shown before attempting dismissal.
            // Without this, app.windows.firstMatch.frame.size below triggers a
            // quiescence wait (~30s hang) when no keyboard is present.
            let kbSnapshot = try? app.snapshot()
            let kbDict = kbSnapshot.map { $0.dictionaryRepresentation } ?? [:]
            guard hasKeyboardInSnapshot(kbDict) else {
                return ["success": true]
            }

            // Dismiss the keyboard using a tiny swipe gesture (Maestro's approach).
            // A small vertical swipe triggers keyboard dismissal via the scroll
            // interaction, bypassing keyboardShouldPersistTaps.
            Thread.sleep(forTimeInterval: 0.3) // Let keyboard fully appear/settle
            // Use cached screen size to avoid app.windows.firstMatch.frame.size
            // which triggers quiescence on Xcode 26.
            let kbScreenSize = snapshotFinder.screenSize
            let midX = CGFloat(kbScreenSize.width / 2)
            let midY = CGFloat(kbScreenSize.height / 2)
            // Try vertical swipe first
            if !EventSynthesizer.swipe(
                from: CGPoint(x: midX, y: midY),
                to: CGPoint(x: midX, y: midY - kbScreenSize.height * 0.03),
                duration: 0.05
            ) {
                // Fallback: tap above keyboard area
                actionExecutor.tapCoordinates(x: Int(midX), y: 15)
            }
            Thread.sleep(forTimeInterval: 0.5) // Wait for dismiss animation
            // If keyboard is still showing, try horizontal swipe
            _ = EventSynthesizer.swipe(
                from: CGPoint(x: midX, y: midY),
                to: CGPoint(x: midX - kbScreenSize.width * 0.03, y: midY),
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

    /// Settle time after synthesized gesture actions.
    ///
    /// Touch events travel: XCTest runner → testmanagerd (XPC) → IOKit →
    /// Simulator → App process → UIKit → React Native gesture handler.
    /// The `_XCT_synthesizeEvent` completion callback only confirms step 1.
    /// The remaining propagation takes ~50-100ms through IOKit and the
    /// simulator. Without this settle, the daemon's next command (typically
    /// `findElement` from assertion polling) can snapshot the app state
    /// before the gesture handler has fired, causing spurious failures.
    ///
    /// 60ms is sufficient on Apple Silicon / Xcode 26 for single and
    /// multi-touch events. The RunLoop pump additionally processes any
    /// pending XPC or GCD callbacks.
    private func touchBarrier() {
        Thread.sleep(forTimeInterval: 0.06)
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
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
