import XCTest
import Foundation
import ObjectiveC

/// Disables XCUITest's quiescence waiting and provides direct event synthesis.
///
/// XCUITest normally blocks all actions (tap, type, swipe) until the app is
/// "quiescent" — no animations, no timers, no pending network requests.
/// React Native apps are NEVER quiescent because the JS bridge keeps timers
/// running. This causes every action to block for 30+ seconds.
///
/// Three strategies are used:
/// 1. Set quiescence timeout to 0 via _XCTSetApplicationStateTimeout (WDA approach).
/// 2. Runtime swizzle: Replace the quiescence check on XCUIApplicationProcess.
/// 3. Direct event synthesis: Bypass XCUIElement/XCUICoordinate entirely using
///    XCTest's private XCSynthesizedEventRecord + XCPointerEventPath APIs.
///    This is the same approach used by Maestro and Appium/WebDriverAgent.
enum QuiescenceDisabler {

    // MARK: - Quiescence Disable

    /// Disable quiescence using Objective-C runtime method swizzling.
    /// Call BEFORE app.activate() so it takes effect immediately.
    static func disableViaRuntime() {
        guard let processClass = NSClassFromString("XCUIApplicationProcess") else {
            NSLog("[Quiescence] XCUIApplicationProcess class not found")
            return
        }

        dumpQuiescenceMethods(processClass)

        // Swizzle ALL quiescence wait variants — Xcode 26 has multiple variants
        // and different code paths (e.g., XCUICoordinate.tap() vs app.activate())
        // may call different ones. We must swizzle ALL of them.
        let candidates: [(String, Any)] = [
            // Xcode 26: 2 Bool params (animationsIdle + isPreEvent)
            ("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", {
                let block: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
                return block as Any
            }()),
            // Xcode 26: 3 params variant (used by XCUICoordinate.tap())
            ("waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:", {
                let block: @convention(block) (AnyObject, Bool, AnyObject?, Bool) -> Void = { _, _, _, _ in }
                return block as Any
            }()),
            // Xcode 15-25: 1 Bool param
            ("waitForQuiescenceIncludingAnimationsIdle:", {
                let block: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
                return block as Any
            }()),
        ]

        var swizzledAny = false
        for (selName, block) in candidates {
            let sel = NSSelectorFromString(selName)
            if let method = class_getInstanceMethod(processClass, sel) {
                let imp = imp_implementationWithBlock(block)
                method_setImplementation(method, imp)
                NSLog("[Quiescence] Disabled via runtime swizzle of %@", selName)
                swizzledAny = true
            }
        }

        if !swizzledAny {
            NSLog("[Quiescence] WARNING: No direct quiescence wait method swizzled")
        }

        // Also swizzle the skip/query methods unconditionally
        let skipMethods: [(String, Any)] = [
            ("shouldSkipPreEventQuiescence", {
                let b: @convention(block) (AnyObject) -> Bool = { _ in true }
                return b as Any
            }()),
            ("shouldSkipPostEventQuiescence", {
                let b: @convention(block) (AnyObject) -> Bool = { _ in true }
                return b as Any
            }()),
            ("isQuiescent", {
                let b: @convention(block) (AnyObject) -> Bool = { _ in true }
                return b as Any
            }()),
            ("_initiateQuiescenceChecksIncludingAnimationsIdle:", {
                let b: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
                return b as Any
            }()),
        ]

        for (selName, block) in skipMethods {
            let sel = NSSelectorFromString(selName)
            if let method = class_getInstanceMethod(processClass, sel) {
                let imp = imp_implementationWithBlock(block)
                method_setImplementation(method, imp)
                NSLog("[Quiescence] Swizzled %@", selName)
            }
        }
    }

    /// Property-based disable on a specific app's process instance.
    static func disable(for app: XCUIApplication) {
        let processSelector = NSSelectorFromString("applicationProcess")
        let altProcessSelector = NSSelectorFromString("_applicationProcess")

        var process: NSObject?

        if app.responds(to: processSelector) {
            process = app.perform(processSelector)?.takeUnretainedValue() as? NSObject
        } else if app.responds(to: altProcessSelector) {
            process = app.perform(altProcessSelector)?.takeUnretainedValue() as? NSObject
        }

        guard let proc = process else {
            NSLog("[Quiescence] Could not access applicationProcess instance")
            return
        }

        let setSelector = NSSelectorFromString("setWaitForQuiescence:")
        if proc.responds(to: setSelector) {
            proc.perform(setSelector, with: false as AnyObject)
            NSLog("[Quiescence] Disabled on process via setWaitForQuiescence:")
        }
    }

    private static func dumpQuiescenceMethods(_ cls: AnyClass) {
        var methodCount: UInt32 = 0
        guard let methods = class_copyMethodList(cls, &methodCount) else { return }
        defer { free(methods) }

        for i in 0..<Int(methodCount) {
            let name = NSStringFromSelector(method_getName(methods[i]))
            if name.lowercased().contains("quiesc") ||
               (name.lowercased().contains("idle") && name.lowercased().contains("wait")) {
                NSLog("[Quiescence] Available method: %@", name)
            }
        }
    }

    /// Nuclear option: swizzle every method containing "quiescence" or "Quiescence"
    /// on the given class. This is aggressive but ensures all quiescence checks
    /// are bypassed on Xcode 26 where Apple added many new checkpoints.
    static func disableAllQuiescenceMethods(on cls: AnyClass) {
        var methodCount: UInt32 = 0
        guard let methods = class_copyMethodList(cls, &methodCount) else { return }
        defer { free(methods) }

        for i in 0..<Int(methodCount) {
            let sel = method_getName(methods[i])
            let name = NSStringFromSelector(sel)

            // Skip non-quiescence methods
            guard name.contains("uiescence") || name.contains("Quiescence") else { continue }
            // Skip getters (we want to swizzle behavior methods)
            guard !name.hasPrefix("set") else { continue }

            // Determine the return type to create the right block
            let typeEncoding = String(cString: method_getTypeEncoding(methods[i])!)
            let imp: IMP

            if typeEncoding.hasPrefix("B") || typeEncoding.hasPrefix("c") {
                // Returns BOOL — make it return YES/true
                let block: @convention(block) () -> Bool = { true }
                imp = imp_implementationWithBlock(block)
            } else if typeEncoding.hasPrefix("v") {
                // Returns void — make it a no-op
                let block: @convention(block) () -> Void = { }
                imp = imp_implementationWithBlock(block)
            } else {
                continue // Skip methods with other return types
            }

            method_setImplementation(methods[i], imp)
            NSLog("[Quiescence] Force-disabled: %@", name)
        }
    }
}

// MARK: - Direct Event Synthesis

/// Synthesizes touch events directly via XCTest's private APIs, bypassing
/// XCUIElement/XCUICoordinate (which wait for quiescence).
///
/// Uses the same approach as Maestro: `unsafeBitCast` + `method(for:)` to call
/// private XCPointerEventPath/XCSynthesizedEventRecord methods from Swift.
enum EventSynthesizer {

    /// Tap at a screen coordinate. Returns true if synthesis succeeded.
    static func tap(at point: CGPoint) -> Bool {
        return synthesizeTap(at: point, duration: 0.1)
    }

    /// Double-tap at a screen coordinate.
    static func doubleTap(at point: CGPoint) -> Bool {
        guard synthesizeTap(at: point, duration: 0.05) else { return false }
        Thread.sleep(forTimeInterval: 0.05)
        return synthesizeTap(at: point, duration: 0.05)
    }

    /// Swipe from one point to another. Used for keyboard dismissal and scrolling.
    static func swipe(from start: CGPoint, to end: CGPoint, duration: TimeInterval) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        // Create touch-down at start point
        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        guard pathObj.responds(to: initSel) else { return false }
        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel, start, 0.0)

        // Move to end point
        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        if path.responds(to: moveSel) {
            let moveImp = path.method(for: moveSel)
            typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
            unsafeBitCast(moveImp, to: MoveMethod.self)(path, moveSel, end, duration)
        }

        // Lift up
        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            unsafeBitCast(liftImp, to: LiftMethod.self)(path, liftSel, duration + 0.01)
        }

        // Create record and dispatch
        let recordObj = recordClass.alloc() as! NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record: NSObject
        if recordObj.responds(to: recordInitSel) {
            let imp = recordObj.method(for: recordInitSel)
            typealias RMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(imp, to: RMethod.self)(recordObj, recordInitSel, "pilot-swipe" as NSString, UIInterfaceOrientation.portrait.rawValue)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
    }

    /// Long-press at a screen coordinate.
    static func longPress(at point: CGPoint, duration: TimeInterval) -> Bool {
        return synthesizeTap(at: point, duration: duration)
    }

    /// Modifier flags for key press events.
    struct KeyModifiers: OptionSet {
        let rawValue: UInt64
        static let command = KeyModifiers(rawValue: 1 << 20) // UIKeyModifierCommand
        static let shift = KeyModifiers(rawValue: 1 << 17)   // UIKeyModifierShift
        static let option = KeyModifiers(rawValue: 1 << 19)  // UIKeyModifierAlternate
        static let control = KeyModifiers(rawValue: 1 << 18) // UIKeyModifierControl
    }

    /// Press a key with optional modifiers (e.g., Cmd+V for paste).
    static func keyPress(key: String, modifiers: KeyModifiers = []) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        // Create path for text input
        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTextInput")
        guard pathObj.responds(to: initSel) else { return false }

        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel)

        // typeKey:modifiers:atOffset:
        let keySel = NSSelectorFromString("typeKey:modifiers:atOffset:")
        if path.responds(to: keySel) {
            let keyImp = path.method(for: keySel)
            typealias KeyMethod = @convention(c) (NSObject, Selector, NSString, UInt64, TimeInterval) -> Void
            let keyFunc = unsafeBitCast(keyImp, to: KeyMethod.self)
            keyFunc(path, keySel, key as NSString, modifiers.rawValue, 0.0)
        } else {
            NSLog("[EventSynth] typeKey:modifiers:atOffset: not available")
            return false
        }

        // Create record and add path
        let recordObj = recordClass.alloc() as! NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record: NSObject
        if recordObj.responds(to: recordInitSel) {
            let rImp = recordObj.method(for: recordInitSel)
            typealias RMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(rImp, to: RMethod.self)(recordObj, recordInitSel, "pilot-key" as NSString, UIInterfaceOrientation.portrait.rawValue)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addSel) {
            record.perform(addSel, with: path)
        }

        return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
    }

    /// Type text using event synthesis (bypasses quiescence).
    ///
    /// Follows Maestro's exact approach:
    /// 1. Try _XCT_sendString (direct daemon text input API)
    /// 2. Fall back to XCPointerEventPath.typeText with slow first-char strategy
    ///    (type first char at speed 1, wait 500ms, type rest at speed 30)
    static func typeText(_ text: String) -> Bool {
        guard !text.isEmpty else { return true }

        // Approach 1: _XCT_sendString — direct text input via daemon proxy
        if sendStringViaDaemon(text) {
            return true
        }

        // Approach 2: XCPointerEventPath.typeText (Maestro-style slow typing)
        // Type first character slowly, wait, then type rest faster
        let firstChar = String(text.prefix(1))
        let rest = String(text.dropFirst())

        if !typeViaEventPath(firstChar, typingSpeed: 1) {
            return false
        }

        // Critical: 500ms delay after first character (Maestro's workaround
        // for iOS dropping characters / not triggering delegates)
        Thread.sleep(forTimeInterval: 0.5)

        if !rest.isEmpty {
            return typeViaEventPath(rest, typingSpeed: 30)
        }
        return true
    }

    /// Send text via _XCT_sendString:maximumFrequency:completion: on daemon proxy.
    /// This is a higher-level API that types through the keyboard system.
    private static func sendStringViaDaemon(_ text: String) -> Bool {
        guard let sessionClass = objc_lookUpClass("XCTRunnerDaemonSession") else { return false }

        let sharedSel = NSSelectorFromString("sharedSession")
        let sessionNSObj = sessionClass as AnyObject
        guard sessionNSObj.responds(to: sharedSel),
              let session = sessionNSObj.perform(sharedSel)?.takeUnretainedValue() as? NSObject
        else { return false }

        let proxySel = NSSelectorFromString("daemonProxy")
        guard session.responds(to: proxySel),
              let proxy = session.perform(proxySel)?.takeUnretainedValue() as? NSObject
        else { return false }

        let sendSel = NSSelectorFromString("_XCT_sendString:maximumFrequency:completion:")
        guard proxy.responds(to: sendSel) else {
            NSLog("[EventSynth] _XCT_sendString not available on daemon proxy")
            return false
        }

        let semaphore = DispatchSemaphore(value: 0)
        var success = false

        let imp = proxy.method(for: sendSel)
        typealias SendMethod = @convention(c) (NSObject, Selector, NSString, UInt64, @escaping @convention(block) (NSError?) -> Void) -> Void
        let sendFunc = unsafeBitCast(imp, to: SendMethod.self)
        sendFunc(proxy, sendSel, text as NSString, 30) { error in
            success = (error == nil)
            if let error = error {
                NSLog("[EventSynth] _XCT_sendString error: %@", error.localizedDescription)
            }
            semaphore.signal()
        }

        let result = semaphore.wait(timeout: .now() + .seconds(30))
        if result == .timedOut {
            NSLog("[EventSynth] _XCT_sendString timed out")
            return false
        }
        if success {
            NSLog("[EventSynth] Text sent via _XCT_sendString")
        }
        return success
    }

    /// Type text via XCPointerEventPath.typeText (lower-level API).
    private static func typeViaEventPath(_ text: String, typingSpeed: Int) -> Bool {
        guard let pathClass = objc_lookUpClass("XCPointerEventPath"),
              let recordClass = objc_lookUpClass("XCSynthesizedEventRecord")
        else { return false }

        // Create path for text input
        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTextInput")
        guard pathObj.responds(to: initSel) else { return false }

        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector) -> NSObject
        let path = unsafeBitCast(initImp, to: InitMethod.self)(pathObj, initSel)

        // Type the text
        let typeSel = NSSelectorFromString("typeText:atOffset:typingSpeed:shouldRedact:")
        guard path.responds(to: typeSel) else { return false }

        let typeImp = path.method(for: typeSel)
        typealias TypeMethod = @convention(c) (NSObject, Selector, NSString, TimeInterval, UInt64, Bool) -> Void
        unsafeBitCast(typeImp, to: TypeMethod.self)(path, typeSel, text as NSString, 0.0, UInt64(typingSpeed), false)

        // Create record
        let recordObj = recordClass.alloc() as! NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let record: NSObject
        if recordObj.responds(to: recordInitSel) {
            let rImp = recordObj.method(for: recordInitSel)
            typealias RMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            record = unsafeBitCast(rImp, to: RMethod.self)(recordObj, recordInitSel, "pilot-type" as NSString, UIInterfaceOrientation.portrait.rawValue)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        // Dispatch via daemon session (Maestro approach)
        return dispatchViaDaemonSession(record) || dispatchSync(record) || dispatchViaDevice(record)
    }

    // MARK: - Private

    private static func synthesizeTap(at point: CGPoint, duration: TimeInterval) -> Bool {
        // 1. Create XCPointerEventPath for touch
        guard let pathClass = objc_lookUpClass("XCPointerEventPath") else {
            NSLog("[EventSynth] XCPointerEventPath class not found")
            return false
        }

        let pathObj = pathClass.alloc() as! NSObject
        let initSel = NSSelectorFromString("initForTouchAtPoint:offset:")
        guard pathObj.responds(to: initSel) else {
            NSLog("[EventSynth] XCPointerEventPath initForTouchAtPoint:offset: not found")
            return false
        }

        // Call initForTouchAtPoint:offset: using unsafeBitCast (Maestro approach)
        let initImp = pathObj.method(for: initSel)
        typealias InitMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> NSObject
        let initFunc = unsafeBitCast(initImp, to: InitMethod.self)
        let path = initFunc(pathObj, initSel, point, 0.0)

        // Add a moveToPoint at the same location — this generates a touchesMoved
        // event which helps UIScrollView's gesture recognizer classify the gesture
        // as a stationary tap (not a scroll), allowing the event to pass through
        // to child responders like TouchableOpacity.
        let moveSel = NSSelectorFromString("moveToPoint:atOffset:")
        if path.responds(to: moveSel) {
            let moveImp = path.method(for: moveSel)
            typealias MoveMethod = @convention(c) (NSObject, Selector, CGPoint, TimeInterval) -> Void
            let moveFunc = unsafeBitCast(moveImp, to: MoveMethod.self)
            moveFunc(path, moveSel, point, duration * 0.5)
        }

        // Call liftUpAtOffset:
        let liftSel = NSSelectorFromString("liftUpAtOffset:")
        if path.responds(to: liftSel) {
            let liftImp = path.method(for: liftSel)
            typealias LiftMethod = @convention(c) (NSObject, Selector, TimeInterval) -> Void
            let liftFunc = unsafeBitCast(liftImp, to: LiftMethod.self)
            liftFunc(path, liftSel, duration)
        }

        // 2. Create XCSynthesizedEventRecord and add the path
        guard let recordClass = objc_lookUpClass("XCSynthesizedEventRecord") else {
            NSLog("[EventSynth] XCSynthesizedEventRecord class not found")
            return false
        }

        let record: NSObject
        let recordInitSel = NSSelectorFromString("initWithName:interfaceOrientation:")
        let recordObj = recordClass.alloc() as! NSObject
        if recordObj.responds(to: recordInitSel) {
            // Use unsafeBitCast to pass interfaceOrientation as Int (not NSNumber)
            let imp = recordObj.method(for: recordInitSel)
            typealias RecordInitMethod = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
            let initFunc = unsafeBitCast(imp, to: RecordInitMethod.self)
            record = initFunc(recordObj, recordInitSel, "pilot-tap" as NSString, UIInterfaceOrientation.portrait.rawValue)
        } else {
            record = (recordClass as! NSObject.Type).init()
        }

        let addPathSel = NSSelectorFromString("addPointerEventPath:")
        if record.responds(to: addPathSel) {
            record.perform(addPathSel, with: path)
        }

        // 3. Try daemon session first (proven to deliver events to the app),
        // then sync, then device synthesizer as fallbacks.
        if dispatchViaDaemonSession(record) {
            return true
        }
        if dispatchSync(record) {
            return true
        }
        if dispatchViaDevice(record) {
            return true
        }
        NSLog("[EventSynth] All dispatch methods failed")
        return false
    }

    /// Synchronous dispatch using XCSynthesizedEventRecord.synthesizeWithError:
    /// This avoids the semaphore deadlock that can occur with async dispatch.
    private static func dispatchSync(_ record: NSObject) -> Bool {
        let sel = NSSelectorFromString("synthesizeWithError:")
        guard record.responds(to: sel) else {
            return false
        }

        var error: NSError?
        let imp = record.method(for: sel)
        typealias SynthMethod = @convention(c) (NSObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
        let synthFunc = unsafeBitCast(imp, to: SynthMethod.self)
        let result = synthFunc(record, sel, &error)

        if let error = error {
            NSLog("[EventSynth] synthesizeWithError failed: %@", error.localizedDescription)
        }
        return result
    }

    /// Dispatch event via XCUIDevice.shared.eventSynthesizer (Appium/WDA approach)
    private static func dispatchViaDevice(_ record: NSObject) -> Bool {
        let device = XCUIDevice.shared as NSObject

        let synthSel = NSSelectorFromString("eventSynthesizer")
        guard device.responds(to: synthSel),
              let synthesizer = device.perform(synthSel)?.takeUnretainedValue() as? NSObject
        else {
            NSLog("[EventSynth] XCUIDevice.eventSynthesizer not available")
            return false
        }

        let dispatchSel = NSSelectorFromString("synthesizeEvent:completion:")
        guard synthesizer.responds(to: dispatchSel) else {
            NSLog("[EventSynth] eventSynthesizer.synthesizeEvent:completion: not available")
            return false
        }

        let semaphore = DispatchSemaphore(value: 0)
        var success = false

        // Call synthesizeEvent:completion: using unsafeBitCast
        let imp = synthesizer.method(for: dispatchSel)
        typealias SynthMethod = @convention(c) (NSObject, Selector, NSObject, @escaping @convention(block) (Bool, NSError?) -> Void) -> Void
        let synthFunc = unsafeBitCast(imp, to: SynthMethod.self)
        synthFunc(synthesizer, dispatchSel, record) { result, error in
            if let error = error {
                NSLog("[EventSynth] Synthesis error: %@", error.localizedDescription)
            }
            success = result
            semaphore.signal()
        }

        _ = semaphore.wait(timeout: .now() + .seconds(10))
        return success
    }

    /// Dispatch event via XCTRunnerDaemonSession (Maestro approach, fallback)
    private static func dispatchViaDaemonSession(_ record: NSObject) -> Bool {
        guard let sessionClass = objc_lookUpClass("XCTRunnerDaemonSession") else {
            NSLog("[EventSynth] XCTRunnerDaemonSession not available")
            return false
        }

        let sharedSel = NSSelectorFromString("sharedSession")
        let sessionNSObj = sessionClass as AnyObject
        guard sessionNSObj.responds(to: sharedSel),
              let session = sessionNSObj.perform(sharedSel)?.takeUnretainedValue() as? NSObject
        else {
            NSLog("[EventSynth] Could not get shared XCTRunnerDaemonSession")
            return false
        }

        let proxySel = NSSelectorFromString("daemonProxy")
        guard session.responds(to: proxySel),
              let proxy = session.perform(proxySel)?.takeUnretainedValue() as? NSObject
        else {
            NSLog("[EventSynth] Could not get daemonProxy")
            return false
        }

        let synthSel = NSSelectorFromString("_XCT_synthesizeEvent:completion:")
        guard proxy.responds(to: synthSel) else {
            NSLog("[EventSynth] _XCT_synthesizeEvent:completion: not available on proxy")
            return false
        }

        let semaphore = DispatchSemaphore(value: 0)
        var success = false

        let imp = proxy.method(for: synthSel)
        typealias SynthMethod = @convention(c) (NSObject, Selector, NSObject, @escaping @convention(block) (NSError?) -> Void) -> Void
        let synthFunc = unsafeBitCast(imp, to: SynthMethod.self)
        synthFunc(proxy, synthSel, record) { error in
            success = (error == nil)
            if let error = error {
                NSLog("[EventSynth] Daemon synthesis error: %@", error.localizedDescription)
            }
            semaphore.signal()
        }

        _ = semaphore.wait(timeout: .now() + .seconds(10))
        return success
    }
}
