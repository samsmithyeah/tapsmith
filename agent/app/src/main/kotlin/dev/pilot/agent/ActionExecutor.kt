package dev.pilot.agent

import android.view.KeyEvent
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until

/**
 * Executes UI actions: tap, long press, text input, swipe, scroll, and key presses.
 */
class ActionExecutor(private val device: UiDevice) {
    companion object {
        /** Interval between taps for double-tap gesture. */
        private const val DOUBLE_TAP_INTERVAL_MS = 40L

        /** Timeout for waiting for dropdown options to appear. */
        private const val DROPDOWN_WAIT_TIMEOUT_MS = 3000L

        /** Fallback timeout for scrollable container detection. */
        private const val SCROLLABLE_FALLBACK_TIMEOUT_MS = 1000L

        /** Minimum pixel margin for tapping outside an element during blur. */
        private const val BLUR_TAP_MARGIN_PX = 50

        /** Time to wait for idle after focus/blur actions. */
        private const val FOCUS_IDLE_TIMEOUT_MS = 500L
    }

    /**
     * Tap on an element's center point.
     */
    fun tap(element: UiObject2) {
        try {
            element.click()
        } catch (e: Exception) {
            throw ActionFailedException("Failed to tap element: ${e.message}")
        }
    }

    /**
     * Tap at specific screen coordinates.
     */
    fun tapCoordinates(
        x: Int,
        y: Int,
    ) {
        if (!device.click(x, y)) {
            throw ActionFailedException("Failed to tap at ($x, $y)")
        }
    }

    /**
     * Long press on an element with configurable duration.
     */
    fun longPress(
        element: UiObject2,
        durationMs: Long = 1000L,
    ) {
        try {
            val bounds = element.visibleBounds
            val cx = bounds.centerX()
            val cy = bounds.centerY()
            device.swipe(cx, cy, cx, cy, (durationMs / 5).toInt().coerceAtLeast(1))
        } catch (e: Exception) {
            throw ActionFailedException("Failed to long press element: ${e.message}")
        }
    }

    /**
     * Long press at specific coordinates.
     */
    fun longPressCoordinates(
        x: Int,
        y: Int,
        durationMs: Long = 1000L,
    ) {
        // swipe from point to same point with steps proportional to duration
        device.swipe(x, y, x, y, (durationMs / 5).toInt().coerceAtLeast(1))
    }

    /**
     * Type text into a focused element.
     * First clicks the element to ensure focus, then types the text.
     */
    fun typeText(
        element: UiObject2,
        text: String,
    ) {
        try {
            element.click()
            // Small delay to ensure focus is established
            element.text = text
        } catch (e: Exception) {
            // Fallback: try clicking and using device-level text injection
            try {
                element.click()
                device.waitForIdle(1000)
                typeTextWithoutFocus(text)
            } catch (e2: Exception) {
                throw ActionFailedException("Failed to type text: ${e.message}")
            }
        }
    }

    /**
     * Type text without targeting a specific element.
     *
     * Uses `input text` for printable runs and `input keyevent` for control
     * characters (`\n`, `\t`, `\b`, `\r`) so those reach the focused field
     * instead of being silently dropped by the shell-tokenizer.
     *
     * IMPORTANT: do NOT add literal quotes around the text —
     * UiDevice.executeShellCommand does NOT route through a shell. The
     * command string is split on whitespace and each token is passed
     * verbatim to `input`, so quote characters end up typed into the field
     * (PILOT-133). Spaces inside a printable run are converted to `%s`,
     * which `input text` interprets as a literal space.
     *
     * KNOWN LIMITATION: a literal `%s` substring in `text` is indistinguishable
     * from an encoded space and will type a space instead. Real-world test
     * data rarely includes `%s`, but if you need to type that exact pair,
     * use `pressKey()` or break the input up.
     */
    fun typeTextWithoutFocus(text: String) {
        if (text.isEmpty()) return
        val buffer = StringBuilder()
        for (ch in text) {
            val keyCode =
                when (ch) {
                    '\n' -> "KEYCODE_ENTER"
                    '\t' -> "KEYCODE_TAB"
                    '\b' -> "KEYCODE_DEL" // '\b' is U+0008 (backspace)
                    // Drop CR — Android keyboards send '\n' for the
                    // Enter key; '\r' alone has no useful target and
                    // would emit an extra keyevent in CRLF input.
                    '\r' -> null
                    else -> ""
                }
            if (keyCode == null) continue
            if (keyCode.isNotEmpty()) {
                if (buffer.isNotEmpty()) {
                    flushPrintableRun(buffer)
                }
                device.executeShellCommand("input keyevent $keyCode")
            } else if (ch.code < 0x20) {
                // Drop other ASCII control codes (NUL, BEL, vertical tab, etc.).
                // `input text` would garble them; routing each to a key event
                // is not generally meaningful. Specific cases (\n, \t, \b)
                // are handled above.
                continue
            } else {
                buffer.append(ch)
            }
        }
        if (buffer.isNotEmpty()) {
            flushPrintableRun(buffer)
        }
    }

    private fun flushPrintableRun(buffer: StringBuilder) {
        if (buffer.isEmpty()) return
        val tokenized = buffer.toString().replace(" ", "%s")
        device.executeShellCommand("input text $tokenized")
        buffer.setLength(0)
    }

    /**
     * Clear text in an element by selecting all and deleting.
     */
    fun clearText(element: UiObject2) {
        try {
            element.click()
            device.waitForIdle(500)
            // Select all (Ctrl+A) then delete
            element.clear()
        } catch (e: Exception) {
            // Fallback: triple-click to select all, then press delete
            try {
                element.click()
                device.waitForIdle(200)
                // Use shell to select all and delete
                device.executeShellCommand("input keyevent KEYCODE_MOVE_HOME")
                device.executeShellCommand("input keyevent --longpress KEYCODE_SHIFT_LEFT KEYCODE_MOVE_END")
                device.executeShellCommand("input keyevent KEYCODE_DEL")
            } catch (e2: Exception) {
                throw ActionFailedException("Failed to clear text: ${e.message}")
            }
        }
    }

    /**
     * Swipe on an element in a given direction.
     *
     * @param element The element to swipe on
     * @param direction One of "up", "down", "left", "right"
     * @param speed Swipe speed in pixels per second
     * @param distance Fraction of the element's dimension to swipe (0.0 to 1.0)
     */
    fun swipe(
        element: UiObject2,
        direction: String,
        speed: Int = 5000,
        distance: Double = 0.5,
    ) {
        val dir = parseDirection(direction)
        try {
            element.swipe(dir, distance.toFloat(), speed)
        } catch (e: Exception) {
            throw ActionFailedException("Failed to swipe $direction on element: ${e.message}")
        }
    }

    /**
     * Swipe on the full screen in a given direction.
     */
    fun swipeScreen(
        direction: String,
        speed: Int = 5000,
        distance: Double = 0.5,
    ) {
        val w = device.displayWidth
        val h = device.displayHeight
        val cx = w / 2
        val cy = h / 2
        val swipeLength: Int

        val steps = (speed / 100).coerceIn(5, 100)

        when (direction.lowercase()) {
            "up" -> {
                swipeLength = (h * distance).toInt()
                device.swipe(cx, cy + swipeLength / 2, cx, cy - swipeLength / 2, steps)
            }
            "down" -> {
                swipeLength = (h * distance).toInt()
                device.swipe(cx, cy - swipeLength / 2, cx, cy + swipeLength / 2, steps)
            }
            "left" -> {
                swipeLength = (w * distance).toInt()
                device.swipe(cx + swipeLength / 2, cy, cx - swipeLength / 2, cy, steps)
            }
            "right" -> {
                swipeLength = (w * distance).toInt()
                device.swipe(cx - swipeLength / 2, cy, cx + swipeLength / 2, cy, steps)
            }
            else -> throw ActionFailedException("Unknown swipe direction: $direction. Use up/down/left/right.")
        }
    }

    /**
     * Scroll a container in a direction, optionally until a target element becomes visible.
     */
    fun scroll(
        element: UiObject2,
        direction: String,
        targetSelector: ElementSelector? = null,
    ) {
        val dir = parseDirection(direction)
        if (targetSelector != null) {
            scrollUntilVisible(element, dir, targetSelector)
        } else {
            try {
                element.scroll(dir, 1.0f)
            } catch (e: Exception) {
                throw ActionFailedException("Failed to scroll $direction: ${e.message}")
            }
        }
    }

    /**
     * Scroll the full screen.
     */
    fun scrollScreen(
        direction: String,
        targetSelector: ElementSelector? = null,
    ) {
        // For full-screen scrolling, use swipe gestures
        swipeScreen(
            // Invert direction: scrolling "down" means swiping "up"
            direction =
                when (direction.lowercase()) {
                    "down" -> "up"
                    "up" -> "down"
                    "left" -> "right"
                    "right" -> "left"
                    else -> direction
                },
            speed = 5000,
            distance = 0.6,
        )
    }

    /**
     * Scroll a container until a target element matching the selector becomes visible.
     */
    private fun scrollUntilVisible(
        container: UiObject2,
        direction: Direction,
        targetSelector: ElementSelector,
        maxScrolls: Int = 20,
    ) {
        for (i in 0 until maxScrolls) {
            // Check if target is already visible
            val targetBy =
                when {
                    targetSelector.text != null -> By.text(targetSelector.text)
                    targetSelector.textContains != null -> By.textContains(targetSelector.textContains)
                    targetSelector.contentDesc != null -> By.desc(targetSelector.contentDesc)
                    targetSelector.id != null -> By.res(targetSelector.id)
                    else -> throw InvalidSelectorException("scrollTo requires text, textContains, contentDesc, or id")
                }

            val found = container.findObject(targetBy)
            if (found != null) return

            val canScroll = container.scroll(direction, 0.8f)
            if (!canScroll) {
                throw ElementNotFoundException(
                    "Could not find target element after scrolling to the end. " +
                        "Selector: ${targetSelector.text ?: targetSelector.textContains
                            ?: targetSelector.contentDesc ?: targetSelector.id}",
                )
            }
            device.waitForIdle(500)
        }
        throw TimeoutException("Could not find target element after $maxScrolls scrolls")
    }

    /**
     * Send a key press event.
     */
    fun pressKey(key: String) {
        val keyCode = resolveKeyCode(key)
        if (!device.pressKeyCode(keyCode)) {
            throw ActionFailedException("Failed to press key: $key")
        }
    }

    private fun parseDirection(direction: String): Direction {
        return when (direction.lowercase()) {
            "up" -> Direction.UP
            "down" -> Direction.DOWN
            "left" -> Direction.LEFT
            "right" -> Direction.RIGHT
            else -> throw ActionFailedException("Unknown direction: $direction. Use up/down/left/right.")
        }
    }

    /**
     * Double-tap on an element's center point.
     */
    fun doubleTap(element: UiObject2) {
        try {
            // Perform two rapid taps at the element's center.
            // We use device.click() with a short interval to ensure the gesture
            // is recognized as a double-tap by the target app.
            val bounds = element.visibleBounds
            val cx = bounds.centerX()
            val cy = bounds.centerY()
            device.click(cx, cy)
            Thread.sleep(DOUBLE_TAP_INTERVAL_MS)
            device.click(cx, cy)
        } catch (e: Exception) {
            throw ActionFailedException("Failed to double tap element: ${e.message}")
        }
    }

    /**
     * Drag from one element to another.
     */
    fun dragTo(
        source: UiObject2,
        target: UiObject2,
    ) {
        try {
            val tgtBounds = target.visibleBounds
            source.drag(android.graphics.Point(tgtBounds.centerX(), tgtBounds.centerY()))
        } catch (e: Exception) {
            throw ActionFailedException("Failed to drag element: ${e.message}")
        }
    }

    /**
     * Select an option from a spinner/dropdown by text.
     */
    fun selectOption(
        element: UiObject2,
        optionText: String,
    ) {
        try {
            // Tap the spinner to open it
            element.click()
            // Wait for the option to appear then tap it
            val option =
                device.wait(Until.findObject(By.text(optionText)), DROPDOWN_WAIT_TIMEOUT_MS)
                    ?: throw ElementNotFoundException("Option '$optionText' not found in dropdown")
            option.click()
        } catch (e: ElementNotFoundException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to select option '$optionText': ${e.message}")
        }
    }

    /**
     * Select an option from a spinner/dropdown by index.
     */
    fun selectOptionByIndex(
        element: UiObject2,
        index: Int,
    ) {
        try {
            // Tap the spinner to open it
            element.click()
            // Wait for a common dropdown container to appear
            val popupSelector = By.clazz(java.util.regex.Pattern.compile(".*(ListView|RecyclerView|PopupWindow)$"))
            val popup =
                device.wait(Until.findObject(popupSelector), DROPDOWN_WAIT_TIMEOUT_MS)
                    ?: device.wait(Until.findObject(By.scrollable(true)), SCROLLABLE_FALLBACK_TIMEOUT_MS)
                    ?: throw ActionFailedException(
                        "Could not find dropdown popup. " +
                            "The spinner may use a custom popup that is not auto-detected.",
                    )
            val children = popup.children
            if (index < 0 || index >= children.size) {
                throw ActionFailedException("Index $index out of range (0..${children.size - 1})")
            }
            children[index].click()
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: Exception) {
            throw ActionFailedException("Failed to select option at index $index: ${e.message}")
        }
    }

    /**
     * Pinch zoom on an element.
     * Scale > 1.0 zooms in (pinch out), scale < 1.0 zooms out (pinch in).
     */
    fun pinchZoom(
        element: UiObject2,
        scale: Float,
    ) {
        try {
            if (scale > 1.0f) {
                // Pinch out (zoom in) — percentage is how far apart fingers end
                val percent = ((scale - 1.0f) * 100).coerceIn(10f, 100f) / 100f
                element.pinchOpen(percent)
            } else {
                // Pinch in (zoom out) — percentage is how far fingers move inward
                val percent = ((1.0f - scale) * 100).coerceIn(10f, 100f) / 100f
                element.pinchClose(percent)
            }
        } catch (e: Exception) {
            throw ActionFailedException("Failed to pinch zoom: ${e.message}")
        }
    }

    /**
     * Focus an element (click to focus, typically shows keyboard for text fields).
     */
    fun focus(element: UiObject2) {
        try {
            element.click()
            device.waitForIdle(FOCUS_IDLE_TIMEOUT_MS)
        } catch (e: Exception) {
            throw ActionFailedException("Failed to focus element: ${e.message}")
        }
    }

    /**
     * Blur an element by tapping outside its bounds to remove focus.
     * Avoids pressBack() which could navigate away or close dialogs.
     */
    fun blur(element: UiObject2) {
        try {
            val bounds = element.visibleBounds
            val screenWidth = device.displayWidth
            val screenHeight = device.displayHeight

            // Find a safe point outside the element to tap
            val tapX: Int
            val tapY: Int
            if (bounds.top > BLUR_TAP_MARGIN_PX) {
                // Tap above the element
                tapX = bounds.centerX()
                tapY = bounds.top / 2
            } else if (bounds.bottom < screenHeight - BLUR_TAP_MARGIN_PX) {
                // Tap below the element
                tapX = bounds.centerX()
                tapY = (bounds.bottom + screenHeight) / 2
            } else if (bounds.left > BLUR_TAP_MARGIN_PX) {
                // Tap to the left
                tapX = bounds.left / 2
                tapY = bounds.centerY()
            } else if (bounds.right < screenWidth - BLUR_TAP_MARGIN_PX) {
                // Tap to the right
                tapX = (bounds.right + screenWidth) / 2
                tapY = bounds.centerY()
            } else {
                // Element fills the screen — tap top-left corner as last resort
                tapX = 1
                tapY = 1
            }

            device.click(tapX, tapY)
            device.waitForIdle(FOCUS_IDLE_TIMEOUT_MS)
        } catch (e: Exception) {
            throw ActionFailedException("Failed to blur element: ${e.message}")
        }
    }

    /**
     * Highlight an element for debugging.
     *
     * Currently validates that the element exists and is accessible by reading its
     * bounds. A future version may draw an overlay rectangle on the device screen.
     */
    fun highlight(
        element: UiObject2,
        @Suppress("UNUSED_PARAMETER") durationMs: Long = 1000L,
    ) {
        try {
            // Validate element exists and is accessible by reading its bounds.
            // TODO: Draw an overlay rectangle on the device screen for visual debugging.
            element.visibleBounds
        } catch (e: Exception) {
            throw ActionFailedException("Failed to highlight element: ${e.message}")
        }
    }

    private fun resolveKeyCode(key: String): Int {
        return when (key.lowercase()) {
            "back" -> KeyEvent.KEYCODE_BACK
            "home" -> KeyEvent.KEYCODE_HOME
            "enter", "return" -> KeyEvent.KEYCODE_ENTER
            "tab" -> KeyEvent.KEYCODE_TAB
            "delete", "backspace" -> KeyEvent.KEYCODE_DEL
            "forward_delete" -> KeyEvent.KEYCODE_FORWARD_DEL
            "escape", "esc" -> KeyEvent.KEYCODE_ESCAPE
            "menu" -> KeyEvent.KEYCODE_MENU
            "search" -> KeyEvent.KEYCODE_SEARCH
            "volume_up" -> KeyEvent.KEYCODE_VOLUME_UP
            "volume_down" -> KeyEvent.KEYCODE_VOLUME_DOWN
            "power" -> KeyEvent.KEYCODE_POWER
            "camera" -> KeyEvent.KEYCODE_CAMERA
            "dpad_up" -> KeyEvent.KEYCODE_DPAD_UP
            "dpad_down" -> KeyEvent.KEYCODE_DPAD_DOWN
            "dpad_left" -> KeyEvent.KEYCODE_DPAD_LEFT
            "dpad_right" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "dpad_center" -> KeyEvent.KEYCODE_DPAD_CENTER
            "space" -> KeyEvent.KEYCODE_SPACE
            "recents", "app_switch" -> KeyEvent.KEYCODE_APP_SWITCH
            else -> {
                // Try parsing as a numeric key code
                key.toIntOrNull()
                    ?: throw ActionFailedException("Unknown key: '$key'. Use named keys (back, home, enter, etc.) or numeric key codes.")
            }
        }
    }
}
