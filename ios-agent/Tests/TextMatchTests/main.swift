// Unit tests for TextMatch (PILOT-510): whitespace-normalized text and
// accessible-name matching, and the ICU patterns the XCUIElement queries use.

import Foundation

var failures = 0

func expect(_ name: String, _ ok: Bool) {
    if ok {
        print("ok   \(name)")
    } else {
        failures += 1
        print("FAIL \(name)")
    }
}

/// Evaluate a pattern the way XCUITest does: `label MATCHES %@` (a full match).
func matches(_ pattern: String, _ text: String) -> Bool {
    NSPredicate(format: "SELF MATCHES %@", pattern).evaluate(with: text)
}

// normalize: JavaScript's \s set collapses to one space; ends are trimmed.
expect("NBSP becomes a space", TextMatch.normalize("Welcome to\u{00A0}Expo") == "Welcome to Expo")
expect("runs of mixed Unicode spaces collapse",
       TextMatch.normalize("  a \u{202F}\u{2003} b\n\tc \u{3000}") == "a b c")
expect("whitespace-only becomes empty", TextMatch.normalize(" \u{00A0}\n ") == "")
expect("zero-width space is not whitespace", TextMatch.normalize("a\u{200B}b") == "a\u{200B}b")

// equals / contains on normalized strings.
expect("equals across NBSP", TextMatch.equals("Welcome to\u{00A0}Expo", "Welcome to Expo"))
expect("equals across a line break", TextMatch.equals("Line one\nLine two", "Line one Line two"))
expect("equals ignores query padding", TextMatch.equals("Save draft", " Save  draft "))
expect("equals is still exact", !TextMatch.equals("Welcome to Expo", "Welcome to"))
expect("equals is case-sensitive", !TextMatch.equals("Welcome", "welcome"))
expect("contains across NBSP", TextMatch.contains("Welcome to\u{00A0}Expo", "to Expo"))
expect("contains with padded query", TextMatch.contains("Welcome to\u{00A0}Expo!", " to  Expo "))
expect("contains rejects a non-substring", !TextMatch.contains("Welcome to\u{00A0}Expo", "to Expos"))
expect("empty query is contained in anything", TextMatch.contains("anything", "\u{00A0}"))

// Concatenated child labels (iOS joins child text with ", ").
expect("child text inside a concatenated label",
       TextMatch.containsChildText("Intro, Welcome to\u{00A0}Expo, More", childText: "Welcome to Expo"))
expect("first child of a concatenated label",
       TextMatch.containsChildText("Welcome to\u{00A0}Expo, More", childText: "Welcome to Expo"))
expect("last child of a concatenated label",
       TextMatch.containsChildText("Intro,\u{00A0}Welcome to Expo", childText: "Welcome to Expo"))
expect("a partial child is not a child",
       !TextMatch.containsChildText("Intro, Welcome to Expo now", childText: "Welcome to Expo"))

// ICU patterns, evaluated like an XCUIElement predicate.
expect("exact pattern: NBSP", matches(TextMatch.exactPattern("Welcome to Expo"), "Welcome to\u{00A0}Expo"))
expect("exact pattern: line break", matches(TextMatch.exactPattern("Line one Line two"), "Line one\nLine two"))
expect("exact pattern: padded text", matches(TextMatch.exactPattern("a b"), "\u{2028}a\u{205F}\u{FEFF}b\r\n"))
expect("exact pattern: whole text only", !matches(TextMatch.exactPattern("Welcome to"), "Welcome to Expo"))
expect("exact pattern: words stay separate", !matches(TextMatch.exactPattern("WelcometoExpo"), "Welcome to Expo"))
expect("contains pattern: NBSP", matches(TextMatch.containsPattern("to Expo"), "Welcome to\u{00A0}Expo"))
expect("contains pattern: across lines", matches(TextMatch.containsPattern("one Line"), "Line one\nLine two"))
expect("contains pattern: multi-line text", matches(TextMatch.containsPattern("two"), "Line one\nLine two\nthree"))
expect("contains pattern: not a substring", !matches(TextMatch.containsPattern("to Expos"), "Welcome to Expo"))
expect("metacharacters are literal (exact)", matches(TextMatch.exactPattern("Total: $5.00 (x)"), "Total: $5.00 (x)"))
expect("metacharacters are literal (dot)", !matches(TextMatch.exactPattern("a.c"), "abc"))
expect("metacharacters are literal (contains)", matches(TextMatch.containsPattern("[beta]*"), "Try [beta]* now"))
expect("metacharacters are literal (quantifier)", !matches(TextMatch.containsPattern("a+"), "aaa"))
expect("backslash sequences are literal", matches(TextMatch.exactPattern("\\Q\\E"), "\\Q\\E"))

// The concatenated-label pattern accepts at least what containsChildText does.
let concat = TextMatch.concatenatedLabelPattern("Welcome to Expo")
expect("concatenated pattern: whole label", matches(concat, "Welcome to\u{00A0}Expo"))
expect("concatenated pattern: first child", matches(concat, "Welcome to\u{00A0}Expo, More"))
expect("concatenated pattern: middle child", matches(concat, "Intro, Welcome to Expo, More"))
expect("concatenated pattern: last child", matches(concat, "Intro,\u{00A0}Welcome to Expo"))
expect("concatenated pattern: multi-line label", matches(concat, "Intro\nline, Welcome to Expo"))
expect("concatenated pattern: not a partial child", !matches(concat, "Intro, Welcome to Expo now"))

if failures > 0 {
    print("\(failures) failure(s)")
    exit(1)
}
print("all TextMatch tests passed")
