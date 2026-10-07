package dev.tapsmith.agent

import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.uiautomator.UiObject2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host-side tests for the decisions the snapshot-based finder makes
 * (PILOT-539). They pin the matching semantics the finder had when it read
 * every attribute through live UiObject2 getters, so reading the tree-walk
 * snapshot instead changes the cost of a query, not its answer.
 */
class FindRulesTest {
    // ─── Trait / dual-path roles ───

    private val textViewSet = setOf("android.widget.TextView")
    private val imageSet = setOf("android.widget.ImageView", "androidx.appcompat.widget.AppCompatImageView")

    @Test
    fun `a published role description decides the role, whatever the class`() {
        assertTrue(FindRules.matchesTraitRole("heading", "android.view.ViewGroup", setOf("heading", "header"), textViewSet, true))
        assertTrue(FindRules.matchesTraitRole("header", "android.view.ViewGroup", setOf("heading", "header"), textViewSet, true))
        // A role description wins over a matching class: an ImageView an RN
        // app calls a "button" is not an image.
        assertFalse(FindRules.matchesTraitRole("button", "android.widget.ImageView", setOf("image"), imageSet, false))
    }

    @Test
    fun `without a role description, only an unambiguous class set matches by class`() {
        assertTrue(FindRules.matchesTraitRole(null, "android.widget.ImageView", setOf("image"), imageSet, false))
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.Button", setOf("image"), imageSet, false))
        // heading/link share TextView with "text", so a bare TextView is neither.
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.TextView", setOf("heading", "header"), textViewSet, true))
        // Trait-only roles have no class set at all.
        assertFalse(FindRules.matchesTraitRole(null, "android.widget.TextView", setOf("alert"), emptySet(), false))
        assertFalse(FindRules.matchesTraitRole(null, null, setOf("image"), imageSet, false))
    }

    // ─── Effective text ───

    @Test
    fun `own text is the value unless the field is showing its hint`() {
        assertEquals("typed", FindRules.effectiveText("typed", { false }, { "child" }))
        assertNull(FindRules.effectiveText("Email", { true }, { "child" }))
    }

    @Test
    fun `empty own text falls back to descendant text, and never reads the hint flag`() {
        val noHintRead = { throw AssertionError("hint flag read for an element with no own text") }
        assertEquals("Welcome to Expo", FindRules.effectiveText(null, noHintRead, { "Welcome to Expo" }))
        assertEquals("joined", FindRules.effectiveText("", noHintRead, { "joined" }))
        assertNull(FindRules.effectiveText(null, noHintRead, { "" }))
    }

    @Test
    fun `descendant text is only read when own text is empty`() {
        val noDescendants = { throw AssertionError("descendant text read for an element with own text") }
        assertEquals("own", FindRules.effectiveText("own", { false }, noDescendants))
    }

    // ─── Descendant text ───

    private class Node(
        val text: String? = null,
        val desc: String? = null,
        val visible: Boolean = true,
        val children: List<Node> = emptyList(),
    )

    private fun parts(
        root: Node,
        maxDepth: Int = 6,
    ) = FindRules.descendantTextParts(
        root,
        children = { n -> n.children.filter { it.visible } },
        ownText = { n -> n.text?.takeIf { it.isNotEmpty() } ?: n.desc?.takeIf { it.isNotEmpty() } },
        maxDepth = maxDepth,
    )

    @Test
    fun `each child contributes its text, else its description, else its own descendants`() {
        val root =
            Node(
                children =
                    listOf(
                        Node(text = "Hello", desc = "ignored when text is present"),
                        Node(text = "", desc = "Icon"),
                        Node(children = listOf(Node(text = "nested"), Node(desc = "deep desc"))),
                    ),
            )
        assertEquals(listOf("Hello", "Icon", "nested", "deep desc"), parts(root))
    }

    @Test
    fun `a child with text does not contribute its descendants`() {
        val root = Node(children = listOf(Node(text = "Row", children = listOf(Node(text = "inner")))))
        assertEquals(listOf("Row"), parts(root))
    }

    @Test
    fun `invisible children are skipped with their whole subtree`() {
        val root =
            Node(
                children =
                    listOf(
                        Node(text = "shown"),
                        Node(visible = false, text = "hidden"),
                        Node(visible = false, children = listOf(Node(text = "hidden child"))),
                    ),
            )
        assertEquals(listOf("shown"), parts(root))
    }

    @Test
    fun `recursion stops at the depth cap`() {
        // root -> d1 -> d2 -> leaf(text): the leaf is read while expanding
        // d2, at depth 2, so a cap of 3 reaches it and a cap of 2 does not.
        val root = Node(children = listOf(Node(children = listOf(Node(children = listOf(Node(text = "leaf")))))))
        assertEquals(listOf("leaf"), parts(root, maxDepth = 3))
        assertEquals(emptyList<String>(), parts(root, maxDepth = 2))
    }

    // ─── Reflection contract ───

    /**
     * The finder reads UiObject2's tree-walk node without refreshing it and
     * clips its bounds with UiObject2's own visible-bounds rule. Both are
     * private members of the uiautomator version this APK bundles; this test
     * fails the build when a uiautomator bump renames them, instead of every
     * query silently falling back to (or failing on) live reads.
     */
    @Test
    fun `the bundled uiautomator exposes the members the snapshot reader uses`() {
        val field = UiObject2::class.java.getDeclaredField(ElementFinder.CACHED_NODE_FIELD)
        assertEquals(AccessibilityNodeInfo::class.java, field.type)
        val method =
            UiObject2::class.java.getDeclaredMethod(
                ElementFinder.VISIBLE_BOUNDS_METHOD,
                AccessibilityNodeInfo::class.java,
            )
        assertEquals(android.graphics.Rect::class.java, method.returnType)
    }
}
