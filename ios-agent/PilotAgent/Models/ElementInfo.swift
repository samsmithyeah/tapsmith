import Foundation
import XCTest

/// Selector specification for finding elements.
/// Mirrors the Android agent's ElementSelector data class.
struct ElementSelector {
    var role: String?
    var name: String?
    var text: String?
    var textContains: String?
    var contentDesc: String?
    var hint: String?
    var className: String?
    var testId: String?
    var id: String?
    var xpath: String?
    var enabled: Bool?
    var checked: Bool?
    var focused: Bool?
}

/// Bounding rectangle for an element.
struct ElementBounds {
    let left: Int
    let top: Int
    let right: Int
    let bottom: Int

    var centerX: Int { (left + right) / 2 }
    var centerY: Int { (top + bottom) / 2 }
    var width: Int { right - left }
    var height: Int { bottom - top }

    func toDict() -> [String: Any] {
        return [
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
            "centerX": centerX,
            "centerY": centerY,
            "width": width,
            "height": height,
        ]
    }
}

/// Information about a found UI element.
/// Mirrors the Android agent's ElementInfo data class and the proto ElementInfo message.
struct ElementInfo {
    let elementId: String
    let className: String
    let text: String?
    let contentDescription: String?
    let resourceId: String?
    let hint: String?
    let bounds: ElementBounds
    let isEnabled: Bool
    let isChecked: Bool
    let isFocused: Bool
    let isClickable: Bool
    let isFocusable: Bool
    let isScrollable: Bool
    let isVisible: Bool
    let isSelected: Bool
    /// Number of direct children of this element.
    ///
    /// **Path asymmetry — read with care:**
    /// - The snapshot path (`SnapshotElementFinder` / `findElementsBySnapshot`) populates this from the snapshot dictionary, so it reflects the true accessibility-tree fan-out.
    /// - The live `XCUIElement` path (`makeFromXCUIElement`) returns `0` regardless of the actual child count — calling `element.children(...)` here would synchronously dump the subtree, which is the exact cost we built the snapshot path to avoid.
    ///
    /// In practice the snapshot path serves all SDK queries, so consumers see real counts. Don't read this field from internal call sites that may have come through the live path without verifying which finder produced the `ElementInfo`.
    let childCount: Int
    let role: String
    let viewportRatio: Float

    func toDict() -> [String: Any] {
        var dict: [String: Any] = [
            "elementId": elementId,
            "className": className,
            "bounds": bounds.toDict(),
            "enabled": isEnabled,
            "checked": isChecked,
            "focused": isFocused,
            "clickable": isClickable,
            "focusable": isFocusable,
            "scrollable": isScrollable,
            "visible": isVisible,
            "selected": isSelected,
            "childCount": childCount,
            "role": role,
            "viewportRatio": Double(viewportRatio),
        ]
        // Use NSNull for nil values to match Android's JSONObject.NULL behavior
        dict["text"] = text as Any? ?? NSNull()
        dict["contentDescription"] = contentDescription as Any? ?? NSNull()
        dict["resourceId"] = resourceId as Any? ?? NSNull()
        dict["hint"] = hint as Any? ?? NSNull()
        return dict
    }

    /// Build an `ElementInfo` from a live `XCUIElement`.
    ///
    /// Both `SnapshotElementFinder.toElementInfo(_ element:elementId:)` and
    /// `ElementFinder.toElementInfo(_ element:elementId:)` route through
    /// here so the two XCUIElement-based code paths can't drift on text
    /// derivation, role resolution, hint surfacing, or checked-state
    /// detection. Past dual-implementation bugs (round-7 `text`, round-8
    /// `checkedState`, round-cold-4 `traits`-aware role) were caused by
    /// only updating one of the two parallel methods. Keep this helper
    /// the single source of truth for live-element conversion.
    ///
    /// `bounds` and `viewportRatio` are pre-computed by the caller
    /// because each path measures the screen differently. `traits` is
    /// resolved here via KVC (with a `responds(to:)` guard, mirroring
    /// `SnapshotElementFinder.annotateTraits`) so the returned `role`
    /// honours React Native `accessibilityRole` flags.
    static func makeFromXCUIElement(
        _ element: XCUIElement,
        elementId: String,
        bounds: ElementBounds,
        viewportRatio: Float
    ) -> ElementInfo {
        let elType = element.elementType
        let label = element.label
        let identifier = element.identifier
        // Only text-input elements carry a meaningful `placeholderValue`.
        // Reading it on every element is an extra IPC per node that adds up
        // on screens with many siblings; gating here keeps the live-element
        // path lean for non-text widgets where the value is always nil.
        let isTextInput = elType == .textField
            || elType == .secureTextField
            || elType == .textView
            || elType == .searchField
        let placeholderValue = isTextInput ? (element.placeholderValue ?? "") : ""
        let value = element.value as? String

        let className = RoleMapping.typeName(for: elType)
        let traits = ElementInfo.extractTraits(from: element)
        let role = RoleMapping.resolveRole(for: elType, traits: traits)

        let isSelected = element.isSelected
        let isChecked = ElementInfo.deriveCheckedState(
            elementType: elType,
            value: value,
            label: label,
            selected: isSelected
        )

        let displayText = ElementInfo.deriveDisplayText(
            elementType: elType,
            value: value,
            placeholderValue: placeholderValue,
            label: label
        )

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
            isClickable: bounds.width > 0 && bounds.height > 0,
            isFocusable: true,
            isScrollable: elType == .scrollView
                || elType == .table
                || elType == .collectionView,
            isVisible: viewportRatio > 0,
            isSelected: isSelected,
            // Always 0 on the live XCUIElement path. See the `childCount`
            // doc on the struct for the asymmetry vs. the snapshot path.
            childCount: 0,
            role: role,
            viewportRatio: viewportRatio
        )
    }

    /// Text-derivation rules shared by both XCUIElement paths and the
    /// snapshot-dict path's textfield branch. For text fields surface
    /// only the typed value (placeholder-equal value reads as empty);
    /// other element types fall back to value, then label.
    static func deriveDisplayText(
        elementType: XCUIElement.ElementType,
        value: String?,
        placeholderValue: String,
        label: String
    ) -> String? {
        let isTextField =
            elementType == .textField || elementType == .secureTextField
                || elementType == .textView || elementType == .searchField
        if isTextField {
            let v = value ?? ""
            if v.isEmpty || v == placeholderValue {
                return nil
            }
            return v
        }
        if let v = value, !v.isEmpty {
            return v
        }
        return label.isEmpty ? nil : label
    }

    /// Read `traits` off an XCUIElement via KVC. Mirrors
    /// `SnapshotElementFinder.annotateTraits` — `responds(to:)` first so
    /// a future Xcode that drops the property doesn't crash with an
    /// uncatchable `NSUnknownKeyException`.
    ///
    /// `XCElementSnapshot` is documented to expose `traits` via KVC; the
    /// live `XCUIElement` is not. In practice today's Xcode forwards the
    /// key onto the underlying snapshot, so the same call works on both,
    /// but if a future SDK rev breaks that forwarding, trait-derived role
    /// resolution on this code path silently degrades to type-only. Log
    /// once when the responds-check fails so the regression surfaces in
    /// the agent log instead of failing tests with an unhelpful "no role".
    static func extractTraits(from element: XCUIElement) -> UInt64 {
        guard let nsElement = element as? NSObject,
              nsElement.responds(to: NSSelectorFromString("traits")) else {
            ElementInfo.liveTraitsKvcMissLogger.log(
                "[Pilot] XCUIElement does not respond to KVC `traits`. " +
                    "Trait-derived roles via the live-element path will not resolve. " +
                    "Likely cause: Xcode SDK change. Snapshot path is unaffected."
            )
            return 0
        }
        let raw = nsElement.value(forKey: "traits")
        if let v = raw as? UInt64 { return v }
        if let v = raw as? NSNumber { return v.uint64Value }
        if let v = raw as? Int { return UInt64(bitPattern: Int64(v)) }
        return 0
    }

    /// One-shot logger for the live-path KVC `traits` miss. Mirrors the
    /// pattern in `SnapshotElementFinder` (separate logger so a snapshot-side
    /// miss does not silence a live-side miss or vice versa).
    private final class OneShotLogger {
        private let lock = NSLock()
        private var fired = false

        func log(_ message: String) {
            lock.lock()
            defer { lock.unlock() }
            guard !fired else { return }
            fired = true
            NSLog("%@", message)
        }
    }

    private static let liveTraitsKvcMissLogger = OneShotLogger()

    /// Pulled out of `SnapshotElementFinder` so the live-element paths
    /// can use the same React Native compound-value parsing.
    /// Element types that natively expose state via `selected` (switch,
    /// toggle, checkbox, radio button) fall through to that flag when
    /// the value string isn't recognized.
    static func deriveCheckedState(
        elementType: XCUIElement.ElementType,
        value: String?,
        label: String,
        selected: Bool
    ) -> Bool {
        let normalized = (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch normalized {
        case "1", "true", "on", "yes", "selected", "checked":
            return true
        case "0", "false", "off", "no", "not selected", "unchecked":
            return false
        default:
            break
        }
        // RN compound values: "checkbox, checked", "radio button, unchecked", etc.
        if normalized.hasSuffix(", checked") || normalized.hasSuffix(", selected") {
            return true
        }
        if normalized.hasSuffix(", unchecked") || normalized.hasSuffix(", not selected") {
            return false
        }
        // Fall through to platform-native state for togglable element types.
        switch elementType {
        case .switch, .toggle, .checkBox, .radioButton:
            return selected
        default:
            return false
        }
    }
}
