package dev.tapsmith.agent

/**
 * The pure decisions [ElementFinder] makes about one candidate element,
 * kept free of Android types so the host tests can pin them (PILOT-539).
 * The finder supplies each attribute from the node the tree walk captured.
 */
internal object FindRules {
    /**
     * The post-filter for trait and dual-path roles (heading, link, image,
     * searchfield, alert, combobox). A role description the app published
     * (React Native's accessibilityRole) decides the role on its own: it must
     * be one of [acceptable]. Without one, the element matches by class only
     * when the role's [classSet] is not [ambiguous] — heading and link share
     * TextView with "text", so a bare TextView is neither.
     */
    fun matchesTraitRole(
        roleDescription: String?,
        className: String?,
        acceptable: Set<String>,
        classSet: Set<String>,
        ambiguous: Boolean,
    ): Boolean =
        when {
            roleDescription != null -> roleDescription in acceptable
            !ambiguous && classSet.isNotEmpty() -> (className ?: "") in classSet
            else -> false
        }

    /**
     * The text a query reports for an element. An element with no text of
     * its own (an RN ReactViewGroup wrapping its label) reports its joined
     * [descendantText]; an EditText showing its placeholder reports none
     * (PILOT-133 — UIAutomator surfaces the hint as the text of an empty
     * field). Each lambda is read only on the branch that needs it.
     */
    fun effectiveText(
        rawText: String?,
        isShowingHint: () -> Boolean,
        descendantText: () -> String,
    ): String? =
        when {
            rawText.isNullOrEmpty() -> descendantText().ifEmpty { null }
            isShowingHint() -> null
            else -> rawText
        }

    /**
     * The text of [node]'s descendants, in tree order: each child gives its
     * [ownText] (text, else content description) or, when it has none, its
     * own descendants' text, down to [maxDepth] levels. [children] lists
     * only the children a query can see (visible to the user).
     */
    fun <N> descendantTextParts(
        node: N,
        children: (N) -> List<N>,
        ownText: (N) -> String?,
        maxDepth: Int,
        depth: Int = 0,
    ): List<String> {
        if (depth >= maxDepth) return emptyList()
        val parts = mutableListOf<String>()
        for (child in children(node)) {
            val text = ownText(child)
            if (text != null) {
                parts.add(text)
            } else {
                parts.addAll(descendantTextParts(child, children, ownText, maxDepth, depth + 1))
            }
        }
        return parts
    }
}

/** The pure part of a swipe's settle (PILOT-539), host-testable. */
internal object SwipeSettle {
    /**
     * Whether a TYPE_VIEW_SCROLLED event with these scroll deltas (API 28+;
     * -1 when the view didn't report one) moves along the swipe's axis.
     * A sideways carousel scrolling on its own must not hold a vertical
     * swipe's settle open. An unreported delta counts, so an unknown
     * scroll still holds the settle.
     */
    fun isAlongAxis(
        deltaX: Int,
        deltaY: Int,
        vertical: Boolean,
    ): Boolean = (if (vertical) deltaY else deltaX) != 0
}
