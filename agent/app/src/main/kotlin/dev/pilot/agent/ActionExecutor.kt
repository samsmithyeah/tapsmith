package dev.pilot.agent

import android.view.KeyEvent
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2

/**
 * Executes UI actions: tap, long press, text input, swipe, scroll, and key presses.
 */
class ActionExecutor(private val device: UiDevice) {
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
     * Uses shell command for reliable text input.
     */
    fun typeTextWithoutFocus(text: String) {
        // Escape special characters for shell input
        val escaped =
            text.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("$", "\\$")
                .replace("`", "\\`")
                .replace(" ", "%s")
        device.executeShellCommand("input text \"${escaped.replace("%s", "\\ ")}\"")
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
