import Foundation

/// Whitespace-normalized text matching for `getByText` and accessible-name
/// matching (PILOT-510), the way Playwright matches text: runs of whitespace
/// collapse to one space and the ends are trimmed, on both the element's
/// label and the query, exact or substring. A label rendered with a
/// non-breaking space (`Welcome to&nbsp;Expo`) or a line break then matches a
/// query typed with plain spaces.
///
/// "Whitespace" is JavaScript's `\s` set, the same set the Android agent's
/// TextMatch.kt and the SDK's trace-viewer matcher use.
///
/// The snapshot walk compares normalized strings. XCUIElement queries can't
/// normalize, so they get an ICU pattern (`label MATCHES %@`, a full match)
/// that accepts the same labels: the query's words, escaped, joined by
/// one-or-more whitespace.
enum TextMatch {
    /// JavaScript's `\s`: ECMAScript WhiteSpace and LineTerminator code points.
    private static let whitespace: Set<Unicode.Scalar> = {
        var set: Set<Unicode.Scalar> = [
            "\u{09}", "\u{0A}", "\u{0B}", "\u{0C}", "\u{0D}", "\u{20}", "\u{A0}", "\u{1680}",
            "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
        ]
        for value in UInt32(0x2000)...UInt32(0x200A) {
            if let scalar = Unicode.Scalar(value) { set.insert(scalar) }
        }
        return set
    }()

    /// The same set as an ICU character class.
    private static let wsClass =
        "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"

    /// Collapse whitespace runs to one space and trim.
    static func normalize(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace = false
        for scalar in text.unicodeScalars {
            if whitespace.contains(scalar) {
                pendingSpace = true
            } else {
                if pendingSpace && !out.isEmpty { out.append(" ") }
                pendingSpace = false
                out.append(scalar)
            }
        }
        return String(out)
    }

    /// Whether `text` equals `query` once both are normalized.
    static func equals(_ text: String, _ query: String) -> Bool {
        normalize(text) == normalize(query)
    }

    /// Whether the normalized `text` contains the normalized `query`.
    static func contains(_ text: String, _ query: String) -> Bool {
        let needle = normalize(query)
        return needle.isEmpty || normalize(text).contains(needle)
    }

    /// Whether `childText` is one of the child texts iOS joined with ", " to
    /// form `label` (or the whole label), compared normalized.
    static func containsChildText(_ label: String, childText: String) -> Bool {
        let label = normalize(label)
        let child = normalize(childText)
        if label == child { return true }
        if label.hasPrefix(child + ", ") { return true }
        if label.hasSuffix(", " + child) { return true }
        if label.contains(", " + child + ", ") { return true }
        return false
    }

    /// Whether `text` matches the accessible-name `query` the way Playwright's
    /// getByRole `name` does (PILOT-549): by default a case-insensitive
    /// substring; with `exact`, case-sensitive equality — or, as iOS joins
    /// child text into one label with ", ", one whole child of that label.
    /// Whitespace is normalized either way.
    static func nameMatches(_ text: String, _ query: String, exact: Bool) -> Bool {
        if exact {
            return equals(text, query) || containsChildText(text, childText: query)
        }
        let needle = normalize(query).lowercased()
        return needle.isEmpty || normalize(text).lowercased().contains(needle)
    }

    /// ICU full-match pattern accepting the labels `nameMatches` accepts.
    static func nameQueryPattern(_ query: String, exact: Bool) -> String {
        exact ? concatenatedLabelPattern(query) : "(?si).*\(words(query)).*"
    }

    /// ICU full-match pattern: the label equals `query` after normalizing both.
    static func exactPattern(_ query: String) -> String {
        "\(wsClass)*\(words(query))\(wsClass)*"
    }

    /// ICU full-match pattern: the normalized label contains the normalized `query`.
    static func containsPattern(_ query: String) -> String {
        "(?s).*\(words(query)).*"
    }

    /// ICU full-match pattern for `containsChildText`: the whole label, or a
    /// first, middle or last child of a ", "-joined label.
    static func concatenatedLabelPattern(_ query: String) -> String {
        "(?s)(?:\(wsClass)*|.*,\(wsClass)+)\(words(query))(?:\(wsClass)*|,\(wsClass)+.*)"
    }

    private static func words(_ query: String) -> String {
        let normalized = normalize(query)
        if normalized.isEmpty { return "" }
        return normalized
            .split(separator: " ")
            .map { NSRegularExpression.escapedPattern(for: String($0)) }
            .joined(separator: "\(wsClass)+")
    }
}
