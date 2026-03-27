import Foundation

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
}
