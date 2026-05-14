package dev.tapsmith.agent

import android.app.Instrumentation
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.uiautomator.UiDevice
import java.io.ByteArrayOutputStream

/**
 * Dumps the current UI hierarchy from UIAutomator as an XML string.
 *
 * The hierarchy includes all visible windows and their element trees,
 * with properties such as class, text, content-desc, resource-id, bounds,
 * enabled, checked, focused, clickable, scrollable, and more.
 *
 * Post-processes the stock UIAutomator XML to inject `tapsmith-role`
 * attributes for elements with trait-based roles (heading, alert, link,
 * combobox, etc.) that React Native surfaces via AccessibilityNodeInfo
 * bundle extras but the stock dump doesn't include.
 */
class HierarchyDumper(
    private val device: UiDevice,
    private val instrumentation: Instrumentation,
) {
    companion object {
        private const val TAG = "TapsmithHierarchy"

        private const val ROLE_DESCRIPTION_EXTRA_KEY =
            "AccessibilityNodeInfo.roleDescription"
        private const val ROLE_DESCRIPTION_LONG_FORM_KEY =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.ROLE_DESCRIPTION_KEY"
        private const val COMPAT_BOOLEAN_PROPERTY_KEY =
            "androidx.view.accessibility.AccessibilityNodeInfoCompat.BOOLEAN_PROPERTY_KEY"
        private const val COMPAT_BOOLEAN_PROPERTY_IS_HEADING = 0x2
    }

    /**
     * Dump the full UI hierarchy as an XML string, augmented with
     * `tapsmith-role` attributes for trait-based roles.
     *
     * @return XML string representing the current UI hierarchy
     * @throws ActionFailedException if the hierarchy cannot be dumped
     */
    fun dump(): String {
        return try {
            val outputStream = ByteArrayOutputStream()
            device.dumpWindowHierarchy(outputStream)
            val xml = outputStream.toString(Charsets.UTF_8.name())
            if (xml.isBlank()) {
                throw ActionFailedException("UI hierarchy dump returned empty result")
            }
            injectRoles(xml)
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Failed to dump UI hierarchy", e)
            throw ActionFailedException("Failed to dump UI hierarchy: ${e.message}")
        }
    }

    /**
     * Walk the AccessibilityNodeInfo tree to collect trait-based roles,
     * then inject `tapsmith-role` attributes into the stock UIAutomator XML.
     */
    private fun injectRoles(xml: String): String {
        val roleMap = collectRoleMap()
        if (roleMap.isEmpty()) return xml

        val sb = StringBuilder(xml.length + roleMap.size * 30)
        // Match <node ... bounds="[l,t][r,b]" and inject tapsmith-role before
        // the closing > or /> of each element that has a role.
        val boundsRe = Regex("""(<node\b[^>]*\bbounds="(\[\d+,\d+]\[\d+,\d+])")""")
        var lastEnd = 0
        for (match in boundsRe.findAll(xml)) {
            val bounds = match.groupValues[2]
            val role = roleMap[bounds]
            sb.append(xml, lastEnd, match.range.last + 1)
            if (role != null) {
                sb.append(" tapsmith-role=\"")
                sb.append(escapeXmlAttr(role))
                sb.append('"')
            }
            lastEnd = match.range.last + 1
        }
        sb.append(xml, lastEnd, xml.length)
        return sb.toString()
    }

    /**
     * Walk all accessibility windows and build a map of bounds → role
     * for nodes that have a trait-based role not derivable from the class name.
     *
     * Limitation: uses bounds as the join key between the AccessibilityNodeInfo
     * tree and the UIAutomator XML. If two elements share identical bounds
     * (overlapping views, zero-size elements), only one role survives. This is
     * acceptable in practice since trait-based roles are uncommon and
     * overlapping elements with *different* trait roles are rarer still.
     */
    private fun collectRoleMap(): Map<String, String> {
        val roleMap = mutableMapOf<String, String>()
        try {
            val automation = instrumentation.uiAutomation
            for (window in automation.windows) {
                try {
                    val root = window.root ?: continue
                    try {
                        walkNodeInfo(root, roleMap)
                    } finally {
                        @Suppress("DEPRECATION")
                        root.recycle()
                    }
                } finally {
                    @Suppress("DEPRECATION")
                    window.recycle()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to collect roles from accessibility tree", e)
        }
        return roleMap
    }

    @Suppress("DEPRECATION")
    private fun walkNodeInfo(
        node: AccessibilityNodeInfo,
        roleMap: MutableMap<String, String>,
    ) {
        val role = extractRoleFromNodeInfo(node)
        if (role != null) {
            val rect = Rect()
            node.getBoundsInScreen(rect)
            val bounds = "[${rect.left},${rect.top}][${rect.right},${rect.bottom}]"
            roleMap[bounds] = role
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            walkNodeInfo(child, roleMap)
            child.recycle()
        }
    }

    /**
     * Extract a trait-based role from an AccessibilityNodeInfo. Same logic
     * as ElementFinder.extractRoleDescription but operates on the node
     * directly without needing a UiObject2 wrapper.
     */
    private fun extractRoleFromNodeInfo(node: AccessibilityNodeInfo): String? {
        try {
            if (Build.VERSION.SDK_INT >= 28 && node.isHeading) {
                return "heading"
            }
            val extras = node.extras ?: return null
            val packed = extras.getInt(COMPAT_BOOLEAN_PROPERTY_KEY, 0)
            if ((packed and COMPAT_BOOLEAN_PROPERTY_IS_HEADING) != 0) {
                return "heading"
            }
            val raw =
                extras.getCharSequence(ROLE_DESCRIPTION_EXTRA_KEY)?.toString()
                    ?: extras.getCharSequence(ROLE_DESCRIPTION_LONG_FORM_KEY)?.toString()
            return raw?.takeIf { it.isNotEmpty() }?.lowercase()
        } catch (e: Exception) {
            return null
        }
    }

    private fun escapeXmlAttr(s: String): String {
        return s.replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
    }
}
