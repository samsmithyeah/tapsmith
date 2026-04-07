import XCTest
import Foundation

/// Fast element finder that uses XCUIElement.snapshot() to fetch the entire
/// accessibility tree in a single IPC call, then searches in memory.
///
/// This is the same approach Maestro uses. It avoids per-element XCUITest
/// queries which each take 2-3 seconds due to quiescence waiting and IPC.
///
/// The snapshot approach: one ~50ms IPC call → in-memory search → instant results.
class SnapshotElementFinder {
    private let app: XCUIApplication
    private var elementCache: [String: XCUIElement] = [:]
    /// Bounds from snapshot — used for coordinate-based actions (fast, no quiescence).
    private var boundsCache: [String: CGRect] = [:]
    private let lock = NSLock()

    /// Parsed snapshot node from the accessibility tree.
    struct AXNode {
        let elementType: UInt
        let label: String
        let identifier: String
        let value: String
        let placeholderValue: String
        let isEnabled: Bool
        let frame: CGRect
        let children: [AXNode]

        /// The original XCUIElement for actions (tap, type, etc.)
        /// Only populated for matches, not the entire tree.
        weak var element: XCUIElement?
    }

    init(app: XCUIApplication) {
        self.app = app
    }

    // MARK: - Snapshot-based finding

    /// Find a single element matching the selector using snapshot.
    func findElement(_ selector: ElementSelector, parentId: String? = nil) throws -> ElementInfo {
        let elements = try findElements(selector, parentId: parentId)
        guard let first = elements.first else {
            throw AgentError.elementNotFound("No element found matching: \(describeSelector(selector))")
        }
        return first
    }

    /// Find all elements matching the selector using snapshot.
    func findElements(_ selector: ElementSelector, parentId: String? = nil) throws -> [ElementInfo] {
        // Take a snapshot of the entire accessibility tree in one IPC call.
        // With _XCTSetApplicationStateTimeout(0), the first snapshot may return
        // an empty tree before the accessibility connection is established.
        // Retry with short delays to let the tree populate.
        let resolvedDict: [XCUIElement.AttributeName: Any]
        var lastError: Error?
        var snapshot: XCUIElementSnapshot?
        for _ in 0..<5 {
            do {
                let s = try app.snapshot()
                if !s.dictionaryRepresentation.isEmpty {
                    snapshot = s
                    break
                }
            } catch {
                lastError = error
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        guard let resolvedSnapshot = snapshot else {
            let msg = lastError.map { "Snapshot failed after retries: \($0)" }
                ?? "Snapshot returned empty tree after retries"
            NSLog("[PilotSnapshot] \(msg)")
            throw AgentError.elementNotFound(msg)
        }
        resolvedDict = resolvedSnapshot.dictionaryRepresentation

        // Convert to string-keyed dict for easier processing
        let snapshotDict = convertKeys(resolvedDict)

        // Flatten and search
        var matches: [([String: Any], CGRect)] = []
        findMatches(in: snapshotDict, selector: selector, results: &matches)

        // Check once if keyboard is visible (for focus detection).
        // Keyboard = elementType 56 (XCUIElement.ElementType.keyboard).
        let keyboardVisibleInSnapshot = hasKeyboardInTree(snapshotDict)

        let screenSize = self.screenSize

        return matches.map { (nodeDict, frame) in
            let bounds = ElementBounds(
                left: Int(frame.origin.x),
                top: Int(frame.origin.y),
                right: Int(frame.origin.x + frame.width),
                bottom: Int(frame.origin.y + frame.height)
            )

            let elementId = UUID().uuidString
            let label = nodeDict["label"] as? String ?? ""
            let title = nodeDict["title"] as? String ?? ""
            let identifier = nodeDict["identifier"] as? String ?? ""
            let elTypeRaw = nodeDict["elementType"] as? UInt ?? 0
            let elType = XCUIElement.ElementType(rawValue: elTypeRaw) ?? .other
            let className = RoleMapping.typeName(for: elType)
            let role = RoleMapping.resolveRole(for: elType)
            let isEnabled = nodeDict["enabled"] as? Bool ?? true
            let value = nodeDict["value"] as? String
            let isSelected = nodeDict["selected"] as? Bool ?? false
            let isChecked = checkedState(
                for: elType,
                value: value,
                label: label,
                selected: isSelected
            )
            let snapshotFocused = (nodeDict["hasFocus"] as? Bool)
                ?? (nodeDict["hasKeyboardFocus"] as? Bool)

            // Cache the snapshot bounds for fast coordinate-based actions.
            lock.lock()
            boundsCache[elementId] = frame
            lock.unlock()

            // Lazily build an XCUIElement query for actions that need it (typeText, etc.).
            // This is deferred — the query object is created but not evaluated until
            // a property (like .isHittable) is accessed.
            cacheQueryElement(elementId: elementId, selector: selector)
            // The snapshot's hasFocus is unreliable on Xcode 26 — it reports false
            // even when the element is the first responder with keyboard showing.
            // For text fields, detect focus by checking if a keyboard is visible
            // in the same snapshot. This avoids live XCUIElement property access
            // which triggers quiescence waits on Xcode 26.
            let resolvedFocus: Bool
            if snapshotFocused == true {
                resolvedFocus = true
            } else if isTextFieldType(elType) {
                resolvedFocus = keyboardVisibleInSnapshot
            } else {
                resolvedFocus = false
            }

            // For text fields, prefer the "value" property (typed text) over "label"
            // (accessibility label). React Native TextInput has label="Email" and
            // value="test@example.com" — we want the value for toHaveText assertions.
            let placeholderValue = nodeDict["placeholderValue"] as? String
            let displayText: String?
            if let value = value, !value.isEmpty {
                displayText = value
            } else if !title.isEmpty {
                displayText = title
            } else if !label.isEmpty {
                displayText = label
            } else {
                displayText = nil
            }

            let viewportRatio = computeViewportRatio(bounds, screenSize: screenSize)

            return ElementInfo(
                elementId: elementId,
                className: className,
                text: displayText,
                contentDescription: label.isEmpty ? (title.isEmpty ? nil : title) : label,
                resourceId: identifier.isEmpty ? nil : identifier,
                hint: nil,
                bounds: bounds,
                isEnabled: isEnabled,
                isChecked: isChecked,
                isFocused: resolvedFocus,
                isClickable: frame.width > 0 && frame.height > 0,
                isFocusable: true,
                isScrollable: elType == .scrollView || elType == .table || elType == .collectionView,
                isVisible: viewportRatio > 0,
                isSelected: isSelected,
                childCount: (nodeDict["children"] as? [[String: Any]])?.count ?? 0,
                role: role,
                viewportRatio: viewportRatio
            )
        }
    }

    /// Clear all caches (call after app relaunch).
    func clearCaches() {
        lock.lock()
        elementCache.removeAll()
        boundsCache.removeAll()
        lock.unlock()
    }

    /// Get a cached XCUIElement by its stable ID (for actions like tap).
    func getElement(_ elementId: String) throws -> XCUIElement {
        lock.lock()
        let cached = elementCache[elementId]
        lock.unlock()

        if let elem = cached {
            return elem
        }
        throw AgentError.elementNotFound("Element '\(elementId)' not found. It may have gone stale.")
    }

    /// Get cached snapshot bounds for an element (for coordinate-based actions).
    func getBounds(_ elementId: String) -> CGRect? {
        lock.lock()
        let bounds = boundsCache[elementId]
        lock.unlock()
        return bounds
    }

    /// Get the ElementInfo for a cached element.
    func getElementInfo(_ elementId: String) throws -> ElementInfo {
        let elem = try getElement(elementId)
        return toElementInfo(elem, elementId: elementId)
    }

    /// Cache an XCUIElement and return its ElementInfo.
    func cacheElement(_ element: XCUIElement) -> ElementInfo {
        let elementId = UUID().uuidString
        lock.lock()
        elementCache[elementId] = element
        lock.unlock()
        return toElementInfo(element, elementId: elementId)
    }

    // MARK: - Concatenated label matching

    /// Check if two strings match when trailing punctuation is ignored.
    /// iOS's accessibilityLabel often strips trailing punctuation from display text
    /// (e.g., "Forgot password?" → "Forgot password"). This matcher catches those cases.
    private func matchesIgnoringTrailingPunctuation(_ a: String, _ b: String) -> Bool {
        guard !a.isEmpty && !b.isEmpty else { return false }
        let punct = CharacterSet.punctuationCharacters.union(.symbols)
        let trimA = a.unicodeScalars.reversed().drop(while: { punct.contains($0) })
        let trimB = b.unicodeScalars.reversed().drop(while: { punct.contains($0) })
        return String(String.UnicodeScalarView(trimA.reversed())) == String(String.UnicodeScalarView(trimB.reversed()))
    }

    /// Check if `childText` appears as a child's text within an iOS auto-concatenated label.
    ///
    /// iOS joins child text with ", " to form the parent's label. For example:
    ///   children ["Login Form", "Text inputs, buttons"] → "Login Form, Text inputs, buttons"
    ///
    /// We check if the label starts with `childText + ", "` (first child),
    /// ends with `", " + childText` (last child), or equals it (only child).
    /// This avoids false positives from arbitrary substring matching.
    private func containsChildText(_ label: String, childText: String) -> Bool {
        if label == childText { return true }
        if label.hasPrefix(childText + ", ") { return true }
        if label.hasSuffix(", " + childText) { return true }
        if label.contains(", " + childText + ", ") { return true }
        return false
    }

    /// Check if a keyboard is present in the snapshot tree.
    private func hasKeyboardInTree(_ node: [String: Any]) -> Bool {
        let elTypeRaw = parseUInt(node["elementType"]) ?? 0
        if elTypeRaw == XCUIElement.ElementType.keyboard.rawValue { return true }
        guard let children = node["children"] as? [[String: Any]] else { return false }
        for child in children {
            if hasKeyboardInTree(child) { return true }
        }
        return false
    }

    /// Check if an element type is a text input that can receive keyboard focus.
    private func isTextFieldType(_ elType: XCUIElement.ElementType) -> Bool {
        elType == .textField || elType == .secureTextField
            || elType == .textView || elType == .searchField
    }

    // MARK: - Key conversion

    /// Convert XCUIElement.AttributeName-keyed dicts to String-keyed dicts recursively.
    private func convertKeys(_ raw: [XCUIElement.AttributeName: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, value) in raw {
            if let children = value as? [[XCUIElement.AttributeName: Any]] {
                result[key.rawValue] = children.map { convertKeys($0) }
            } else if let child = value as? [XCUIElement.AttributeName: Any] {
                result[key.rawValue] = convertKeys(child)
            } else {
                result[key.rawValue] = value
            }
        }
        return result
    }

    // MARK: - Snapshot parsing and matching

    private func findMatches(
        in nodeDict: [String: Any],
        selector: ElementSelector,
        results: inout [([String: Any], CGRect)]
    ) {
        // Check this node
        if matchesSelector(nodeDict, selector: selector) {
            let frame = parseFrame(nodeDict)
            results.append((nodeDict, frame))
        }

        // Recurse into children
        guard let children = nodeDict["children"] as? [[String: Any]] else { return }
        for child in children {
            findMatches(in: child, selector: selector, results: &results)
        }
    }

    private func matchesSelector(_ node: [String: Any], selector: ElementSelector) -> Bool {
        let label = node["label"] as? String ?? ""
        let title = node["title"] as? String ?? ""
        let identifier = node["identifier"] as? String ?? ""
        let value = node["value"] as? String ?? ""
        let placeholderValue = node["placeholderValue"] as? String ?? ""
        let elTypeRaw = parseUInt(node["elementType"]) ?? 0
        let elType = XCUIElement.ElementType(rawValue: elTypeRaw) ?? .other
        let isEnabled = node["enabled"] as? Bool ?? true
        let isSelected = node["selected"] as? Bool ?? false

        // Text selector — exact match, OR match within iOS's auto-concatenated
        // labels. iOS touchable components merge child text into a single label
        // joined by ", ". This lets `text("Login Form")` match when the full
        // label is "Login Form, Text inputs, buttons, focus/blur, keyboard",
        // and also lets `text("Text inputs, buttons, focus/blur, keyboard")`
        // match the second child's text.
        //
        // Also handles iOS stripping trailing punctuation from accessibilityLabel:
        // React Native `accessibilityLabel="Forgot password"` + child Text
        // "Forgot password?" → iOS label is "Forgot password" but test expects
        // "Forgot password?". We match if one is a prefix of the other and
        // the difference is only punctuation.
        if let text = selector.text {
            let exactMatch = label == text || title == text || value == text
            let containsAsChild = !exactMatch
                && (containsChildText(label, childText: text) || containsChildText(title, childText: text))
            let punctuationMatch = !exactMatch && !containsAsChild
                && matchesIgnoringTrailingPunctuation(label, text)
            if !exactMatch && !containsAsChild && !punctuationMatch { return false }
        }

        // TextContains selector
        if let textContains = selector.textContains {
            if !label.contains(textContains) && !title.contains(textContains) && !value.contains(textContains) {
                return false
            }
        }

        // ContentDesc selector (maps to label on iOS)
        if let contentDesc = selector.contentDesc {
            let exactMatch = label == contentDesc || title == contentDesc
            let containsAsChild = !exactMatch
                && (containsChildText(label, childText: contentDesc)
                    || containsChildText(title, childText: contentDesc))
            if !exactMatch && !containsAsChild { return false }
        }

        // TestId selector (maps to identifier on iOS)
        if let testId = selector.testId {
            if identifier != testId { return false }
        }

        // ResourceId / id selector
        if let id = selector.id {
            if identifier != id { return false }
        }

        // Hint selector
        if let hint = selector.hint {
            if placeholderValue != hint { return false }
        }

        // Role selector — match by element type OR accessibility traits.
        // React Native's Pressable/TouchableOpacity with accessibilityRole="button"
        // sets the UIAccessibilityTraitButton trait but the element type stays .other.
        // We need to check both to match cross-platform role() selectors.
        if let role = selector.role {
            let types = (try? RoleMapping.elementTypes(for: role)) ?? []
            let traits = parseUInt64(node["traits"]) ?? 0

            let typeMatch = types.contains(elType)
            let traitMatch = !typeMatch && RoleMapping.matchesTrait(role: role, traits: traits)

            if !typeMatch && !traitMatch { return false }

            // Filter by name if provided
            if let name = selector.name {
                let exactMatch = label == name || title == name
                let containsAsChild = !exactMatch
                    && (containsChildText(label, childText: name) || containsChildText(title, childText: name))
                if !exactMatch && !containsAsChild { return false }
            }
        }

        // ClassName selector
        if let className = selector.className {
            let typeName = RoleMapping.typeName(for: elType)
            if typeName != className { return false }
        }

        // Enabled filter
        if let wantEnabled = selector.enabled {
            if isEnabled != wantEnabled { return false }
        }

        if let wantChecked = selector.checked {
            let isChecked = checkedState(
                for: elType,
                value: value,
                label: label,
                selected: isSelected
            )
            if isChecked != wantChecked { return false }
        }

        // Focus filter
        if let wantFocused = selector.focused {
            let isFocused = (node["hasFocus"] as? Bool)
                ?? (node["hasKeyboardFocus"] as? Bool)
                ?? false
            if isFocused != wantFocused { return false }
        }

        // Must have at least one positive match criterion
        let hasAnySelector = selector.text != nil || selector.textContains != nil
            || selector.contentDesc != nil || selector.testId != nil
            || selector.id != nil || selector.hint != nil
            || selector.role != nil || selector.className != nil
        if !hasAnySelector { return false }

        return true
    }

    private func parseFrame(_ node: [String: Any]) -> CGRect {
        // The snapshot dictionary stores frame as a sub-dictionary
        if let frameDict = node["frame"] as? [String: Any] {
            let x = (frameDict["X"] as? Double) ?? (frameDict["x"] as? Double) ?? 0
            let y = (frameDict["Y"] as? Double) ?? (frameDict["y"] as? Double) ?? 0
            let w = (frameDict["Width"] as? Double) ?? (frameDict["width"] as? Double) ?? 0
            let h = (frameDict["Height"] as? Double) ?? (frameDict["height"] as? Double) ?? 0
            return CGRect(x: x, y: y, width: w, height: h)
        }
        return .zero
    }

    private func parseUInt(_ raw: Any?) -> UInt? {
        guard let raw else { return nil }
        switch raw {
        case let value as UInt:
            return value
        case let value as UInt64:
            return UInt(value)
        case let value as Int:
            return value >= 0 ? UInt(value) : nil
        case let value as NSNumber:
            return UInt(value.uint64Value)
        case let value as String:
            return UInt(value)
        default:
            return nil
        }
    }

    private func parseUInt64(_ raw: Any?) -> UInt64? {
        guard let raw else { return nil }
        switch raw {
        case let value as UInt64:
            return value
        case let value as UInt:
            return UInt64(value)
        case let value as Int:
            return value >= 0 ? UInt64(value) : nil
        case let value as NSNumber:
            return value.uint64Value
        case let value as String:
            return UInt64(value)
        default:
            return nil
        }
    }

    private func parseNode(_ dict: [String: Any]) -> AXNode {
        let children = (dict["children"] as? [[String: Any]] ?? []).map { parseNode($0) }
        return AXNode(
            elementType: parseUInt(dict["elementType"]) ?? 0,
            label: (dict["label"] as? String) ?? (dict["title"] as? String ?? ""),
            identifier: dict["identifier"] as? String ?? "",
            value: (dict["value"] as? String) ?? "",
            placeholderValue: dict["placeholderValue"] as? String ?? "",
            isEnabled: dict["enabled"] as? Bool ?? true,
            frame: parseFrame(dict),
            children: children
        )
    }

    // MARK: - XCUIElement caching for actions

    /// Lazily cache an XCUIElement for the given selector so it can be used for actions.
    private func cacheQueryElement(elementId: String, selector: ElementSelector) {
        // Build a query that matches this element
        let element: XCUIElement?

        if let text = selector.text {
            // Use a predicate that handles iOS's auto-concatenated labels.
            // A Pressable with children ["Login Form", "description"] gets
            // label "Login Form, description" — so exact match alone fails.
            element = app.descendants(matching: .any)
                .matching(concatenatedLabelPredicate(text))
                .firstMatch
        } else if let contentDesc = selector.contentDesc {
            element = app.descendants(matching: .any)
                .matching(concatenatedLabelPredicate(contentDesc))
                .firstMatch
        } else if let testId = selector.testId {
            element = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == %@", testId))
                .firstMatch
        } else if let id = selector.id {
            element = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier == %@", id))
                .firstMatch
        } else if let role = selector.role, let name = selector.name {
            // Role + name: e.g. role("button", "Sign in")
            // Match by accessible name across all descendants. React Native
            // buttons often surface as XCUIElementTypeOther with traits, so a
            // type-constrained query can miss the element we just found in the snapshot.
            element = app.descendants(matching: .any)
                .matching(concatenatedLabelPredicate(name))
                .firstMatch
        } else if let role = selector.role {
            // Role-only: match the first element of this type
            if let types = try? RoleMapping.elementTypes(for: role), let firstType = types.first {
                element = app.descendants(matching: firstType).firstMatch
            } else {
                element = nil
            }
        } else {
            element = nil
        }

        if let element = element {
            lock.lock()
            elementCache[elementId] = element
            lock.unlock()
        }
    }

    /// Build an NSPredicate that matches a label value accounting for iOS's
    /// auto-concatenated accessibility labels (child texts joined by ", ").
    private func concatenatedLabelPredicate(_ value: String) -> NSPredicate {
        NSCompoundPredicate(orPredicateWithSubpredicates: [
            NSPredicate(format: "label == %@", value),
            NSPredicate(format: "label BEGINSWITH %@", value + ", "),
            NSPredicate(format: "label ENDSWITH %@", ", " + value),
            NSPredicate(format: "label CONTAINS %@", ", " + value + ", "),
        ])
    }

    // MARK: - Helpers

    lazy var screenSize: CGSize = {
        // Get actual screen size from the app's main window frame.
        // On iOS the main window is always full-screen.
        let frame = app.windows.firstMatch.frame
        if frame.width > 0 && frame.height > 0 {
            return frame.size
        }
        // Fallback for pre-launch state
        return CGSize(width: 393, height: 852)
    }()

    private func computeViewportRatio(_ bounds: ElementBounds, screenSize: CGSize) -> Float {
        let screenRect = CGRect(x: 0, y: 0, width: screenSize.width, height: screenSize.height)
        let elemRect = CGRect(
            x: CGFloat(bounds.left), y: CGFloat(bounds.top),
            width: CGFloat(bounds.width), height: CGFloat(bounds.height)
        )
        let area = elemRect.width * elemRect.height
        guard area > 0 else { return 0 }
        let intersection = screenRect.intersection(elemRect)
        guard !intersection.isNull else { return 0 }
        return Float(min(max(intersection.width * intersection.height / area, 0), 1))
    }

    private func toElementInfo(_ element: XCUIElement, elementId: String) -> ElementInfo {
        let frame = element.frame
        let elType = element.elementType
        let label = element.label
        let identifier = element.identifier

        let bounds = ElementBounds(
            left: Int(frame.origin.x), top: Int(frame.origin.y),
            right: Int(frame.origin.x + frame.size.width),
            bottom: Int(frame.origin.y + frame.size.height)
        )
        let className = RoleMapping.typeName(for: elType)
        let role = RoleMapping.resolveRole(for: elType)
        let isSelected = element.isSelected
        let isChecked = checkedState(
            for: elType,
            value: element.value as? String,
            label: label,
            selected: isSelected
        )

        let viewportRatio = computeViewportRatio(bounds, screenSize: screenSize)

        return ElementInfo(
            elementId: elementId, className: className,
            text: label.isEmpty ? nil : label,
            contentDescription: label.isEmpty ? nil : label,
            resourceId: identifier.isEmpty ? nil : identifier,
            hint: nil, bounds: bounds,
            isEnabled: element.isEnabled, isChecked: isChecked, isFocused: element.hasFocus,
            isClickable: frame.width > 0 && frame.height > 0,
            isFocusable: true,
            isScrollable: elType == .scrollView || elType == .table || elType == .collectionView,
            isVisible: viewportRatio > 0,
            isSelected: isSelected, childCount: 0,
            role: role, viewportRatio: viewportRatio
        )
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
        return parts.joined(separator: ", ")
    }

    private func checkedState(
        for elementType: XCUIElement.ElementType,
        value: String?,
        label: String? = nil,
        selected: Bool
    ) -> Bool {
        let normalized = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""

        switch normalized {
        case "1", "true", "on", "yes", "selected", "checked":
            return true
        case "0", "false", "off", "no", "not selected", "unchecked":
            return false
        default:
            // React Native checkbox/radio on iOS produces compound values like
            // "checkbox, checked", "checkbox, unchecked", "radio button, checked".
            // Parse the state from the trailing component after the last comma.
            if normalized.hasSuffix(", checked") || normalized.hasSuffix(", selected") {
                return true
            }
            if normalized.hasSuffix(", unchecked") || normalized.hasSuffix(", not selected") {
                return false
            }
            switch elementType {
            case .switch, .toggle, .checkBox, .radioButton:
                return selected
            default:
                return false
            }
        }
    }
}
