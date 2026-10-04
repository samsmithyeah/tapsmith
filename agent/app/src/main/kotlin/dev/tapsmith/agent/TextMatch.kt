package dev.tapsmith.agent

import java.util.regex.Pattern

/**
 * Whitespace-normalized text matching for `getByText` and accessible-name
 * matching (PILOT-510), the way Playwright matches text: runs of whitespace
 * collapse to one space and the ends are trimmed, on both the element's text
 * and the query, exact or substring. A label rendered with a non-breaking
 * space (`Welcome to&nbsp;Expo`) or a line break then matches a query typed
 * with plain spaces.
 *
 * "Whitespace" is JavaScript's `\s` set, so the agents agree with each other
 * (the iOS agent's TextMatch.swift uses the same set) and with the SDK's
 * trace-viewer matcher. Java's own `\s` is ASCII-only.
 *
 * UIAutomator compares text inside `By.text(Pattern)`, so for those queries
 * this builds a full-match [Pattern] equivalent to comparing normalized
 * strings: the query's words, quoted, joined by one-or-more whitespace.
 */
object TextMatch {
    /** JavaScript's `\s`: ECMAScript WhiteSpace and LineTerminator code points. */
    private const val WS_CLASS =
        "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"
    private val WS_RUN = Regex("$WS_CLASS+")

    /** Collapse whitespace runs to one space and trim. */
    fun normalize(text: String): String = text.replace(WS_RUN, " ").trim(' ')

    /** Whether [actual] (null = no text) equals [expected] once both are normalized. */
    fun equalsNormalized(
        actual: CharSequence?,
        expected: String,
    ): Boolean = actual != null && normalize(actual.toString()) == normalize(expected)

    /** Full-match pattern: the text equals [query] after normalizing both. */
    fun exactPattern(query: String): Pattern = Pattern.compile("$WS_CLASS*${wordsPattern(query)}$WS_CLASS*")

    /** Full-match pattern: the normalized text contains the normalized [query]. */
    fun containsPattern(query: String): Pattern = Pattern.compile("(?s).*${wordsPattern(query)}.*")

    private fun wordsPattern(query: String): String {
        val normalized = normalize(query)
        if (normalized.isEmpty()) return ""
        return normalized.split(' ').joinToString("$WS_CLASS+") { Pattern.quote(it) }
    }
}
