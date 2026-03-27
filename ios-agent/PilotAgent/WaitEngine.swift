import XCTest
import Foundation

/// Event-driven waiting engine using XCUITest's built-in wait mechanisms.
///
/// Mirrors the Android agent's WaitEngine.kt with a 3-phase wait pattern:
/// 1. Wait for element existence (XCUIElement.waitForExistence)
/// 2. Wait for element to become enabled
/// 3. Wait for positional stability (bounds not changing)
class WaitEngine {
    private let app: XCUIApplication

    private static let stabilityWindowMs: UInt64 = 300
    private static let defaultIdleTimeout: TimeInterval = 5.0
    private static let defaultElementTimeout: TimeInterval = 10.0

    init(app: XCUIApplication) {
        self.app = app
    }

    /// Wait until the UI is idle.
    /// On iOS, there's no direct equivalent to Android's waitForIdle.
    /// We use a brief sleep to allow animations to settle. Keep this short
    /// since it blocks the single-threaded command handler.
    func waitForIdle(timeoutMs: Int64 = 5000) {
        let maxWait: TimeInterval = 0.5
        Thread.sleep(forTimeInterval: min(TimeInterval(timeoutMs) / 1000.0, maxWait))
    }

    /// Wait until an element matching the selector exists, is enabled, and positionally stable.
    ///
    /// - Parameters:
    ///   - selector: The element selector to wait for
    ///   - timeoutMs: Maximum time to wait in milliseconds
    ///   - elementFinder: The element finder for the final result
    /// - Returns: ElementInfo for the found element
    /// - Throws: AgentError.timeout if the element does not appear within timeout
    func waitForElement(
        _ selector: ElementSelector,
        timeoutMs: Int64 = 10000,
        elementFinder: ElementFinder
    ) throws -> ElementInfo {
        let timeout = TimeInterval(timeoutMs) / 1000.0
        let startTime = CFAbsoluteTimeGetCurrent()

        // Build a query for event-driven waiting
        let query = buildWaitQuery(selector)

        if let query = query {
            let element = query.firstMatch

            // Phase 1: Wait for the element to exist.
            // For short timeouts (e.g. assertion polling at 500ms), use
            // element.exists which is a fast snapshot check. For longer
            // timeouts, use waitForExistence which subscribes to
            // accessibility notifications for event-driven waiting.
            let exists: Bool
            if timeout < 1.0 {
                exists = element.exists
            } else {
                exists = element.waitForExistence(timeout: timeout)
            }
            if !exists {
                throw AgentError.timeout(
                    "Timed out after \(timeoutMs)ms waiting for element to exist. "
                    + "Selector: \(describeSelector(selector))"
                )
            }

            // Skip Phase 2 (enabled check) and Phase 3 (stability check)
            // for short timeouts — the assertion polling loop handles retries.
            if timeout >= 1.0 {
                // Phase 2: Wait for the element to become enabled
                if !element.isEnabled {
                    let enabledDeadline = startTime + timeout
                    while CFAbsoluteTimeGetCurrent() < enabledDeadline {
                        if element.isEnabled { break }
                        Thread.sleep(forTimeInterval: 0.1)
                    }
                    if !element.isEnabled {
                        throw AgentError.timeout(
                            "Timed out after \(timeoutMs)ms: element exists but is not enabled. "
                            + "Selector: \(describeSelector(selector))"
                        )
                    }
                }

                // Phase 3: Verify positional stability
                let stabilityMs = Self.stabilityWindowMs
                let stabilityDeadline = CFAbsoluteTimeGetCurrent() + Double(stabilityMs) / 1000.0
                var lastFrame = element.frame
                while CFAbsoluteTimeGetCurrent() < stabilityDeadline {
                    Thread.sleep(forTimeInterval: Double(stabilityMs) / 1000.0)
                    let currentFrame = element.frame
                    if lastFrame == currentFrame {
                        break
                    }
                    lastFrame = currentFrame
                }
            }

            // Cache and return the element we already found — avoid a redundant
            // full tree traversal which can take 10+ seconds on React Native.
            return elementFinder.cacheElement(element)
        } else {
            // For selectors we can't express as a query (e.g., xpath, role),
            // use a brief idle wait then check
            waitForIdle(timeoutMs: min(timeoutMs, 2000))
        }

        // Fallback: full lookup for selectors that don't have efficient queries
        do {
            return try elementFinder.findElement(selector)
        } catch {
            throw AgentError.timeout(
                "Timed out after \(timeoutMs)ms: element not found after waiting. "
                + "Selector: \(describeSelector(selector))"
            )
        }
    }

    /// Build an XCUIElementQuery from a selector for use with waitForExistence.
    /// Returns nil if the selector type cannot be expressed as a direct query.
    private func buildWaitQuery(_ selector: ElementSelector) -> XCUIElementQuery? {
        if let text = selector.text {
            return app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", text))
        }
        if let textContains = selector.textContains {
            return app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", textContains))
        }
        if let contentDesc = selector.contentDesc {
            return app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", contentDesc))
        }
        if let id = selector.id {
            return app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", id))
        }
        if let testId = selector.testId {
            return app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", testId))
        }
        if let className = selector.className {
            return app.descendants(matching: .any).matching(
                NSPredicate(format: "elementType == %d", elementTypeRawValue(className))
            )
        }
        // Role, xpath, hint cannot be expressed as simple queries
        return nil
    }

    /// Get the raw value for an element type name.
    private func elementTypeRawValue(_ className: String) -> UInt {
        // This is a simplified mapping — in practice, we'd use the same map as RoleMapping
        return 0
    }

    private func describeSelector(_ selector: ElementSelector) -> String {
        var parts: [String] = []
        if let v = selector.role { parts.append("role=\(v)") }
        if let v = selector.name { parts.append("name=\(v)") }
        if let v = selector.text { parts.append("text=\(v)") }
        if let v = selector.textContains { parts.append("textContains=\(v)") }
        if let v = selector.contentDesc { parts.append("contentDesc=\(v)") }
        if let v = selector.hint { parts.append("hint=\(v)") }
        if let v = selector.className { parts.append("className=\(v)") }
        if let v = selector.testId { parts.append("testId=\(v)") }
        if let v = selector.id { parts.append("id=\(v)") }
        if let v = selector.xpath { parts.append("xpath=\(v)") }
        return parts.joined(separator: ", ")
    }
}
