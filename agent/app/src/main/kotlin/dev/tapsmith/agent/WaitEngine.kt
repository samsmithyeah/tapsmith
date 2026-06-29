package dev.tapsmith.agent

import android.os.SystemClock
import android.util.Log
import androidx.test.uiautomator.UiDevice

/**
 * Element-resolution / waiting engine.
 *
 * Element queries snapshot the current accessibility tree (via [ElementFinder])
 * and match immediately — they are NOT gated on global UI idle. This is
 * essential on perpetually-animated screens (React Native Reanimated loops,
 * indeterminate progress spinners, etc.) where the accessibility-event stream
 * never quiets: an idle-gated wait (UiDevice.waitForIdle / Until.hasObject)
 * would block for its full timeout even when the target element is already
 * present, wedging the agent's single command thread and tripping the daemon's
 * per-command deadline.
 *
 * Bounded idle-waiting is reserved for the explicit [waitForIdle] settle command.
 */
class WaitEngine(private val device: UiDevice) {
    companion object {
        private const val TAG = "TapsmithWait"

        /** Window between settle re-checks, and the default explicit-idle timeout. */
        private const val STABILITY_WINDOW_MS = 100L
        private const val DEFAULT_IDLE_TIMEOUT_MS = 5000L
        private const val DEFAULT_ELEMENT_TIMEOUT_MS = 10000L

        /** Polling interval used when re-trying findElement inside the wait loop. */
        private const val FIND_POLL_INTERVAL_MS = 200L

        /**
         * Max positional-stability re-checks before falling back to the current
         * match. Caps the settle phase so a never-settling (animated) screen
         * still makes forward progress instead of blocking.
         */
        private const val SETTLE_MAX_CHECKS = 3
    }

    /**
     * Wait until the UI is idle — no pending accessibility events.
     *
     * This is an EXPLICIT settle primitive (the `waitForIdle` command). On a
     * screen that never goes idle it will block for the full [timeoutMs]; that
     * is by design — callers ask for it deliberately. Element queries must NOT
     * route through here; they use [waitForElement] instead.
     */
    fun waitForIdle(timeoutMs: Long = DEFAULT_IDLE_TIMEOUT_MS) {
        val startTime = SystemClock.uptimeMillis()
        device.waitForIdle(timeoutMs)
        val elapsed = SystemClock.uptimeMillis() - startTime
        Log.d(TAG, "waitForIdle completed in ${elapsed}ms")
    }

    /**
     * Wait until an element matching the selector exists, then (best-effort)
     * until it is enabled and positionally stable.
     *
     * Resolution polls [ElementFinder.findElement] — which reads a live snapshot
     * of the accessibility tree and does the precise match — sleeping between
     * attempts rather than blocking on global idle. The settle phase is bounded
     * and idle-free: if the screen never stabilizes, it returns the current
     * match instead of waiting forever.
     *
     * @param selector The element selector to wait for
     * @param timeoutMs Maximum time to wait for the element to exist
     * @param elementFinder The element finder used to match
     * @return ElementInfo for the matched element
     * @throws TimeoutException if no matching element appears within the timeout
     */
    fun waitForElement(
        selector: ElementSelector,
        timeoutMs: Long = DEFAULT_ELEMENT_TIMEOUT_MS,
        elementFinder: ElementFinder,
    ): ElementInfo {
        val deadline = SystemClock.uptimeMillis() + timeoutMs

        // Phase 1: wait for the element to be present (idle-free snapshot poll).
        var match = findOrThrow(selector, elementFinder, deadline, timeoutMs)

        // Phase 2: best-effort settle — prefer an enabled, positionally-stable
        // match, but never block on global idle and always fall back to the
        // current match so animated screens make progress.
        var checks = 0
        while (checks < SETTLE_MAX_CHECKS) {
            val remaining = deadline - SystemClock.uptimeMillis()
            if (remaining <= 0) break

            val prevBounds = match.bounds
            SystemClock.sleep(STABILITY_WINDOW_MS.coerceAtMost(remaining))

            try {
                match = elementFinder.findElement(selector)
            } catch (_: ElementNotFoundException) {
                // Element went away during the settle window; re-acquire (or
                // time out) and give the new element its own stability window
                // next iteration rather than comparing it against the old
                // element's bounds.
                match = findOrThrow(selector, elementFinder, deadline, timeoutMs)
                checks++
                continue
            }

            // Stable across one window and interactable → done. Only a selector
            // that explicitly requires an enabled element waits for it to
            // enable; null/false targets are ready once positionally stable
            // (the SDK owns enabled-waiting for actions like tap()).
            val isReady = selector.enabled != true || match.isEnabled
            if (match.bounds == prevBounds && isReady) break
            checks++
        }

        return match
    }

    /**
     * Poll [ElementFinder.findElement] until a match exists or [deadline] passes.
     * Sleeps (never calls device.waitForIdle) between attempts, so it makes
     * forward progress on screens that never go idle. The first attempt happens
     * before any sleep, so a visible element returns on the first snapshot.
     */
    private fun findOrThrow(
        selector: ElementSelector,
        elementFinder: ElementFinder,
        deadline: Long,
        timeoutMs: Long,
    ): ElementInfo {
        while (true) {
            try {
                return elementFinder.findElement(selector)
            } catch (_: ElementNotFoundException) {
                val remaining = deadline - SystemClock.uptimeMillis()
                if (remaining <= 0) {
                    throw TimeoutException(
                        "Timed out after ${timeoutMs}ms: element not found after waiting. " +
                            "Selector: ${describeSelector(selector)}",
                    )
                }
                SystemClock.sleep(FIND_POLL_INTERVAL_MS.coerceAtMost(remaining))
            }
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
