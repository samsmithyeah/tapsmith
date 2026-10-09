package dev.tapsmith.agent

import dev.tapsmith.agent.HierarchyAttributes.Box
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The hierarchy dump's attribute injection (`tapsmith-role`,
 * `tapsmith-expanded`): joined to the stock UIAutomator XML by the bounds
 * that XML writes, so the Locator Playground reads the same state the device
 * does (PILOT-655).
 */
class HierarchyAttributesTest {
    @Test
    fun `a node fully on screen keeps its bounds`() {
        val b = HierarchyAttributes.dumpedBounds(Box(10, 100, 500, 200), 1080, 2400, Box(0, 0, 1080, 2400))
        assertEquals("[10,100][500,200]", b.key())
    }

    @Test
    fun `a node partly off screen is keyed by its clipped bounds, as the stock dump writes them`() {
        // Scrolled half above the top of the display.
        assertEquals(
            "[0,0][1080,80]",
            HierarchyAttributes.dumpedBounds(Box(0, -50, 1080, 80), 1080, 2400, Box(0, 0, 1080, 2400)).key(),
        )
        // Past the right edge, then clipped by a window that stops above the nav bar.
        assertEquals(
            "[900,2200][1080,2337]",
            HierarchyAttributes.dumpedBounds(Box(900, 2200, 1300, 2400), 1080, 2400, Box(0, 0, 1080, 2337)).key(),
        )
    }

    @Test
    fun `a box that does not overlap the clip is left unchanged, like Rect intersect`() {
        assertEquals(
            "[0,2500][100,2600]",
            HierarchyAttributes.dumpedBounds(Box(0, 2500, 100, 2600), 1080, 2400, null).key(),
        )
    }

    @Test
    fun `injects each attribute after the bounds of every node with that key`() {
        val xml =
            """<hierarchy><node index="0" class="android.widget.Button" bounds="[0,0][100,50]" />""" +
                """<node index="1" class="android.widget.TextView" bounds="[0,60][100,110]"></node></hierarchy>"""
        val out =
            HierarchyAttributes.inject(
                xml,
                mapOf("[0,0][100,50]" to mapOf("tapsmith-role" to "button", "tapsmith-expanded" to "false")),
            )
        assertEquals(
            """<hierarchy><node index="0" class="android.widget.Button" bounds="[0,0][100,50]" """ +
                """tapsmith-role="button" tapsmith-expanded="false" />""" +
                """<node index="1" class="android.widget.TextView" bounds="[0,60][100,110]"></node></hierarchy>""",
            out,
        )
    }

    @Test
    fun `escapes injected values and leaves the XML alone with nothing to inject`() {
        val xml = """<node bounds="[0,0][1,1]" />"""
        assertEquals(xml, HierarchyAttributes.inject(xml, emptyMap()))
        assertEquals(
            """<node bounds="[0,0][1,1]" tapsmith-role="a&quot;&lt;b" />""",
            HierarchyAttributes.inject(xml, mapOf("[0,0][1,1]" to mapOf("tapsmith-role" to "a\"<b"))),
        )
    }
}
