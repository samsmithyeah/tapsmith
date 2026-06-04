package dev.tapsmith.agent

import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import kotlinx.coroutines.runBlocking

/**
 * Entry point for the Tapsmith on-device agent.
 *
 * Launched via `adb shell am instrument -w dev.tapsmith.agent/.TapsmithAgent`.
 * Initializes UIAutomator's UiDevice and starts the TCP socket server
 * that accepts commands from the host daemon.
 */
class TapsmithAgent : Instrumentation() {
    companion object {
        private const val TAG = "TapsmithAgent"
        private const val DEFAULT_PORT = 18700
        private const val ARG_PORT = "port"

        @Volatile
        lateinit var device: UiDevice
            private set
    }

    private var socketServer: SocketServer? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        Log.i(TAG, "TapsmithAgent starting")

        // Initialize UiDevice — must pass the Instrumentation instance
        device = UiDevice.getInstance(this)

        // Lower UIAutomator's default timeouts (10s each) which cause every
        // action to block for the full duration on React Native apps (which
        // are never truly "idle" due to JS bridge timers). 500ms is enough
        // to let UIAutomator's internal accessibility event loop settle
        // without penalizing every single operation.
        Configurator.getInstance().apply {
            waitForIdleTimeout = 500L
            waitForSelectorTimeout = 500L
        }

        val port = arguments?.getString(ARG_PORT)?.toIntOrNull() ?: DEFAULT_PORT

        val elementFinder = ElementFinder(device)
        val actionExecutor = ActionExecutor(device, this)
        val waitEngine = WaitEngine(device)
        val hierarchyDumper = HierarchyDumper(device, this)
        val commandHandler =
            CommandHandler(
                context = targetContext,
                device = device,
                elementFinder = elementFinder,
                actionExecutor = actionExecutor,
                waitEngine = waitEngine,
                hierarchyDumper = hierarchyDumper,
            )

        socketServer = SocketServer(port, commandHandler)

        Log.i(TAG, "TapsmithAgent started on port $port")

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
        Log.i(TAG, "TapsmithAgent shutting down")
        socketServer?.stop()
        super.onDestroy()
    }
}
