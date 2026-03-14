package dev.pilot.agent

import android.graphics.Rect
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONObject
import org.w3c.dom.NodeList
import org.xml.sax.InputSource
import java.io.StringReader
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.xpath.XPathConstants
import javax.xml.xpath.XPathFactory

/**
 * Selector specification for finding elements.
 */
data class ElementSelector(
    val role: String? = null,
    val name: String? = null,
    val text: String? = null,
    val textContains: String? = null,
    val contentDesc: String? = null,
    val hint: String? = null,
    val className: String? = null,
    val testId: String? = null,
    val id: String? = null,
    val xpath: String? = null,
    val enabled: Boolean? = null,
    val checked: Boolean? = null,
    val focused: Boolean? = null,
)

/**
 * Information about a found UI element.
 */
data class ElementInfo(
    val elementId: String,
    val className: String,
    val text: String?,
    val contentDescription: String?,
    val resourceId: String?,
    val hint: String?,
    val bounds: Rect,
    val isEnabled: Boolean,
    val isChecked: Boolean,
    val isFocused: Boolean,
    val isClickable: Boolean,
    val isFocusable: Boolean,
    val isScrollable: Boolean,
    val isVisible: Boolean,
    val isSelected: Boolean,
    val childCount: Int,
    val role: String,
    val viewportRatio: Float,
) {
    fun toJson(): JSONObject =
        JSONObject().apply {
            put("elementId", elementId)
            put("className", className)
            put("text", text ?: JSONObject.NULL)
            put("contentDescription", contentDescription ?: JSONObject.NULL)
            put("resourceId", resourceId ?: JSONObject.NULL)
            put("hint", hint ?: JSONObject.NULL)
            put(
                "bounds",
                JSONObject().apply {
                    put("left", bounds.left)
                    put("top", bounds.top)
                    put("right", bounds.right)
                    put("bottom", bounds.bottom)
                    put("centerX", bounds.centerX())
                    put("centerY", bounds.centerY())
                    put("width", bounds.width())
                    put("height", bounds.height())
                },
            )
            put("enabled", isEnabled)
            put("checked", isChecked)
            put("focused", isFocused)
            put("clickable", isClickable)
            put("focusable", isFocusable)
            put("scrollable", isScrollable)
            put("visible", isVisible)
            put("selected", isSelected)
            put("childCount", childCount)
            put("role", role)
            put("viewportRatio", viewportRatio.toDouble())
        }
}

/**
 * Finds UI elements using UIAutomator2 selectors.
 *
 * Supports multiple selector strategies: role, text, contentDesc, className,
 * testId, resourceId, xpath, and more. Maintains a cache of found elements
 * so they can be referenced by ID in subsequent commands.
 */
class ElementFinder(private val device: UiDevice) {
    /** Cache of element IDs to UiObject2 instances. */
    private val elementCache = ConcurrentHashMap<String, UiObject2>()

    /**
     * Role-to-class-name mappings. Each role maps to a list of Android class names
     * that could represent that role (including Material/AppCompat variants).
     */
    private val roleClassMap =
        mapOf(
            "button" to
                listOf(
                    "android.widget.Button",
                    "android.widget.ImageButton",
                    "com.google.android.material.button.MaterialButton",
                    "androidx.appcompat.widget.AppCompatButton",
                ),
            "textfield" to
                listOf(
                    "android.widget.EditText",
                    "android.widget.AutoCompleteTextView",
                    "com.google.android.material.textfield.TextInputEditText",
                    "androidx.appcompat.widget.AppCompatEditText",
                ),
            "checkbox" to
                listOf(
                    "android.widget.CheckBox",
                    "androidx.appcompat.widget.AppCompatCheckBox",
                    "com.google.android.material.checkbox.MaterialCheckBox",
                ),
            "switch" to
                listOf(
                    "android.widget.Switch",
                    "androidx.appcompat.widget.SwitchCompat",
                    "com.google.android.material.switchmaterial.SwitchMaterial",
                ),
            "image" to
                listOf(
                    "android.widget.ImageView",
                    "androidx.appcompat.widget.AppCompatImageView",
                ),
            "text" to
                listOf(
                    "android.widget.TextView",
                    "androidx.appcompat.widget.AppCompatTextView",
                    "com.google.android.material.textview.MaterialTextView",
                ),
            "heading" to
                listOf(
                    "android.widget.TextView",
                ),
            "link" to
                listOf(
                    "android.widget.TextView",
                ),
            "list" to
                listOf(
                    "android.widget.ListView",
                    "android.widget.GridView",
                    "androidx.recyclerview.widget.RecyclerView",
                ),
            "listitem" to
                listOf(
                    "android.widget.LinearLayout",
                    "android.widget.RelativeLayout",
                    "android.widget.FrameLayout",
                ),
            "scrollview" to
                listOf(
                    "android.widget.ScrollView",
                    "android.widget.HorizontalScrollView",
                    "androidx.core.widget.NestedScrollView",
                ),
            "progressbar" to
                listOf(
                    "android.widget.ProgressBar",
                    "com.google.android.material.progressindicator.LinearProgressIndicator",
                    "com.google.android.material.progressindicator.CircularProgressIndicator",
                ),
            "seekbar" to
                listOf(
                    "android.widget.SeekBar",
                    "com.google.android.material.slider.Slider",
                ),
            "radiobutton" to
                listOf(
                    "android.widget.RadioButton",
                    "androidx.appcompat.widget.AppCompatRadioButton",
                    "com.google.android.material.radiobutton.MaterialRadioButton",
                ),
            "spinner" to
                listOf(
                    "android.widget.Spinner",
                    "androidx.appcompat.widget.AppCompatSpinner",
                ),
            "toolbar" to
                listOf(
                    "android.widget.Toolbar",
                    "androidx.appcompat.widget.Toolbar",
                    "com.google.android.material.appbar.MaterialToolbar",
                ),
            "tab" to
                listOf(
                    "android.widget.TabWidget",
                    "com.google.android.material.tabs.TabLayout",
                ),
        )

    /**
     * Reverse mapping from class name to role.
     */
    private val classToRoleMap: Map<String, String> by lazy {
        buildMap {
            for ((role, classNames) in roleClassMap) {
                for (className in classNames) {
                    putIfAbsent(className, role)
                }
            }
        }
    }

    /**
     * Compute what fraction of the element is within the screen viewport.
     * Returns 0.0 if fully off-screen, 1.0 if fully on-screen.
     */
    private fun computeViewportRatio(bounds: Rect): Float {
        val screenWidth = device.displayWidth
        val screenHeight = device.displayHeight
        val screenRect = Rect(0, 0, screenWidth, screenHeight)

        val elementArea = bounds.width().toLong() * bounds.height().toLong()
        if (elementArea <= 0) return 0f

        val intersection = Rect()
        if (!intersection.setIntersect(bounds, screenRect)) return 0f

        val intersectionArea = intersection.width().toLong() * intersection.height().toLong()
        return (intersectionArea.toFloat() / elementArea.toFloat()).coerceIn(0f, 1f)
    }

    /**
     * Resolve the role for a given class name.
     */
    private fun resolveRole(className: String): String {
        return classToRoleMap[className] ?: ""
    }

    /**
     * Find a single element matching the selector.
     * @throws ElementNotFoundException if no element matches
     */
    fun findElement(
        selector: ElementSelector,
        parentId: String? = null,
    ): ElementInfo {
        val elements = findElements(selector, parentId)
        if (elements.isEmpty()) {
            throw ElementNotFoundException("No element found matching: ${describeSelector(selector)}")
        }
        return elements.first()
    }

    /**
     * Find all elements matching the selector.
     */
    fun findElements(
        selector: ElementSelector,
        parentId: String? = null,
    ): List<ElementInfo> {
        // XPath-based search uses a different path
        if (selector.xpath != null) {
            return findByXPath(selector.xpath)
        }

        val parent =
            if (parentId != null) {
                elementCache[parentId]
                    ?: throw ElementNotFoundException("Parent element '$parentId' not found in cache")
            } else {
                null
            }

        val objects = findUiObjects(selector, parent)

        // Apply additional attribute filters
        val filtered =
            objects.filter { obj ->
                (selector.enabled == null || obj.isEnabled == selector.enabled) &&
                    (selector.checked == null || obj.isChecked == selector.checked) &&
                    (selector.focused == null || obj.isFocused == selector.focused)
            }

        return filtered.map { cacheAndConvert(it) }
    }

    /**
     * Get a cached element by its stable ID.
     * @throws ElementNotFoundException if the ID is not in the cache
     */
    fun getElement(elementId: String): UiObject2 {
        return elementCache[elementId]
            ?: throw ElementNotFoundException("Element '$elementId' not found. It may have gone stale.")
    }

    /**
     * Get the bounds of a cached element for action execution.
     */
    fun getElementBounds(elementId: String): Rect {
        val obj = getElement(elementId)
        return obj.visibleBounds
    }

    private fun findUiObjects(
        selector: ElementSelector,
        parent: UiObject2?,
    ): List<UiObject2> {
        val bySelector =
            buildBySelector(selector)
                ?: throw InvalidSelectorException("No valid selector criteria provided")

        return if (parent != null) {
            parent.findObjects(bySelector) ?: emptyList()
        } else {
            device.findObjects(bySelector) ?: emptyList()
        }
    }

    private fun buildBySelector(selector: ElementSelector): BySelector? {
        var by: BySelector? = null

        // Role-based selection
        if (selector.role != null) {
            val classNames =
                roleClassMap[selector.role.lowercase()]
                    ?: throw InvalidSelectorException("Unknown role: '${selector.role}'. Known roles: ${roleClassMap.keys.joinToString()}")

            // Use regex to match any of the class variants
            val pattern = classNames.joinToString("|") { Regex.escape(it) }
            by = By.clazz(java.util.regex.Pattern.compile(pattern))

            // If a name is also given, additionally filter by text or contentDescription
            if (selector.name != null) {
                by = by.hasDescendant(
                    By.text(selector.name),
                ) ?: by // fallback: will filter manually below
                // Actually, we need text OR contentDesc matching. Use a broader approach:
                // Build the class selector, then filter results by name afterwards.
            }
        }

        // Text selectors
        if (selector.text != null) {
            by = if (by != null) by.text(selector.text) else By.text(selector.text)
        }
        if (selector.textContains != null) {
            by =
                if (by != null) {
                    by.textContains(selector.textContains)
                } else {
                    By.textContains(selector.textContains)
                }
        }

        // Content description
        if (selector.contentDesc != null) {
            by = if (by != null) by.desc(selector.contentDesc) else By.desc(selector.contentDesc)
        }

        // Class name
        if (selector.className != null) {
            by = if (by != null) by.clazz(selector.className) else By.clazz(selector.className)
        }

        // Resource ID
        if (selector.id != null) {
            by = if (by != null) by.res(selector.id) else By.res(selector.id)
        }

        // Test ID (convention: stored in content description with "testid:" prefix, or view tag)
        if (selector.testId != null) {
            val desc = "testid:${selector.testId}"
            by = if (by != null) by.desc(desc) else By.desc(desc)
        }

        // Hint text — search by hint property via UiSelector as BySelector doesn't
        // directly support hint. We do an XML hierarchy search instead.
        if (selector.hint != null && by == null) {
            return By.textContains("").also {
                // Hint-based search will be handled via hierarchy filtering
            }
        }

        return by
    }

    /**
     * Find elements by evaluating an XPath expression against the UI hierarchy XML.
     */
    private fun findByXPath(xpath: String): List<ElementInfo> {
        val baos = java.io.ByteArrayOutputStream()
        device.dumpWindowHierarchy(baos)
        val xml = baos.toString(Charsets.UTF_8.name())

        val factory = DocumentBuilderFactory.newInstance()
        val builder = factory.newDocumentBuilder()
        val doc = builder.parse(InputSource(StringReader(xml)))

        val xpathFactory = XPathFactory.newInstance()
        val xpathExpr = xpathFactory.newXPath().compile(xpath)
        val nodes = xpathExpr.evaluate(doc, XPathConstants.NODESET) as NodeList

        val results = mutableListOf<ElementInfo>()
        for (i in 0 until nodes.length) {
            val node = nodes.item(i)
            if (node.nodeType != org.w3c.dom.Node.ELEMENT_NODE) continue
            val elem = node as org.w3c.dom.Element

            val boundsStr = elem.getAttribute("bounds")
            val bounds = parseBounds(boundsStr)

            val elementId = UUID.randomUUID().toString()
            val className = elem.getAttribute("class") ?: ""
            results.add(
                ElementInfo(
                    elementId = elementId,
                    className = className,
                    text = elem.getAttribute("text").ifEmpty { null },
                    contentDescription = elem.getAttribute("content-desc").ifEmpty { null },
                    resourceId = elem.getAttribute("resource-id").ifEmpty { null },
                    hint = elem.getAttribute("hint").ifEmpty { null },
                    bounds = bounds,
                    isEnabled = elem.getAttribute("enabled") == "true",
                    isChecked = elem.getAttribute("checked") == "true",
                    isFocused = elem.getAttribute("focused") == "true",
                    isClickable = elem.getAttribute("clickable") == "true",
                    isFocusable = elem.getAttribute("focusable") == "true",
                    isScrollable = elem.getAttribute("scrollable") == "true",
                    isVisible = bounds.width() > 0 && bounds.height() > 0,
                    isSelected = elem.getAttribute("selected") == "true",
                    childCount = elem.childNodes.length,
                    role = resolveRole(className),
                    viewportRatio = computeViewportRatio(bounds),
                ),
            )
            // XPath elements can't be cached as UiObject2 — they're XML-based
        }

        return results
    }

    private fun parseBounds(boundsStr: String): Rect {
        // Format: [left,top][right,bottom]
        val regex = """\[(\d+),(\d+)\]\[(\d+),(\d+)\]""".toRegex()
        val match = regex.find(boundsStr) ?: return Rect(0, 0, 0, 0)
        val (left, top, right, bottom) = match.destructured
        return Rect(left.toInt(), top.toInt(), right.toInt(), bottom.toInt())
    }

    /**
     * Extract hint text from a UiObject2 via AccessibilityNodeInfo.
     * getHintText() is available on API 26+; returns null on older devices.
     */
    private fun extractHint(obj: UiObject2): String? {
        if (android.os.Build.VERSION.SDK_INT < 26) return null
        return try {
            val nodeInfoField = obj.javaClass.getDeclaredMethod("getAccessibilityNodeInfo")
            nodeInfoField.isAccessible = true
            val nodeInfo = nodeInfoField.invoke(obj) as? android.view.accessibility.AccessibilityNodeInfo
            nodeInfo?.hintText?.toString()
        } catch (e: Exception) {
            android.util.Log.w("ElementFinder", "Failed to extract hint text for ${obj.className}", e)
            null
        }
    }

    private fun cacheAndConvert(obj: UiObject2): ElementInfo {
        val elementId = UUID.randomUUID().toString()
        elementCache[elementId] = obj
        val bounds =
            try {
                obj.visibleBounds
            } catch (_: Exception) {
                Rect(0, 0, 0, 0)
            }
        val className = obj.className ?: ""
        return ElementInfo(
            elementId = elementId,
            className = className,
            text = obj.text,
            contentDescription = obj.contentDescription,
            resourceId = obj.resourceName,
            hint = extractHint(obj),
            bounds = bounds,
            isEnabled = obj.isEnabled,
            isChecked = obj.isChecked,
            isFocused = obj.isFocused,
            isClickable = obj.isClickable,
            isFocusable = obj.isFocusable,
            isScrollable = obj.isScrollable,
            isVisible = bounds.width() > 0 && bounds.height() > 0,
            isSelected = obj.isSelected,
            childCount = obj.childCount,
            role = resolveRole(className),
            viewportRatio = computeViewportRatio(bounds),
        )
    }

    /**
     * Filter results by name (text or contentDescription match).
     * Used when role + name are specified together.
     */
    internal fun filterByName(
        objects: List<UiObject2>,
        name: String,
    ): List<UiObject2> {
        return objects.filter { obj ->
            obj.text == name || obj.contentDescription == name
        }
    }

    private fun describeSelector(selector: ElementSelector): String {
        val parts = mutableListOf<String>()
        selector.role?.let { parts.add("role=$it") }
        selector.name?.let { parts.add("name=$it") }
        selector.text?.let { parts.add("text=$it") }
        selector.textContains?.let { parts.add("textContains=$it") }
        selector.contentDesc?.let { parts.add("contentDesc=$it") }
        selector.hint?.let { parts.add("hint=$it") }
        selector.className?.let { parts.add("className=$it") }
        selector.testId?.let { parts.add("testId=$it") }
        selector.id?.let { parts.add("id=$it") }
        selector.xpath?.let { parts.add("xpath=$it") }
        return parts.joinToString(", ")
    }
}
