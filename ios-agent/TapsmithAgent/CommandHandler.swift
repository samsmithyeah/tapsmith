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

    // Interactive-mirror live-drag: iOS can't stream touches, so buffer the
    // path during the drag and dispatch it as one gesture on touchUp.
    // touchDown/Move/Up/Cancel arrive on gRPC pool threads, so all access to
    // touchPath is guarded by touchPathLock (Swift Array is not thread-safe).
    private var touchPath: [(CGPoint, TimeInterval)] = []
    private let touchPathLock = NSLock()

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
        return ProcessInfo.processInfo.environment["TAPSMITH_TARGET_BUNDLE_ID"] ?? ""
    }

    /// Accept SpringBoard's custom URL-scheme confirmation ("Open in <app>?")
    /// if it is covering the app after a deep-link launch.
    ///
    /// We tap Open, not Cancel: on a fresh simulator the confirmation can gate
    /// URL delivery, so cancelling leaves the deep link undelivered.
    @discardableResult
    private func acceptOpenInAppDialogIfPresent(
        springboard: XCUIApplication? = nil,
        timeout: TimeInterval = 0.0
    ) -> Bool {
        let sb = springboard ?? XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let openButton = sb.buttons["Open"]
        var exists = false
        _ = ObjCExceptionCatcher.catchException {
            exists = openButton.waitForExistence(timeout: timeout)
        }
        if exists {
            _ = ObjCExceptionCatcher.catchException {
                openButton.tap()
            }
            Thread.sleep(forTimeInterval: 0.2)
            return true
        }
        return false
    }

    /// True when the app's accessibility tree has rendered interactive content.
    ///
    /// Uses `app.snapshot()` — the same mechanism as `GetUiHierarchy` — rather
    /// than direct element queries (`app.staticTexts.firstMatch.exists`). After
    /// a deep link the daemon cold-launches the target app out of process via
    /// `simctl openurl`; XCUITest has not "attached" to a process it did not
    /// launch, so `XCUIApplication.state` and direct element existence queries
    /// are unreliable during that window (they report not-running / empty even
    /// while the app is foreground and fully rendered). `snapshot()` works in
    /// that same window, which is why hierarchy dumps succeed when the state
    /// query does not.
    private func appHasRenderedContent(_ app: XCUIApplication) -> Bool {
        var has = false
        _ = ObjCExceptionCatcher.catchException {
            guard let snapshot = try? app.snapshot() else { return }
            has = snapshotContainsContent(snapshot)
        }
        return has
    }

    /// Recursively check whether a snapshot tree contains any rendered,
    /// user-meaningful element (text, input, or control).
    private func snapshotContainsContent(_ snapshot: XCUIElementSnapshot) -> Bool {
        switch snapshot.elementType {
        case .staticText, .textField, .secureTextField, .textView, .searchField,
             .button, .link, .image, .switch:
            return true
        default:
            break
        }
        for child in snapshot.children where snapshotContainsContent(child) {
            return true
        }
        return false
    }

    private func safeAppState(_ app: XCUIApplication) -> XCUIApplication.State {
        var state: XCUIApplication.State = .unknown
        _ = ObjCExceptionCatcher.catchException {
            state = app.state
        }
        return state
    }

    /// Dismiss SpringBoard's "Open in <app>?" confirmation and wait for the
    /// target app to actually render content after a deep-link launch.
    ///
    /// Readiness is detected via `app.snapshot()` (content present) and SpringBoard
    /// queries (dialog accepted) — both work for the out-of-process, simctl-launched
    /// target app. We deliberately do NOT gate on `XCUIApplication.state`: it is
    /// unreliable until XCUITest attaches to the externally-launched process, and
    /// gating on it caused deep links that had actually reached their destination
    /// to be reported as failures.
    ///
    /// Returns true ONLY when the app has rendered content. On timeout it returns
    /// false — the first cold, trust-gated openurl on a fresh sim intermittently
    /// fails to foreground the app (it lands back on SpringBoard with no dialog),
    /// and the daemon re-delivers the deep link when we report not-delivered. We
    /// must NOT treat "no dialog" as success, or a never-launched app would be
    /// reported as ready and the next action would run against SpringBoard.
    private func waitForDeepLinkDestination(_ app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            // One SpringBoard query per iteration: acceptOpenInAppDialogIfPresent
            // with timeout 0.0 is `.exists` + tap in a single call. If it taps a
            // dialog, loop again; otherwise check for rendered content.
            if self.acceptOpenInAppDialogIfPresent(springboard: springboard, timeout: 0.0) {
                // Dialog accepted — re-check on the next iteration.
            } else if appHasRenderedContent(app) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return false
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
        if acceptOpenInAppDialogIfPresent(timeout: 0.1) {
            return true
        }

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
        // Eagerly cache the screen size, but tolerate a transient XCUITest
        // interruption: `screenSize` probes `app.windows.firstMatch.frame`, a
        // direct query that can raise an "Interrupting test" NSException while
        // SpringBoard is still settling (e.g. right after a deep-link launch).
        // On failure leave the cache unset — ActionExecutor resolves it lazily
        // on next use — so re-binding never fails a command that already
        // succeeded.
        _ = ObjCExceptionCatcher.catchException {
            actionExecutor.cachedScreenSize = snapshotFinder.screenSize
        }
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
            var result: [String: Any]?
            var swiftError: Error?

            // Wrap in ObjC @try/@catch to prevent NSExceptions from
            // XCUITest private APIs from crashing the agent process.
            // Swift's do/catch only catches Swift Error types — ObjC
            // NSExceptions bypass it entirely and terminate the process.
            let objcError = ObjCExceptionCatcher.catchException {
                do {
                    result = try self.dispatch(method: method, params: params)
                } catch {
                    swiftError = error
                }
            }

            if let error = swiftError {
                throw error
            }
            if let objcError = objcError {
                let msg = objcError.localizedDescription
                NSLog("[TapsmithCommand] ObjC exception in method '\(method)': \(msg)")
                return errorResponse(id: id, type: "INTERNAL_ERROR", message: msg)
            }
            guard let result = result else {
                return errorResponse(id: id, type: "INTERNAL_ERROR", message: "Command dispatch returned no result")
            }
            return successResponse(id: id, result: result)
        } catch let error as AgentError {
            return errorResponse(id: id, type: error.type, message: error.message)
        } catch {
            NSLog("[TapsmithCommand] Error handling method '\(method)': \(error)")
            return errorResponse(id: id, type: "INTERNAL_ERROR", message: error.localizedDescription)
        }
    }

    // MARK: - Coordinate-based actions (fast path)

    /// Get the center point of an element, refreshing bounds from a live
    /// XCUIElement read to minimize the TOCTOU window between coordinate
    /// resolution and the subsequent tap/gesture action.
    ///
    /// Falls back to cached snapshot bounds if the live refresh fails.
    /// Returns nil if bounds are off-screen (e.g., scroll view children with
    /// stale snapshot coordinates), falling through to the XCUIElement path.
    private func snapshotCenter(for elementId: String) -> CGPoint? {
        // refreshBounds takes a live frame read from the cached XCUIElement,
        // falling back to the snapshot-time bounds if unavailable.
        guard let bounds = snapshotFinder.refreshBounds(for: elementId) else { return nil }
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
    ///
    /// **Cost:** elementId path is several live `XCUIElement` property
    /// reads (~6–10 IPC) via `getElementInfo`; selector path is one
    /// `app.snapshot()` IPC + tree walk. The selector path is usually
    /// cheaper for repeated lookups against a fresh state because it
    /// re-reads the whole tree in one IPC instead of N attribute IPCs.
    /// Loops that re-resolve the same element across iterations (e.g.
    /// the `clearText` backspace loop) should prefer the selector
    /// form so each pass sees a fresh snapshot.
    private func resolveElement(_ params: [String: Any]) throws -> ElementInfo {
        if let elementId = params["elementId"] as? String {
            // Try snapshot finder cache first, then fall back to old cache
            if let info = try? snapshotFinder.getElementInfo(elementId) {
                return info
            }
            return try elementFinder.getElementInfo(elementId)
        }
        let selector = SelectorParser.parse(params)
        if selector.xpath != nil {
            return try elementFinder.findElement(selector)
        }
        // Use snapshot-based finding for speed (single IPC call)
        return try snapshotFinder.findElement(selector)
    }

    /// Resolve one end of a drag (source/target) from its params: a cached
    /// elementId when present, else a selector resolved against the given
    /// timeout. Mirrors `resolveElement` but the timeout lives on the parent
    /// dragAndDrop command, not these nested objects.
    private func resolveDragEnd(_ params: [String: Any], timeoutMs: Int64) throws -> ElementInfo {
        if let elementId = params["elementId"] as? String {
            if let info = try? snapshotFinder.getElementInfo(elementId) {
                return info
            }
            return try elementFinder.getElementInfo(elementId)
        }
        let selector = SelectorParser.parse(params)
        do {
            return try snapshotFinder.findElement(selector)
        } catch {
            return try waitEngine.waitForElement(
                selector,
                timeoutMs: timeoutMs,
                elementFinder: elementFinder,
                snapshotFinder: snapshotFinder
            )
        }
    }

    /// Get the XCUIElement for an element ID, checking both caches.
    ///
    /// **Cost:** O(1) cache lookup, no IPC. The IPC happens later when
    /// the caller reads a property off the returned element — each
    /// `.value`, `.label`, `.frame`, `.isHittable` access crosses
    /// the test runner ↔ app boundary. Batch property reads or
    /// prefer `resolveElement` (which dumps everything in one
    /// snapshot pass) when you need more than one attribute.
    private func getXCUIElement(_ elementId: String) throws -> XCUIElement {
        if let elem = try? snapshotFinder.getElement(elementId) {
            return elem
        }
        return try elementFinder.getElement(elementId)
    }


    /// Tap a resolved element. Always attempt XCUIElement.tap() first —
    /// synthesized coordinate events are unreliable with UIKit/RN gesture
    /// recognizers regardless of element type. Coordinate synthesis is
    /// only used as a fallback when XCUIElement.tap() fails (e.g. element
    /// is not hittable).
    private func tapResolvedElement(_ element: ElementInfo) throws {
        var firstError: Error?
        do {
            let xcElem = try getXCUIElement(element.elementId)
            try actionExecutor.tap(xcElem)
            return
        } catch {
            firstError = error
            NSLog(
                "[TapsmithCommand] XCUIElement.tap failed for \(element.elementId): \(error.localizedDescription), falling back to coordinate tap"
            )
        }

        if let center = snapshotCenter(for: element.elementId) {
            actionExecutor.tapCoordinates(x: Int(center.x), y: Int(center.y))
            return
        }

        throw firstError!
    }

    /// Double-tap a resolved element. Prefer XCUIElement.doubleTap() because
    /// UIKit/RN gesture recognizers handle it more consistently than raw
    /// coordinate double-taps on CI simulators. Use coordinate synthesis only
    /// as a fallback when the cached XCUIElement path is unavailable.
    private func doubleTapResolvedElement(_ element: ElementInfo, intervalMs: Int) throws {
        var firstError: Error?
        do {
            let xcElem = try getXCUIElement(element.elementId)
            try actionExecutor.doubleTap(xcElem)
            return
        } catch {
            firstError = error
            let message = "[TapsmithCommand] XCUIElement.doubleTap failed " +
                "for \(element.elementId): \(error.localizedDescription), " +
                "falling back to coordinate doubleTap"
            NSLog(message)
        }

        if let center = snapshotCenter(for: element.elementId) {
            actionExecutor.doubleTapCoordinates(
                x: Int(center.x),
                y: Int(center.y),
                intervalMs: intervalMs
            )
            return
        }

        throw firstError!
    }

    /// Tap inside a text input, biased toward the trailing edge so refocusing
    /// during retries keeps the insertion point at the end of the current
    /// value instead of moving it into the middle of existing text.
    private func focusElementForTyping(_ element: ElementInfo, settleTime: TimeInterval) throws {
        let bounds = element.bounds
        if bounds.width > 0 && bounds.height > 0 {
            let inset = min(12, max(1, bounds.width / 4))
            let x = CGFloat(max(bounds.left + 1, bounds.right - inset))
            let y = CGFloat(bounds.centerY)
            let screen = snapshotFinder.screenSize
            if x >= 0 && y >= 0 && x <= screen.width && y <= screen.height {
                actionExecutor.tapCoordinates(x: Int(x), y: Int(y))
                snapshotFinder.recordFocusedTextInputHint(element)
                waitForKeyboardAppearance(maxWait: settleTime)
                return
            }
        }

        let xcElem = try getXCUIElement(element.elementId)
        guard xcElem.isHittable else {
            throw AgentError.actionFailed("Element is not hittable — cannot type text")
        }
        xcElem.tap()
        snapshotFinder.recordFocusedTextInputHint(element)
        waitForKeyboardAppearance(maxWait: settleTime)
    }

    private func waitForKeyboardAppearance(maxWait: TimeInterval) {
        let deadline = CFAbsoluteTimeGetCurrent() + maxWait
        while CFAbsoluteTimeGetCurrent() < deadline {
            let snap = try? app.snapshot()
            let dict = snap.map { $0.dictionaryRepresentation } ?? [:]
            if hasKeyboardInSnapshot(dict) { return }
            Thread.sleep(forTimeInterval: 0.15)
        }
    }

    /// Type through EventSynthesizer, but don't advance to the next grapheme
    /// until the target field's snapshot reflects the current one. This fixes
    /// slow CI simulators dropping an in-string character (e.g. "test" ->
    /// "tet"), which suffix-only verification cannot repair.
    private func typeTextWithPerGraphemeVerification(
        _ text: String,
        selectorParams: [String: Any],
        initialElement: ElementInfo,
        delayMs: Int
    ) throws {
        let isSecureField = initialElement.className == "XCUIElementTypeSecureTextField"
        var expectedValue = initialElement.text ?? ""
        var expectedLength = expectedValue.count
        let timeoutPerGrapheme = max(1.0, TimeInterval(delayMs) / 1000.0 * 5.0)
        let pollInterval = 0.02
        let maxAttempts = 3

        for grapheme in text {
            let next = String(grapheme)

            // Single-line UITextField treats Return as submit/blur. After that
            // the original field no longer receives trailing input, so preserve
            // the existing iOS behavior tested by selector-regressions.
            if next == "\n" && initialElement.className != "XCUIElementTypeTextView" {
                if !actionExecutor.typeViaEventSynthesizer(next) {
                    throw AgentError.actionFailed("typeText failed to synthesize Return key")
                }
                Thread.sleep(forTimeInterval: max(0.05, TimeInterval(delayMs) / 1000.0))
                return
            }

            let beforeValue = expectedValue
            let beforeLength = expectedLength
            expectedValue += next
            expectedLength += 1

            var delivered = false
            var lastObserved = beforeValue

            for attempt in 1...maxAttempts {
                if !actionExecutor.typeViaEventSynthesizer(next) {
                    NSLog("[typeText] EventSynthesizer returned false for grapheme '\(next)'")
                }

                let deadline = Date(timeIntervalSinceNow: timeoutPerGrapheme)
                while Date() < deadline {
                    let fresh = try resolveElement(selectorParams)
                    let current = fresh.text ?? ""
                    lastObserved = current

                    if isSecureField {
                        if current.count == expectedLength {
                            delivered = true
                            break
                        }
                        if current.count > expectedLength {
                            throw AgentError.actionFailed(
                                "typeText produced extra secure-field input: " +
                                    "expected length \(expectedLength), got \(current.count)"
                            )
                        }
                    } else {
                        if current == expectedValue {
                            delivered = true
                            break
                        }
                        if current != beforeValue && !expectedValue.hasPrefix(current) {
                            throw AgentError.actionFailed(
                                "typeText diverged after grapheme '\(next)': " +
                                    "expected prefix '\(expectedValue)', got '\(current)'"
                            )
                        }
                    }

                    RunLoop.current.run(
                        mode: .default,
                        before: Date(timeIntervalSinceNow: pollInterval)
                    )
                }

                if delivered { break }
                NSLog(
                    "[typeText] Retry \(attempt) for grapheme '\(next)': " +
                        "expected '\(expectedValue)', got '\(lastObserved)'"
                )
                if lastObserved == beforeValue {
                    let refreshed = try resolveElement(selectorParams)
                    try focusElementForTyping(refreshed, settleTime: 0.25)
                }
            }

            guard delivered else {
                let expectedDescription = isSecureField
                    ? "length \(expectedLength)"
                    : "'\(expectedValue)'"
                let observedDescription = isSecureField
                    ? "length \(lastObserved.count)"
                    : "'\(lastObserved)'"
                throw AgentError.actionFailed(
                    "typeText could not deliver grapheme '\(next)': " +
                        "expected \(expectedDescription), got \(observedDescription) " +
                        "(previous length \(beforeLength))"
                )
            }

            if delayMs > 0 {
                Thread.sleep(forTimeInterval: TimeInterval(delayMs) / 1000.0)
            }
        }
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
                        element = try waitEngine.waitForElement(
                            selector,
                            timeoutMs: timeout,
                            elementFinder: elementFinder,
                            snapshotFinder: snapshotFinder
                        )
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
            // Coordinates arrive as JSON numbers (NSNumber) and may be
            // fractional logical points (coordinate taps from the SDK /
            // UI-mode mirror), so `as? Int` would fail — go via NSNumber.
            let x = (params["x"] as? NSNumber)?.intValue ?? -1
            let y = (params["y"] as? NSNumber)?.intValue ?? -1
            if x >= 0 && y >= 0 {
                actionExecutor.tapCoordinates(x: x, y: y)
                snapshotFinder.recordFocusedTextInputHint(at: CGPoint(x: CGFloat(x), y: CGFloat(y)))
            } else {
                let element = try resolveElement(params)
                try tapResolvedElement(element)
                snapshotFinder.recordFocusedTextInputHint(element)
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
            let intervalMs = params["intervalMs"] as? Int ?? 0
            try doubleTapResolvedElement(element, intervalMs: intervalMs)
            touchBarrier()
            return ["success": true]

        case "longPress":
            // NSNumber coercion: JSON numbers aren't directly castable to Int/
            // Int64, and coordinates may be fractional logical points.
            let duration = (params["duration"] as? NSNumber)?.int64Value ?? 1000
            let x = (params["x"] as? NSNumber)?.intValue ?? -1
            let y = (params["y"] as? NSNumber)?.intValue ?? -1
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
            if text.isEmpty {
                return ["success": true]
            }
            let delayMs = params["typingDelayMs"] as? Int ?? 0
            let selectorKeys = [
                "role", "id", "contentDesc", "className", "testId",
                "hint", "textContains", "elementId", "focused",
                "label", "xpath", "resourceId", "parent", "parentId",
                "enabled", "checked", "selected", "expanded",
            ]
            let hasSelector = selectorKeys.contains { params[$0] != nil }
            let isFocusedOnlySelector = (
                (params["focused"] as? Bool) == true
                && selectorKeys.allSatisfy { $0 == "focused" || params[$0] == nil }
            )
            if hasSelector && !(isFocusedOnlySelector && delayMs == 0) {
                var selectorParams = params
                selectorParams.removeValue(forKey: "text")
                selectorParams.removeValue(forKey: "typingDelayMs")
                if isFocusedOnlySelector {
                    waitForKeyboardAppearance(maxWait: 1.0)
                }
                let element = try resolveElement(selectorParams)
                if !isFocusedOnlySelector {
                    try focusElementForTyping(element, settleTime: 0.5)
                }
                if delayMs > 0 {
                    let focused = isFocusedOnlySelector ? element : try resolveElement(selectorParams)
                    try typeTextWithPerGraphemeVerification(
                        text,
                        selectorParams: selectorParams,
                        initialElement: focused,
                        delayMs: delayMs
                    )
                } else if !actionExecutor.typeViaEventSynthesizer(text, delayMs: delayMs) {
                    throw AgentError.actionFailed("typeText failed to synthesize input")
                }
            } else {
                if !actionExecutor.typeTextWithoutFocus(text, delayMs: delayMs) {
                    throw AgentError.actionFailed("typeText failed to synthesize input")
                }
            }
            return ["success": true]

        case "clearText":
            // The backspace loop re-resolves via `resolveElement(params)`
            // each iteration to get a fresh snapshot-based text value.
            // Reading `XCUIElement.value` directly was tried (cold-10 #1)
            // and reverted (32b0fa7): the cached XCUIElement query uses
            // `descendants(matching: .any).firstMatch` without a type
            // filter, so it can resolve to a non-input sibling (e.g. an
            // "Email" header) instead of the textfield — making the loop
            // think the field is already empty. The snapshot path's
            // role/type filter avoids this.
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
            // No-op fast path: if the snapshot already shows the field
            // empty AND the live `XCUIElement.value` agrees (placeholder-
            // mis-classification disambiguation, mirroring the iter-1
            // guard in the backspace loop below), skip everything —
            // tap-to-focus, Cmd+A, the resolve round-trips, all of it.
            // Test setup commonly calls `clear()` defensively on every
            // field; a no-op clear used to cost ~150ms per call (one tap,
            // 0.1s wait, Cmd+A, 0.05s wait, backspace, 0.05s wait,
            // resolveElement). For a setup that pre-clears a half-dozen
            // fields that adds up to roughly a second per test.
            if (element.text ?? "").isEmpty {
                let xc = try? getXCUIElement(element.elementId)
                if let xc = xc {
                    let live = (xc.value as? String) ?? ""
                    if live.isEmpty || live == (element.hint ?? "") {
                        return ["success": true]
                    }
                }
                // If getXCUIElement failed, don't trust a potentially
                // stale snapshot — fall through and attempt the clear.
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
                Thread.sleep(forTimeInterval: 0.1)
                actionExecutor.typeTextWithoutFocus("\u{8}")
                Thread.sleep(forTimeInterval: 0.15)
                let afterSelectAll = (try? resolveElement(params)) ?? element
                if (afterSelectAll.text ?? "").isEmpty {
                    try? focusElementForTyping(afterSelectAll, settleTime: 0.1)
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
            //
            // We re-resolve via the snapshot finder rather than reading
            // `XCUIElement.value` directly: the snapshot path applies the
            // selector's role/type filter during its tree walk, so it
            // matches the right textfield. The cached XCUIElement query
            // is built with `descendants(matching: .any).firstMatch` (no
            // type constraint, to support RN's `.other`-typed buttons),
            // and `firstMatch` can resolve to the wrong element when
            // multiple nodes share a label — e.g. an "Email" header label
            // sitting above the email textfield will be picked instead of
            // the textfield, and its missing `.value` then makes the loop
            // think the field is already empty.
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
                if displayed.isEmpty { break }
                // Exit only if the value isn't *shrinking*. Comparing whole
                // strings would prematurely stop on attributed-string /
                // autocorrect compositions where the visible text changes
                // but length still drops between batches; comparing length
                // tolerates that as progress.
                if displayed.count >= lastLength {
                    try? focusElementForTyping(refreshed, settleTime: 0.2)
                    let settled = (try? resolveElement(params)) ?? refreshed
                    let settledText = settled.text ?? ""
                    finalLength = settledText.count
                    if settledText.isEmpty { break }
                    if settledText.count < lastLength {
                        lastLength = settledText.count
                        continue
                    }
                    stalled = true
                    break
                }
                lastLength = displayed.count
                // String.count counts grapheme clusters — matches keyboard
                // backspace granularity for ASCII and composed emoji.
                let count = min(displayed.count, perIterationCap)
                actionExecutor.typeTextWithoutFocus(String(repeating: "\u{8}", count: count))
                // EventSynthesizer returns when events are queued, not when
                // RN has committed the resulting text update. Without a short
                // settle, CI can read the pre-backspace snapshot and report a
                // false stall while the field is already clearing.
                Thread.sleep(forTimeInterval: 0.15)
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
            try? focusElementForTyping(element, settleTime: 0.1)
            return ["success": true]

        // ─── Interactive Mirror Live-Drag (buffered touch path) ───

        case "touchDown":
            let x = (params["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (params["y"] as? NSNumber)?.doubleValue ?? 0
            touchPathLock.lock()
            touchPath = [(CGPoint(x: x, y: y), 0.0)]
            touchPathLock.unlock()
            return ["success": true]

        case "touchMove":
            let x = (params["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (params["y"] as? NSNumber)?.doubleValue ?? 0
            let tMs = (params["t"] as? NSNumber)?.doubleValue ?? 0
            touchPathLock.lock()
            if !touchPath.isEmpty {
                touchPath.append((CGPoint(x: x, y: y), tMs / 1000.0))
            }
            touchPathLock.unlock()
            return ["success": true]

        case "touchUp":
            let x = (params["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (params["y"] as? NSNumber)?.doubleValue ?? 0
            let tMs = (params["t"] as? NSNumber)?.doubleValue ?? 0
            // Copy + clear the path under the lock, then synthesize OUTSIDE the
            // lock (event synthesis is slow and must not block other threads).
            touchPathLock.lock()
            var pathToReplay: [(CGPoint, TimeInterval)] = []
            if !touchPath.isEmpty {
                touchPath.append((CGPoint(x: x, y: y), tMs / 1000.0))
                pathToReplay = touchPath
                touchPath = []
            }
            touchPathLock.unlock()
            if !pathToReplay.isEmpty {
                _ = EventSynthesizer.swipePath(pathToReplay)
            }
            // Settle like the existing swipe path.
            Thread.sleep(forTimeInterval: 0.2)
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
            return ["success": true]

        case "touchCancel":
            touchPathLock.lock()
            touchPath = []
            touchPathLock.unlock()
            return ["success": true]

        // ─── Swipe / Scroll ───

        case "swipe":
            if let fromX = (params["fromX"] as? NSNumber)?.doubleValue,
               let fromY = (params["fromY"] as? NSNumber)?.doubleValue,
               let toX = (params["toX"] as? NSNumber)?.doubleValue,
               let toY = (params["toY"] as? NSNumber)?.doubleValue {
                try actionExecutor.drag(
                    from: CGPoint(x: CGFloat(fromX), y: CGFloat(fromY)),
                    to: CGPoint(x: CGFloat(toX), y: CGFloat(toY))
                )
                // Match the settle used by the direction-based swipe below.
                Thread.sleep(forTimeInterval: 0.2)
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
                return ["success": true]
            }
            let direction = params["direction"] as? String ?? "up"
            let speed = params["speed"] as? Int ?? 5000
            let distance = params["distance"] as? Double ?? 0.5
            if let elementId = params["elementId"] as? String {
                let xcElem = try getXCUIElement(elementId)
                try actionExecutor.swipe(xcElem, direction: direction, speed: speed, distance: distance)
            } else if let startElement = params["startElement"] as? [String: Any] {
                let startSel = SelectorParser.parse(startElement)
                let startEl = try waitEngine.waitForElement(
                    startSel,
                    timeoutMs: 10000,
                    elementFinder: elementFinder,
                    snapshotFinder: snapshotFinder
                )
                let xcElem = try getXCUIElement(startEl.elementId)
                try actionExecutor.swipe(xcElem, direction: direction, speed: speed, distance: distance)
            } else {
                // Sync screen size to avoid quiescence-triggering
                // app.windows.firstMatch.frame.size read inside swipeScreen().
                actionExecutor.cachedScreenSize = snapshotFinder.screenSize
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
                let containerEl = try waitEngine.waitForElement(
                    containerSel,
                    timeoutMs: 10000,
                    elementFinder: elementFinder,
                    snapshotFinder: snapshotFinder
                )
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
            let timeout = params["timeout"] as? Int64 ?? 10000
            // Each end may be a cached elementId (positional/filtered handle) or
            // a selector to resolve.
            let sourceEl = try resolveDragEnd(sourceParams, timeoutMs: timeout)
            let targetEl = try resolveDragEnd(targetParams, timeoutMs: timeout)
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
            snapshotFinder.recordFocusedTextInputHint(element)
            return ["success": true]

        case "blur":
            let element = try resolveElement(params)
            let xcElem = try getXCUIElement(element.elementId)
            // Sync screen size to avoid quiescence-triggering
            // app.windows.firstMatch.frame.size read inside blur().
            actionExecutor.cachedScreenSize = snapshotFinder.screenSize
            try actionExecutor.blur(xcElem)
            snapshotFinder.clearFocusedTextInputHint()
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

        case "captureTraceState":
            var result: [String: Any] = ["success": true]
            let wantScreenshot = params["screenshot"] as? Bool ?? false
            let wantHierarchy = params["hierarchy"] as? Bool ?? false
            let hasSelector = SelectorParser.hasSelector(params)

            // Take one shared snapshot for hierarchy + element lookup.
            var snapshot: XCUIElementSnapshot?
            var snapshotError: Error?
            if wantHierarchy || hasSelector {
                do {
                    snapshot = try snapshotFinder.takeSnapshot()
                } catch {
                    snapshotError = error
                }
            }

            if hasSelector, let error = snapshotError, snapshot == nil {
                throw error
            }

            if wantScreenshot {
                let screenshot = XCUIScreen.main.screenshot()
                let pngData = screenshot.pngRepresentation
                result["screenshotData"] = pngData.base64EncodedString()
            }
            if wantHierarchy {
                if let snapshot = snapshot {
                    result["hierarchyXml"] = hierarchyDumper.dump(from: snapshot)
                } else if snapshotError != nil {
                    result["hierarchyXml"] = hierarchyDumper.dumpFallback()
                } else {
                    result["hierarchyXml"] = hierarchyDumper.dump()
                }
            }
            if hasSelector {
                let selector = SelectorParser.parse(params)
                if let snapshot = snapshot,
                   let element = try? snapshotFinder.findElement(selector, fromSnapshot: snapshot) {
                    result["elementFound"] = true
                    result["element"] = element.toDict()
                } else {
                    result["elementFound"] = false
                }
            }
            return result

        // ─── Wait ───

        case "waitForIdle":
            let timeout = params["timeout"] as? Int64 ?? 5000
            waitEngine.waitForIdle(timeoutMs: timeout)
            return ["success": true]

        case "waitForElement":
            let selector = SelectorParser.parse(params)
            let timeout = params["timeout"] as? Int64 ?? 10000
            let element = try waitEngine.waitForElement(
                selector,
                timeoutMs: timeout,
                elementFinder: elementFinder,
                snapshotFinder: snapshotFinder
            )
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
            Thread.sleep(forTimeInterval: 0.5)
            // Dismiss "Save Password?" dialog from iOS Passwords framework.
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
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
            let bundleId = ProcessInfo.processInfo.environment["TAPSMITH_TARGET_BUNDLE_ID"] ?? ""
            return ["package": bundleId]

        case "openDeepLink":
            let urlString = params["url"] as? String ?? ""
            guard !urlString.isEmpty, let url = URL(string: urlString) else {
                throw AgentError.actionFailed("openDeepLink: missing or invalid URL")
            }
            let bundleId = targetBundleId(fallback: params)
            // Physical devices have no host-side `simctl openurl`, so the agent
            // delivers the URL itself. On simulators the daemon already ran it;
            // this command only accepts any remaining prompt and rebinds once
            // the target app is foreground.
            let deliverInProcess = params["deliverInProcess"] as? Bool ?? true
            let targetApp = XCUIApplication(bundleIdentifier: bundleId)
            _ = safeAppState(targetApp)
            QuiescenceDisabler.disable(for: targetApp)

            if deliverInProcess {
                guard #available(iOS 16.4, *) else {
                    throw AgentError.actionFailed(
                        "openDeepLink requires iOS 16.4 or newer on physical devices"
                    )
                }
                _ = ObjCExceptionCatcher.catchException {
                    targetApp.activate()
                    Thread.sleep(forTimeInterval: 0.15)
                    targetApp.open(url)
                }
            }

            if waitForDeepLinkDestination(targetApp, timeout: 10.0) {
                _ = rebindApp(bundleId: bundleId)
                return ["success": true]
            }
            throw AgentError.actionFailed(
                "openDeepLink: app did not reach foreground after opening \(urlString)"
            )

        case "acceptOpenInAppDialog":
            let timeoutMs = params["timeout"] as? Int64 ?? 1000
            let dismissed = acceptOpenInAppDialogIfPresent(
                timeout: TimeInterval(timeoutMs) / 1000.0
            )
            return ["success": true, "dismissed": dismissed]

        case "dismissSystemDialogs":
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            for label in ["Open", "Allow", "OK", "Not Now", "Allow While Using App"] {
                let btn = springboard.buttons[label]
                if btn.waitForExistence(timeout: 0.3) {
                    btn.tap()
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
            return ["success": true]

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
            // outside of Tapsmith's control is a valid platform state.
            XCUIDevice.shared.orientation = target
            Thread.sleep(forTimeInterval: 0.4)
            if XCUIDevice.shared.orientation != target {
                XCUIDevice.shared.orientation = target
                Thread.sleep(forTimeInterval: 0.4)
            }
            snapshotFinder.invalidateScreenSize()
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
                snapshotFinder.clearFocusedTextInputHint()
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
            snapshotFinder.clearFocusedTextInputHint()
            return ["success": true]

        // ─── Color Scheme ───

        case "setColorScheme":
            // Color scheme changes are typically handled by the daemon via xcrun simctl ui
            // The agent cannot directly change the system appearance
            let scheme = params["scheme"] as? String ?? "light"
            NSLog("[TapsmithCommand] setColorScheme '\(scheme)' — handled by daemon via simctl")
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
            NSLog("[TapsmithCommand] \(method) — handled by daemon via simctl")
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
