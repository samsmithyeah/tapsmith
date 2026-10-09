package dev.tapsmith.agent

/**
 * The pure parts of [HierarchyDumper]'s post-processing, kept free of Android
 * types so the host tests can pin them: the bounds a node is written with in
 * the stock UIAutomator XML (the join key), and the injection of Tapsmith's
 * extra attributes into that XML.
 */
internal object HierarchyAttributes {
    /** A rectangle as `left, top, right, bottom`. */
    data class Box(
        val left: Int,
        val top: Int,
        val right: Int,
        val bottom: Int,
    ) {
        /** The `bounds` attribute value the stock dump writes: `[l,t][r,b]`. */
        fun key(): String = "[$left,$top][$right,$bottom]"

        /**
         * This box clipped to [other], or unchanged when they do not overlap —
         * android.graphics.Rect.intersect's rule, which UIAutomator's
         * `intersectOrWarn` relies on.
         */
        fun intersectOrKeep(other: Box): Box {
            if (left >= other.right || other.left >= right || top >= other.bottom || other.top >= bottom) return this
            return Box(maxOf(left, other.left), maxOf(top, other.top), minOf(right, other.right), minOf(bottom, other.bottom))
        }
    }

    /**
     * The bounds UIAutomator's dumper writes for a node: its screen bounds
     * clipped to the display and then to its window
     * (`AccessibilityNodeInfoHelper.getVisibleBoundsInScreen(node, w, h,
     * false)` in uiautomator 2.3). Keying the join on raw screen bounds would
     * miss every node that is partly off screen or outside its window
     * (PILOT-655).
     */
    fun dumpedBounds(
        screen: Box,
        displayWidth: Int,
        displayHeight: Int,
        window: Box?,
    ): Box {
        val onDisplay = screen.intersectOrKeep(Box(0, 0, displayWidth, displayHeight))
        return if (window != null) onDisplay.intersectOrKeep(window) else onDisplay
    }

    private val NODE_BOUNDS = Regex("""(<node\b[^>]*\bbounds="(\[-?\d+,-?\d+]\[-?\d+,-?\d+])")""")

    /**
     * Inject [attributes] (bounds → name → value) into the stock XML: after
     * the `bounds` attribute of every `<node>` whose bounds have an entry.
     */
    fun inject(
        xml: String,
        attributes: Map<String, Map<String, String>>,
    ): String {
        if (attributes.isEmpty()) return xml
        val sb = StringBuilder(xml.length + attributes.size * 30)
        var lastEnd = 0
        for (match in NODE_BOUNDS.findAll(xml)) {
            sb.append(xml, lastEnd, match.range.last + 1)
            attributes[match.groupValues[2]]?.forEach { (name, value) ->
                sb.append(' ').append(name).append("=\"").append(escapeXmlAttr(value)).append('"')
            }
            lastEnd = match.range.last + 1
        }
        sb.append(xml, lastEnd, xml.length)
        return sb.toString()
    }

    private fun escapeXmlAttr(s: String): String =
        s
            .replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
}
