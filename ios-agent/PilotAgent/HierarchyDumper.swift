import XCTest
import Foundation

/// Dumps the current UI hierarchy as an XML string.
///
/// Mirrors the Android agent's HierarchyDumper.kt. Traverses the XCUIElement
/// tree and produces XML with attributes matching the Android format for
/// compatibility with the daemon and XPath queries.
class HierarchyDumper {
    private let app: XCUIApplication

    init(app: XCUIApplication) {
        self.app = app
    }

    /// Dump the full UI hierarchy as an XML string.
    func dump() -> String {
        var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        xml += "<hierarchy>\n"
        dumpElement(app, depth: 1, into: &xml)
        xml += "</hierarchy>\n"
        return xml
    }

    private func dumpElement(_ element: XCUIElement, depth: Int, into xml: inout String) {
        let indent = String(repeating: "  ", count: depth)
        let typeName = RoleMapping.typeName(for: element.elementType)
        let frame = element.frame

        let bounds = "[\(Int(frame.origin.x)),\(Int(frame.origin.y))]"
            + "[\(Int(frame.origin.x + frame.width)),\(Int(frame.origin.y + frame.height))]"

        let label = escapeXML(element.label)
        let identifier = escapeXML(element.identifier)
        let value = escapeXML((element.value as? String) ?? "")
        let placeholder = escapeXML(element.placeholderValue ?? "")

        xml += "\(indent)<\(typeName)"
        xml += " label=\"\(label)\""
        xml += " identifier=\"\(identifier)\""
        xml += " value=\"\(value)\""
        xml += " placeholderValue=\"\(placeholder)\""
        xml += " type=\"\(typeName)\""
        xml += " enabled=\"\(element.isEnabled)\""
        xml += " visible=\"\(element.exists && frame.width > 0 && frame.height > 0)\""
        xml += " selected=\"\(element.isSelected)\""
        xml += " hasFocus=\"\(element.hasFocus)\""
        xml += " bounds=\"\(bounds)\""

        let children = element.children(matching: .any)
        let childCount = children.count

        if childCount == 0 {
            xml += " />\n"
        } else {
            xml += ">\n"
            for i in 0..<childCount {
                let child = children.element(boundBy: i)
                if child.exists {
                    dumpElement(child, depth: depth + 1, into: &xml)
                }
            }
            xml += "\(indent)</\(typeName)>\n"
        }
    }

    private func escapeXML(_ str: String) -> String {
        return str
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}
