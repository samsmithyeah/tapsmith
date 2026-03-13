package dev.pilot.agent

import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * Entry point for the Pilot on-device agent.
 *
 * Launched via `adb shell am instrument -w dev.pilot.agent/.PilotAgent`.
 * Initializes UIAutomator's UiDevice and starts the TCP socket server
 * that accepts commands from the host daemon.
 */
class PilotAgent : Instrumentation() {

    companion object {
        private const val TAG = "PilotAgent"
        private const val DEFAULT_PORT = 18700
        private const val ARG_PORT = "port"

        @Volatile
        lateinit var device: UiDevice
            private set
    }

    private var socketServer: SocketServer? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        Log.i(TAG, "PilotAgent starting")

        // Initialize UiDevice — must pass the Instrumentation instance
        device = UiDevice.getInstance(this)

        val port = arguments?.getString(ARG_PORT)?.toIntOrNull() ?: DEFAULT_PORT

        val elementFinder = ElementFinder(device)
        val actionExecutor = ActionExecutor(device)
        val waitEngine = WaitEngine(device)
        val hierarchyDumper = HierarchyDumper(device)
        val commandHandler = CommandHandler(
            device = device,
            elementFinder = elementFinder,
            actionExecutor = actionExecutor,
            waitEngine = waitEngine,
            hierarchyDumper = hierarchyDumper
        )

        socketServer = SocketServer(port, commandHandler)

        Log.i(TAG, "PilotAgent started on port $port")

        // Keep instrumentation alive — do not call finish().
        start()
    }

    override fun onStart() {
        super.onStart()
        // Run the socket server on this thread (the instrumentation thread).
        // UIAutomator2 requires calls from a thread with proper context,
        // and the instrumentation thread provides that.
        runBlocking {
            socketServer?.start()
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "PilotAgent shutting down")
        socketServer?.stop()
        super.onDestroy()
    }
}
