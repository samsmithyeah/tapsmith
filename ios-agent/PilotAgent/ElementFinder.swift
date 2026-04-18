import XCTest
import Foundation

/// Finds UI elements using XCUITest queries.
///
/// Mirrors the Android agent's ElementFinder.kt. Supports selector strategies:
/// role, text, contentDesc, className, testId, resourceId (identifier), xpath.
/// Maintains a cache of found elements so they can be referenced by ID.
class ElementFinder {
    private let app: XCUIApplication
    private var elementCache: [String: XCUIElement] = [:]
    private let lock = NSLock()

    /// Clear all caches (call after app relaunch).
    func clearCaches() {
        lock.lock()
        elementCache.removeAll()
        lock.unlock()
    }

    /// Screen dimensions for viewport ratio calculation.
    private var screenSize: CGSize {
        return app.windows.firstMatch.frame.size
    }

    init(app: XCUIApplication) {
        self.app = app
    }

    // MARK: - Public API

    /// Find a single element matching the selector.
    /// - Throws: AgentError.elementNotFound if no element matches.
    func findElement(_ selector: ElementSelector, parentId: String? = nil) throws -> ElementInfo {
        let elements = try findElements(selector, parentId: parentId)
        guard let first = elements.first else {
            throw AgentError.elementNotFound("No element found matching: \(describeSelector(selector))")
        }
        return first
    }

    /// Find all elements matching the selector.
    func findElements(_ selector: ElementSelector, parentId: String? = nil) throws -> [ElementInfo] {
        if let xpath = selector.xpath {
            return try findByXPath(xpath)
        }

        let root: XCUIElement
        if let parentId = parentId {
            guard let parent = getCachedElement(parentId) else {
                throw AgentError.elementNotFound("Parent element '\(parentId)' not found in cache")
            }
            root = parent
        } else {
            root = app
        }

        let xcElements = try findXCUIElements(selector, in: root)

        // Apply additional attribute filters
        let filtered = xcElements.filter { elem in
            if let wantEnabled = selector.enabled, elem.isEnabled != wantEnabled { return false }
            if let wantChecked = selector.checked {
                let isChecked = checkedState(
                    for: elem.elementType,
                    value: elem.value as? String,
                    selected: elem.isSelected
                )
                if isChecked != wantChecked { return false }
            }
            if let wantFocused = selector.focused, elem.hasFocus != wantFocused { return false }
            return true
        }

        return filtered.map { cacheAndConvert($0) }
    }

    /// Get a cached XCUIElement by its stable ID.
    /// - Throws: AgentError.elementNotFound if the ID is not in the cache.
    func getElement(_ elementId: String) throws -> XCUIElement {
        guard let elem = getCachedElement(elementId) else {
            throw AgentError.elementNotFound("Element '\(elementId)' not found. It may have gone stale.")
        }
        return elem
    }

    /// Get the ElementInfo for a cached element, reading its current properties.
    func getElementInfo(_ elementId: String) throws -> ElementInfo {
        let elem = try getElement(elementId)
        return toElementInfo(elem, elementId: elementId)
    }

    // MARK: - Element Finding

    private func findXCUIElements(_ selector: ElementSelector, in root: XCUIElement) throws -> [XCUIElement] {
        var results: [XCUIElement] = []

        // Role-based selection
        if let role = selector.role {
            let types = try RoleMapping.elementTypes(for: role)
            for type in types {
                let query = root.descendants(matching: type)
                let matches = allElements(from: query)
                results.append(contentsOf: matches)
            }

            // Filter by accessible name if provided
            if let name = selector.name {
                results = results.filter { elem in
                    elem.label == name || elem.title == name
                }
            }
            return results
        }

        // Text selector — search across all element types
        if let text = selector.text {
            let predicate = NSPredicate(format: "label == %@", text)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // TextContains selector
        if let textContains = selector.textContains {
            let predicate = NSPredicate(format: "label CONTAINS %@", textContains)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // ContentDesc selector (maps to accessibilityLabel on iOS)
        if let contentDesc = selector.contentDesc {
            let predicate = NSPredicate(format: "label == %@", contentDesc)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // Hint selector (maps to placeholderValue on iOS)
        if let hint = selector.hint {
            let predicate = NSPredicate(format: "placeholderValue == %@", hint)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // TestId selector (maps to accessibilityIdentifier on iOS)
        if let testId = selector.testId {
            let predicate = NSPredicate(format: "identifier == %@", testId)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // ResourceId / id selector (also maps to accessibilityIdentifier on iOS)
        if let id = selector.id {
            let predicate = NSPredicate(format: "identifier == %@", id)
            let query = root.descendants(matching: .any).matching(predicate)
            return allElements(from: query)
        }

        // ClassName selector (maps to XCUIElement.ElementType)
        if let className = selector.className {
            if let type = elementTypeFromClassName(className) {
                let query = root.descendants(matching: type)
                return allElements(from: query)
            }
            // If className doesn't map to a known type, return empty
            return []
        }

        throw AgentError.invalidSelector("No valid selector criteria provided")
    }

    // MARK: - XPath

    /// Find elements by evaluating an XPath expression against the accessibility hierarchy.
    /// Note: XMLDocument/XPath is not available on iOS. XPath selectors are not supported.
    /// Users should prefer role(), text(), testId(), or other selector types on iOS.
    private func findByXPath(_ xpath: String) throws -> [ElementInfo] {
        // XMLDocument and XPath evaluation are macOS-only APIs (not available on iOS).
        // XPath is rarely used in practice — most selectors use role, text, or testId.
        throw AgentError.invalidSelector(
            "XPath selectors are not supported on iOS. "
            + "Use role(), text(), testId(), contentDesc(), or other selector types instead."
        )
    }

    // MARK: - Caching

    private func getCachedElement(_ elementId: String) -> XCUIElement? {
        lock.lock()
        defer { lock.unlock() }
        return elementCache[elementId]
    }

    /// Cache an XCUIElement and return its ElementInfo. Called by WaitEngine
    /// to avoid redundant tree traversals after waitForExistence succeeds.
    func cacheElement(_ element: XCUIElement) -> ElementInfo {
        return cacheAndConvert(element)
    }

    private func cacheAndConvert(_ element: XCUIElement) -> ElementInfo {
        let elementId = UUID().uuidString
        lock.lock()
        elementCache[elementId] = element
        lock.unlock()
        return toElementInfo(element, elementId: elementId)
    }

    // MARK: - Conversion

    private func toElementInfo(_ element: XCUIElement, elementId: String) -> ElementInfo {
        // Each XCUIElement property access is an IPC round-trip to the
        // accessibility framework. Read properties once and reuse values
        // to minimize IPC calls. Avoid expensive calls like children().count.
        let frame = element.frame
        let elType = element.elementType
        let label = element.label
        let identifier = element.identifier
        // `XCUIElement` conforms to `XCUIElementAttributes`, so
        // `placeholderValue` is a published property — no KVC required.
        let placeholderValue = element.placeholderValue ?? ""
        let value = element.value as? String

        let bounds = ElementBounds(
            left: Int(frame.origin.x),
            top: Int(frame.origin.y),
            right: Int(frame.origin.x + frame.size.width),
            bottom: Int(frame.origin.y + frame.size.height)
        )

        let className = RoleMapping.typeName(for: elType)
        let role = RoleMapping.resolveRole(for: elType)
        let isSelected = element.isSelected
        let isChecked = checkedState(
            for: elType,
            value: value,
            selected: isSelected
        )

        let viewportRatio = computeViewportRatio(bounds)

        // Mirror SnapshotElementFinder's text-derivation rules so a
        // re-resolved element (e.g. via WaitEngine) reports the same
        // `text` and `hint` as the snapshot path. For text fields we
        // surface only the typed value and treat a placeholder-equal
        // value as empty; other element types fall back to value, then
        // label.
        let isTextField =
            elType == .textField || elType == .secureTextField
                || elType == .textView || elType == .searchField
        let displayText: String?
        if isTextField {
            let v = value ?? ""
            if v.isEmpty || v == placeholderValue {
                displayText = nil
            } else {
                displayText = v
            }
        } else if let v = value, !v.isEmpty {
            displayText = v
        } else {
            displayText = label.isEmpty ? nil : label
        }

        return ElementInfo(
            elementId: elementId,
            className: className,
            text: displayText,
            contentDescription: label.isEmpty ? nil : label,
            resourceId: identifier.isEmpty ? nil : identifier,
            hint: placeholderValue.isEmpty ? nil : placeholderValue,
            bounds: bounds,
            isEnabled: element.isEnabled,
            isChecked: isChecked,
            isFocused: element.hasFocus,
            isClickable: frame.width > 0 && frame.height > 0,
            isFocusable: true,
            isScrollable: elType == .scrollView
                || elType == .table
                || elType == .collectionView,
            isVisible: viewportRatio > 0,
            isSelected: isSelected,
            childCount: 0,  // Skip children().count — very expensive IPC
            role: role,
            viewportRatio: viewportRatio
        )
    }

    // MARK: - Helpers

    private func computeViewportRatio(_ bounds: ElementBounds) -> Float {
        let screen = screenSize
        let screenRect = CGRect(x: 0, y: 0, width: screen.width, height: screen.height)
        let elemRect = CGRect(
            x: CGFloat(bounds.left),
            y: CGFloat(bounds.top),
            width: CGFloat(bounds.width),
            height: CGFloat(bounds.height)
        )

        let elementArea = elemRect.width * elemRect.height
        guard elementArea > 0 else { return 0 }

        let intersection = screenRect.intersection(elemRect)
        guard !intersection.isNull else { return 0 }

        let intersectionArea = intersection.width * intersection.height
        return Float(min(max(intersectionArea / elementArea, 0), 1))
    }

    /// Extract all concrete elements from an XCUIElementQuery.
    private func allElements(from query: XCUIElementQuery) -> [XCUIElement] {
        let count = query.count
        guard count > 0 else { return [] }
        var elements: [XCUIElement] = []
        for i in 0..<count {
            let elem = query.element(boundBy: i)
            if elem.exists {
                elements.append(elem)
            }
        }
        return elements
    }

    /// Map a className string (e.g., "XCUIElementTypeButton") to an ElementType.
    private func elementTypeFromClassName(_ className: String) -> XCUIElement.ElementType? {
        // Try direct mapping from known type names
        let typeMap: [String: XCUIElement.ElementType] = [
            "XCUIElementTypeButton": .button,
            "XCUIElementTypeStaticText": .staticText,
            "XCUIElementTypeTextField": .textField,
            "XCUIElementTypeSecureTextField": .secureTextField,
            "XCUIElementTypeImage": .image,
            "XCUIElementTypeCell": .cell,
            "XCUIElementTypeTable": .table,
            "XCUIElementTypeCollectionView": .collectionView,
            "XCUIElementTypeScrollView": .scrollView,
            "XCUIElementTypeSwitch": .switch,
            "XCUIElementTypeToggle": .toggle,
            "XCUIElementTypeSlider": .slider,
            "XCUIElementTypeProgressIndicator": .progressIndicator,
            "XCUIElementTypeActivityIndicator": .activityIndicator,
            "XCUIElementTypePicker": .picker,
            "XCUIElementTypeToolbar": .toolbar,
            "XCUIElementTypeTabBar": .tabBar,
            "XCUIElementTypeTab": .tab,
            "XCUIElementTypeLink": .link,
            "XCUIElementTypeCheckBox": .checkBox,
            "XCUIElementTypeRadioButton": .radioButton,
            "XCUIElementTypeSearchField": .searchField,
            "XCUIElementTypeNavigationBar": .navigationBar,
            "XCUIElementTypeWebView": .webView,
            "XCUIElementTypeWindow": .window,
            "XCUIElementTypeAlert": .alert,
            "XCUIElementTypeOther": .other,
        ]
        return typeMap[className]
    }

    /// Parse a bounds string in [left,top][right,bottom] format.
    private func parseBoundsString(_ str: String) -> ElementBounds {
        let pattern = "\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)),
              match.numberOfRanges == 5
        else {
            return ElementBounds(left: 0, top: 0, right: 0, bottom: 0)
        }

        func intAt(_ i: Int) -> Int {
            let range = Range(match.range(at: i), in: str)!
            return Int(str[range]) ?? 0
        }
        return ElementBounds(left: intAt(1), top: intAt(2), right: intAt(3), bottom: intAt(4))
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

    private func checkedState(
        for elementType: XCUIElement.ElementType,
        value: String?,
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
            switch elementType {
            case .switch, .toggle, .checkBox, .radioButton:
                return selected
            default:
                return false
            }
        }
    }
}
