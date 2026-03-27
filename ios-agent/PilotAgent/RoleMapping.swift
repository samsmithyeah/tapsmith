import XCTest

/// Maps Pilot role names to XCUIElement.ElementType values.
/// Mirrors the Android agent's roleClassMap in ElementFinder.kt.
enum RoleMapping {

    /// Role name → list of XCUIElement.ElementType that represent that role.
    static let roleToElementTypes: [String: [XCUIElement.ElementType]] = [
        "button": [.button],
        "textfield": [.textField, .secureTextField],
        "checkbox": [.checkBox],
        "switch": [.switch, .toggle],
        "image": [.image],
        "text": [.staticText],
        "heading": [.staticText],  // filtered by trait in practice
        "link": [.link],
        "list": [.table, .collectionView],
        "listitem": [.cell],
        "scrollview": [.scrollView],
        "progressbar": [.progressIndicator],
        "seekbar": [.slider],
        "radiobutton": [.radioButton],
        "spinner": [.picker, .activityIndicator],
        "toolbar": [.toolbar],
        "tab": [.tab, .tabBar],
    ]

    /// Reverse mapping: XCUIElement.ElementType → role name.
    static let elementTypeToRole: [XCUIElement.ElementType: String] = {
        var map: [XCUIElement.ElementType: String] = [:]
        for (role, types) in roleToElementTypes {
            for type in types {
                // First mapping wins (e.g., .staticText → "text", not "heading")
                if map[type] == nil {
                    map[type] = role
                }
            }
        }
        return map
    }()

    /// Resolve a role name from an XCUIElement.ElementType.
    static func resolveRole(for elementType: XCUIElement.ElementType) -> String {
        return elementTypeToRole[elementType] ?? ""
    }

    /// Get the XCUIElement.ElementType values for a role name.
    /// - Throws: AgentError.invalidSelector if the role is unknown.
    static func elementTypes(for role: String) throws -> [XCUIElement.ElementType] {
        guard let types = roleToElementTypes[role.lowercased()] else {
            let known = roleToElementTypes.keys.sorted().joined(separator: ", ")
            throw AgentError.invalidSelector("Unknown role: '\(role)'. Known roles: \(known)")
        }
        return types
    }

    /// Convert an XCUIElement.ElementType to a string name for the className field.
    /// Uses the XCUIElementType naming convention (e.g., "XCUIElementTypeButton").
    static func typeName(for elementType: XCUIElement.ElementType) -> String {
        switch elementType {
        case .button: return "XCUIElementTypeButton"
        case .staticText: return "XCUIElementTypeStaticText"
        case .textField: return "XCUIElementTypeTextField"
        case .secureTextField: return "XCUIElementTypeSecureTextField"
        case .image: return "XCUIElementTypeImage"
        case .cell: return "XCUIElementTypeCell"
        case .table: return "XCUIElementTypeTable"
        case .collectionView: return "XCUIElementTypeCollectionView"
        case .scrollView: return "XCUIElementTypeScrollView"
        case .switch: return "XCUIElementTypeSwitch"
        case .toggle: return "XCUIElementTypeToggle"
        case .slider: return "XCUIElementTypeSlider"
        case .progressIndicator: return "XCUIElementTypeProgressIndicator"
        case .activityIndicator: return "XCUIElementTypeActivityIndicator"
        case .picker: return "XCUIElementTypePicker"
        case .toolbar: return "XCUIElementTypeToolbar"
        case .tabBar: return "XCUIElementTypeTabBar"
        case .tab: return "XCUIElementTypeTab"
        case .link: return "XCUIElementTypeLink"
        case .checkBox: return "XCUIElementTypeCheckBox"
        case .radioButton: return "XCUIElementTypeRadioButton"
        case .searchField: return "XCUIElementTypeSearchField"
        case .navigationBar: return "XCUIElementTypeNavigationBar"
        case .webView: return "XCUIElementTypeWebView"
        case .window: return "XCUIElementTypeWindow"
        case .alert: return "XCUIElementTypeAlert"
        case .sheet: return "XCUIElementTypeSheet"
        case .other: return "XCUIElementTypeOther"
        default: return "XCUIElementType(\(elementType.rawValue))"
        }
    }
}
