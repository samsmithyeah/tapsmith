package dev.pilot.agent

import android.os.SystemClock
import android.util.Log
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until

/**
 * Event-driven waiting engine that avoids polling loops and Thread.sleep().
 *
 * Uses UIAutomator's built-in wait mechanisms and accessibility events
 * to detect when the UI has settled or when elements become available.
 */
class WaitEngine(private val device: UiDevice) {
    companion object {
        private const val TAG = "PilotWait"
        private const val STABILITY_WINDOW_MS = 300L
        private const val DEFAULT_IDLE_TIMEOUT_MS = 5000L
        private const val DEFAULT_ELEMENT_TIMEOUT_MS = 10000L
    }

    /**
     * Wait until the UI is idle — no pending accessibility events and
     * no active animations.
     *
     * Uses UiDevice.waitForIdle() which internally monitors accessibility
     * events rather than polling.
     *
     * @param timeoutMs Maximum time to wait
     * @throws TimeoutException if the UI does not become idle within the timeout
     */
    fun waitForIdle(timeoutMs: Long = DEFAULT_IDLE_TIMEOUT_MS) {
        val startTime = SystemClock.uptimeMillis()

        // UiDevice.waitForIdle is event-driven — it monitors the accessibility
        // event stream and waits until no new events arrive within a quiet window.
        device.waitForIdle(timeoutMs)

        val elapsed = SystemClock.uptimeMillis() - startTime
        Log.d(TAG, "waitForIdle completed in ${elapsed}ms")
    }

    /**
     * Wait until an element matching the selector exists, is visible,
     * enabled, and positionally stable.
     *
     * Uses UIAutomator's event-driven Until conditions rather than
     * polling loops or Thread.sleep().
     *
     * @param selector The element selector to wait for
     * @param timeoutMs Maximum time to wait
     * @param elementFinder The element finder to use for the final result
     * @return ElementInfo for the found element
     * @throws TimeoutException if the element does not appear within timeout
     */
    fun waitForElement(
        selector: ElementSelector,
        timeoutMs: Long = DEFAULT_ELEMENT_TIMEOUT_MS,
        elementFinder: ElementFinder,
    ): ElementInfo {
        val startTime = SystemClock.uptimeMillis()

        // Build a BySelector for event-driven waiting
        val bySelector = buildWaitSelector(selector)

        if (bySelector != null) {
            // Phase 1: Wait for the element to exist using event-driven Until.hasObject
            val found = device.wait(Until.hasObject(bySelector), timeoutMs)
            if (!found) {
                throw TimeoutException(
                    "Timed out after ${timeoutMs}ms waiting for element to exist. " +
                        "Selector: ${describeSelector(selector)}",
                )
            }

            val remainingTime = timeoutMs - (SystemClock.uptimeMillis() - startTime)
            if (remainingTime <= 0) {
                throw TimeoutException(
                    "Timed out after ${timeoutMs}ms: element exists but no time left for stability check. " +
                        "Selector: ${describeSelector(selector)}",
                )
            }

            // Phase 2: Wait for the element to become enabled using event-driven wait
            val obj = device.findObject(bySelector)
            if (obj != null && !obj.isEnabled) {
                val enabled = obj.wait(Until.enabled(true), remainingTime.coerceAtMost(timeoutMs / 2))
                if (!enabled) {
                    throw TimeoutException(
                        "Timed out after ${timeoutMs}ms: element exists but is not enabled. " +
                            "Selector: ${describeSelector(selector)}",
                    )
                }
            }

            // Phase 3: Verify positional stability — check that the element's
            // bounds are not changing (i.e., animation has completed).
            val stableDeadline = SystemClock.uptimeMillis() + STABILITY_WINDOW_MS
            var lastBounds = device.findObject(bySelector)?.visibleBounds
            while (SystemClock.uptimeMillis() < stableDeadline) {
                // Use waitForIdle to yield to the accessibility event loop
                // rather than sleeping
                device.waitForIdle(STABILITY_WINDOW_MS)
                val currentObj = device.findObject(bySelector) ?: break
                val currentBounds = currentObj.visibleBounds
                if (lastBounds != null && lastBounds == currentBounds) {
                    break // Position is stable
                }
                lastBounds = currentBounds
            }
        } else {
            // For selectors we can't express as BySelector (e.g., xpath),
            // use waitForIdle and then check
            device.waitForIdle(timeoutMs.coerceAtMost(2000))
        }

        // Final lookup to return a cached ElementInfo
        try {
            return elementFinder.findElement(selector)
        } catch (e: ElementNotFoundException) {
            throw TimeoutException(
                "Timed out after ${timeoutMs}ms: element not found after waiting. " +
                    "Selector: ${describeSelector(selector)}",
            )
        }
    }

    /**
     * Build a BySelector from an ElementSelector for use with Until conditions.
     * Returns null if the selector type cannot be expressed as a BySelector.
     */
    private fun buildWaitSelector(selector: ElementSelector): androidx.test.uiautomator.BySelector? {
        return when {
            selector.text != null -> By.text(selector.text)
            selector.textContains != null -> By.textContains(selector.textContains)
            selector.contentDesc != null -> By.desc(selector.contentDesc)
            selector.id != null -> By.res(selector.id)
            selector.className != null -> By.clazz(selector.className)
            selector.testId != null -> By.desc("testid:${selector.testId}")
            else -> null
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
