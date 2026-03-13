package dev.pilot.agent

import android.util.Log
import androidx.test.uiautomator.UiDevice
import java.io.ByteArrayOutputStream

/**
 * Dumps the current UI hierarchy from UIAutomator as an XML string.
 *
 * The hierarchy includes all visible windows and their element trees,
 * with properties such as class, text, content-desc, resource-id, bounds,
 * enabled, checked, focused, clickable, scrollable, and more.
 */
class HierarchyDumper(private val device: UiDevice) {
    companion object {
        private const val TAG = "PilotHierarchy"
    }

    /**
     * Dump the full UI hierarchy as an XML string.
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
            xml
        } catch (e: ActionFailedException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Failed to dump UI hierarchy", e)
            throw ActionFailedException("Failed to dump UI hierarchy: ${e.message}")
        }
    }
}
