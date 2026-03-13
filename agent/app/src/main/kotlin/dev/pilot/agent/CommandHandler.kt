package dev.pilot.agent

import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Routes incoming JSON commands to the appropriate handler.
 *
 * JSON protocol:
 *   Request:  {"id": "uuid", "method": "methodName", "params": {...}}
 *   Response: {"id": "uuid", "result": {...}}
 *         or: {"id": "uuid", "error": {"type": "...", "message": "..."}}
 */
class CommandHandler(
    private val device: UiDevice,
    private val elementFinder: ElementFinder,
    private val actionExecutor: ActionExecutor,
    private val waitEngine: WaitEngine,
    private val hierarchyDumper: HierarchyDumper
) {
    companion object {
        private const val TAG = "PilotCommand"
    }

    fun handle(rawJson: String): String {
        val json = try {
            JSONObject(rawJson)
        } catch (e: Exception) {
            return errorResponse(null, "PARSE_ERROR", "Invalid JSON: ${e.message}")
        }

        val id = json.optString("id", null)
        val method = json.optString("method", null)
        if (method == null) {
            return errorResponse(id, "INVALID_REQUEST", "Missing 'method' field")
        }

        val params = json.optJSONObject("params") ?: JSONObject()

        return try {
            val result = dispatch(method, params)
            successResponse(id, result)
        } catch (e: ElementNotFoundException) {
            errorResponse(id, "ELEMENT_NOT_FOUND", e.message ?: "Element not found")
        } catch (e: TimeoutException) {
            errorResponse(id, "TIMEOUT", e.message ?: "Operation timed out")
        } catch (e: InvalidSelectorException) {
            errorResponse(id, "INVALID_SELECTOR", e.message ?: "Invalid selector")
        } catch (e: ActionFailedException) {
            errorResponse(id, "ACTION_FAILED", e.message ?: "Action failed")
        } catch (e: Exception) {
            Log.e(TAG, "Error handling method '$method'", e)
            errorResponse(id, "INTERNAL_ERROR", e.message ?: "Unknown error")
        }
    }

    /**
     * Resolve an element from params, supporting both elementId (cached) and
     * selector-based lookup with auto-waiting.
     */
    private fun resolveElement(params: JSONObject): ElementInfo {
        val elementId = params.optString("elementId", null)
        if (elementId != null) {
            // Use cached element
            val obj = elementFinder.getElement(elementId)
            return elementFinder.findElement(
                ElementSelector(className = obj.className),
                null
            )
        }
        // Selector-based: auto-wait then find
        val selector = parseSelectorParams(params)
        val timeout = params.optLong("timeout", 10000L)
        return waitEngine.waitForElement(selector, timeout, elementFinder)
    }

    private fun dispatch(method: String, params: JSONObject): JSONObject {
        return when (method) {
            "findElement" -> {
                val selector = parseSelectorParams(params)
                val parentId = params.optString("parentId", null)
                val timeout = params.optLong("timeout", 10000L)
                // Auto-wait for element if timeout > 0
                val element = if (timeout > 0 && parentId == null) {
                    waitEngine.waitForElement(selector, timeout, elementFinder)
                } else {
                    elementFinder.findElement(selector, parentId)
                }
                element.toJson()
            }

            "findElements" -> {
                val selector = parseSelectorParams(params)
                val parentId = params.optString("parentId", null)
                val elements = elementFinder.findElements(selector, parentId)
                JSONObject().put("elements", elements.map { it.toJson() }.toTypedArray().let {
                    org.json.JSONArray(it)
                })
            }

            "tap" -> {
                val x = params.optInt("x", -1)
                val y = params.optInt("y", -1)
                if (x >= 0 && y >= 0) {
                    actionExecutor.tapCoordinates(x, y)
                } else {
                    val element = resolveElement(params)
                    actionExecutor.tap(elementFinder.getElement(element.elementId))
                }
                JSONObject().put("success", true)
            }

            // waitForElement is used by the daemon to auto-wait + find + tap
            "waitForElement" -> {
                val selector = parseSelectorParams(params)
                val timeout = params.optLong("timeout", 10000L)
                val element = waitEngine.waitForElement(selector, timeout, elementFinder)
                // After waiting, tap the element
                actionExecutor.tap(elementFinder.getElement(element.elementId))
                JSONObject().put("success", true).put("element", element.toJson())
            }

            "longPress" -> {
                val duration = params.optLong("duration", 1000L)
                val x = params.optInt("x", -1)
                val y = params.optInt("y", -1)
                if (x >= 0 && y >= 0) {
                    actionExecutor.longPressCoordinates(x, y, duration)
                } else {
                    val element = resolveElement(params)
                    actionExecutor.longPress(elementFinder.getElement(element.elementId), duration)
                }
                JSONObject().put("success", true)
            }

            "typeText" -> {
                val text = params.getString("text")
                val hasSelector = params.has("text") && (params.has("role") || params.has("id") ||
                    params.has("contentDesc") || params.has("className") || params.has("testId") ||
                    params.has("hint") || params.has("textContains") || params.has("elementId"))
                if (hasSelector || params.has("elementId")) {
                    val element = resolveElement(params)
                    actionExecutor.typeText(elementFinder.getElement(element.elementId), text)
                } else {
                    actionExecutor.typeTextWithoutFocus(text)
                }
                JSONObject().put("success", true)
            }

            "clearText" -> {
                val element = resolveElement(params)
                actionExecutor.clearText(elementFinder.getElement(element.elementId))
                JSONObject().put("success", true)
            }

            "swipe" -> {
                val direction = params.getString("direction")
                val speed = params.optInt("speed", 5000)
                val distance = params.optDouble("distance", 0.5)
                val elementId = params.optString("elementId", null)
                if (elementId != null) {
                    actionExecutor.swipe(elementFinder.getElement(elementId), direction, speed, distance)
                } else if (params.has("startElement")) {
                    val startSel = parseSelectorParams(params.getJSONObject("startElement"))
                    val startEl = waitEngine.waitForElement(startSel, 10000L, elementFinder)
                    actionExecutor.swipe(elementFinder.getElement(startEl.elementId), direction, speed, distance)
                } else {
                    actionExecutor.swipeScreen(direction, speed, distance)
                }
                JSONObject().put("success", true)
            }

            "scroll" -> {
                val direction = params.getString("direction")
                val targetSelector = if (params.has("scrollTo")) {
                    parseSelectorParams(params.getJSONObject("scrollTo"))
                } else null
                if (params.has("container")) {
                    val containerSel = parseSelectorParams(params.getJSONObject("container"))
                    val containerEl = waitEngine.waitForElement(containerSel, 10000L, elementFinder)
                    actionExecutor.scroll(elementFinder.getElement(containerEl.elementId), direction, targetSelector)
                } else if (params.has("elementId")) {
                    val elementId = params.getString("elementId")
                    actionExecutor.scroll(elementFinder.getElement(elementId), direction, targetSelector)
                } else {
                    actionExecutor.scrollScreen(direction, targetSelector)
                }
                JSONObject().put("success", true)
            }

            "pressKey" -> {
                val key = params.getString("key")
                actionExecutor.pressKey(key)
                JSONObject().put("success", true)
            }

            "getUiHierarchy" -> {
                val xml = hierarchyDumper.dump()
                JSONObject().put("hierarchy", xml)
            }

            "waitForIdle" -> {
                val timeout = params.optLong("timeout", 5000L)
                waitEngine.waitForIdle(timeout)
                JSONObject().put("success", true)
            }

            "waitForElement" -> {
                val selector = parseSelectorParams(params)
                val timeout = params.optLong("timeout", 10000L)
                val element = waitEngine.waitForElement(selector, timeout, elementFinder)
                element.toJson()
            }

            "screenshot" -> {
                val quality = params.optInt("quality", 80)
                val base64 = captureScreenshot(quality)
                JSONObject().put("data", base64).put("format", "png")
            }

            "ping" -> {
                JSONObject().put("pong", true)
            }

            else -> throw ActionFailedException("Unknown method: $method")
        }
    }

    private fun parseSelectorParams(params: JSONObject): ElementSelector {
        // Handle "role" which can be either a string or a {"role": "...", "name": "..."} object
        val roleObj = params.opt("role")
        val role: String?
        val name: String?
        if (roleObj is JSONObject) {
            role = roleObj.optString("role", null)
            name = roleObj.optString("name", null)
        } else {
            role = params.optString("role", null)
            name = params.optString("name", null)
        }

        // Handle "resourceId" (sent by daemon) or "id" (legacy)
        val resourceId = params.optString("resourceId", null) ?: params.optString("id", null)

        return ElementSelector(
            role = role,
            name = name,
            text = params.optString("text", null),
            textContains = params.optString("textContains", null),
            contentDesc = params.optString("contentDesc", null),
            hint = params.optString("hint", null),
            className = params.optString("className", null),
            testId = params.optString("testId", null),
            id = resourceId,
            xpath = params.optString("xpath", null),
            enabled = if (params.has("enabled")) params.getBoolean("enabled") else null,
            checked = if (params.has("checked")) params.getBoolean("checked") else null,
            focused = if (params.has("focused")) params.getBoolean("focused") else null
        )
    }

    private fun captureScreenshot(quality: Int): String {
        val tmpFile = java.io.File.createTempFile("pilot_screenshot", ".png")
        try {
            val success = device.takeScreenshot(tmpFile, quality.toFloat() / 100f, quality)
            if (!success) {
                throw ActionFailedException("Failed to capture screenshot")
            }
            val bytes = tmpFile.readBytes()
            return Base64.encodeToString(bytes, Base64.NO_WRAP)
        } finally {
            tmpFile.delete()
        }
    }

    private fun successResponse(id: String?, result: JSONObject): String {
        return JSONObject().apply {
            put("id", id ?: JSONObject.NULL)
            put("result", result)
        }.toString()
    }

    private fun errorResponse(id: String?, type: String, message: String): String {
        return JSONObject().apply {
            put("id", id ?: JSONObject.NULL)
            put("error", JSONObject().apply {
                put("type", type)
                put("message", message)
            })
        }.toString()
    }
}

// Custom exceptions for structured error handling
class ElementNotFoundException(message: String) : RuntimeException(message)
class TimeoutException(message: String) : RuntimeException(message)
class InvalidSelectorException(message: String) : RuntimeException(message)
class ActionFailedException(message: String) : RuntimeException(message)
