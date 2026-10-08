package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Host-side tests for [ElementSelector.describe], the text not-found errors,
 * wait timeouts and the find-phase log use to name a selector (PILOT-606).
 * Every field the finder filters on must appear, or a failing locator reports
 * an empty or partial selector.
 */
class SelectorDescriptionTest {
    private fun regex(
        pattern: String,
        ignoreCase: Boolean = false,
    ) = TextRegex(pattern, ignoreCase, "/$pattern/" + if (ignoreCase) "i" else "")

    @Test
    fun `a label selector names its label`() {
        assertEquals("label=Email", ElementSelector(label = "Email").describe())
    }

    @Test
    fun `a RegExp label selector names its RegExp`() {
        assertEquals("label=/^e-?mail/i", ElementSelector(labelRegex = regex("^e-?mail", ignoreCase = true)).describe())
    }

    @Test
    fun `state filters are named, false as well as true`() {
        val selector =
            ElementSelector(
                role = "checkbox",
                enabled = false,
                checked = true,
                focused = false,
                selected = true,
                expanded = false,
            )
        assertEquals(
            "role=checkbox, enabled=false, checked=true, focused=false, selected=true, expanded=false",
            selector.describe(),
        )
    }

    @Test
    fun `the existing fields keep their names`() {
        assertEquals(
            "role=button, name=Sign in, exact=true",
            ElementSelector(role = "button", name = "Sign in", nameExact = true).describe(),
        )
        assertEquals("role=button, name=/sign/i", ElementSelector(role = "button", nameRegex = regex("sign", true)).describe())
        assertEquals("text=Hello", ElementSelector(text = "Hello").describe())
        assertEquals("textContains=ell", ElementSelector(textContains = "ell").describe())
        assertEquals("text=/h.llo/", ElementSelector(textRegex = regex("h.llo")).describe())
        assertEquals(
            "contentDesc=Close, hint=Search, className=android.widget.EditText, testId=field, id=pkg:id/field, xpath=//x",
            ElementSelector(
                contentDesc = "Close",
                hint = "Search",
                className = "android.widget.EditText",
                testId = "field",
                id = "pkg:id/field",
                xpath = "//x",
            ).describe(),
        )
    }

    @Test
    fun `an empty selector describes as empty`() {
        assertEquals("", ElementSelector().describe())
    }
}
