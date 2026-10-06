package dev.tapsmith.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Host-side tests for RegExp locators (PILOT-520). The SDK translates each
 * JavaScript RegExp into a pattern with JavaScript's semantics; the agent only
 * compiles and runs it. The conformance fixture pins those translations with
 * JavaScript's own answer for each input (packages/tapsmith text-regex.test.ts).
 *
 * The device runs Android's ICU-backed java.util.regex; these tests run on the
 * host JVM's engine — the translation avoids every construct the two read
 * differently, and the device e2e test covers the device engine.
 */
class TextRegexTest {
    private fun fixtureFile(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "packages/tapsmith/src/__tests__/fixtures/regex-conformance.json")
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        error("regex-conformance.json not found above ${System.getProperty("user.dir")}")
    }

    private fun regex(
        pattern: String,
        ignoreCase: Boolean = false,
    ) = TextRegex(pattern, ignoreCase, "/$pattern/")

    @Test
    fun `every conformance case gives JavaScript's answer`() {
        val cases = JSONObject(fixtureFile().readText()).getJSONArray("cases")
        assertTrue(cases.length() > 50)
        val failures = mutableListOf<String>()
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val re = TextRegex(c.getString("pattern"), c.getBoolean("ignoreCase"), "/${c.getString("source")}/")
            val input = c.getString("input")
            val expected = c.getBoolean("matches")
            if (re.matches(input) != expected) {
                failures.add("search /${c.getString("source")}/${c.getString("flags")} (${c.getString("why")})")
            }
            // UIAutomator's By.text(Pattern) needs a whole-string match.
            if (re.fullMatchPattern().matcher(input).matches() != expected) {
                failures.add("full match /${c.getString("source")}/${c.getString("flags")} (${c.getString("why")})")
            }
        }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun `a null text never matches`() {
        assertFalse(regex("x*").matches(null))
    }

    @Test
    fun `ignoreCase folds non-ASCII letters`() {
        assertTrue(regex("\\u00E9t\\u00E9", ignoreCase = true).matches("ÉTÉ"))
        assertFalse(regex("\\u00E9t\\u00E9").matches("ÉTÉ"))
    }

    @Test
    fun `a pattern the engine rejects is an invalid selector naming the RegExp`() {
        val error =
            assertThrows(InvalidSelectorException::class.java) {
                TextRegex("(?<=a+", false, "/(?<=a+/")
            }
        assertTrue(error.message!!.contains("/(?<=a+/"))
    }

    @Test
    fun `parses the daemon's textRegex object`() {
        val re = TextRegex.fromJson(JSONObject("""{"pattern":"save","ignoreCase":true,"display":"/save/i"}"""))!!
        assertEquals("/save/i", re.display)
        assertTrue(re.matches("SAVE"))
        assertEquals(null, TextRegex.fromJson(null))
    }

    @Test
    fun `an accessible-name RegExp is tested against the normalized name`() {
        val re = regex("^Save[\\u0009-\\u000D\\u0020\\u00A0\\u202F]draft$")
        val match = { desc: String?, text: String?, textIsValue: Boolean, descendants: String? ->
            TextMatch.accessibleNameMatches(desc, text, textIsValue, { descendants }, re)
        }
        assertTrue(match("  Save draft\n", null, false, null))
        assertTrue(match(null, "Save   draft", false, null))
        assertTrue(match(null, null, false, "Save draft"))
        assertFalse(match(null, "Save draft extra", false, null))
    }

    @Test
    fun `a typed EditText value is not an accessible name for a RegExp`() {
        val re = regex("draft")
        assertFalse(TextMatch.accessibleNameMatches(null, "my draft", true, { null }, re))
        assertTrue(TextMatch.accessibleNameMatches("Draft notes", "my draft", true, { null }, regex("Draft")))
    }
}
