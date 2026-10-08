package dev.tapsmith.agent

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.Executors

/**
 * TCP socket server that listens for JSON commands from the host daemon.
 *
 * Protocol: newline-delimited JSON. Each line is a complete JSON object.
 * Request:  {"id": "uuid", "method": "methodName", "params": {...}}
 * Response: {"id": "uuid", "result": {...}} or {"id": "uuid", "error": {...}}
 *
 * Commands are dispatched to the CommandHandler which runs UIAutomator2
 * operations. Each connection is served by [CommandConnection]: a thread
 * reading it, and a thread for each command, which is cancelled when the
 * daemon drops the connection (PILOT-605).
 */
class SocketServer(
    private val port: Int,
    private val commandHandler: CommandHandler,
) {
    companion object {
        private const val TAG = "TapsmithSocket"
    }

    /**
     * Unbounded, so a new connection never queues behind one whose command
     * the daemon gave up on (PILOT-605). The daemon drops a connection when it
     * stops waiting and opens another for the next command — and its liveness
     * ping opens one too. With a fixed pool of 2, two abandoned commands still
     * running (a find on a busy screen, a wait the SDK cancelled) held both
     * threads, and every later command, ping included, waited for one of
     * them to finish: the daemon then declared a working agent dead. A
     * cancelled command stops at its next checkpoint, but a native call (a
     * hierarchy dump) cannot be stopped, so it must not hold up the next
     * connection. Idle threads exit after 60 s.
     */
    private val executor = Executors.newCachedThreadPool()
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var running = false

    suspend fun start() {
        running = true
        withContext(Dispatchers.IO) {
            try {
                serverSocket = ServerSocket(port)
                Log.i(TAG, "Listening on port $port")

                while (running) {
                    val client =
                        try {
                            serverSocket?.accept()
                        } catch (e: SocketException) {
                            if (running) Log.e(TAG, "Accept failed", e)
                            break
                        } ?: break

                    Log.i(TAG, "Client connected: ${client.remoteSocketAddress}")
                    // Handle each client on a worker thread so UIAutomator
                    // operations run with the correct thread context
                    executor.submit { handleClient(client) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Server error", e)
            } finally {
                Log.i(TAG, "Server stopped")
            }
        }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        executor.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.use { s ->
                s.tcpNoDelay = true
                CommandConnection(
                    input = s.getInputStream(),
                    output = s.getOutputStream(),
                    executor = executor,
                    handle = { line ->
                        Log.d(TAG, "Received: $line")
                        commandHandler.handle(line).also { Log.d(TAG, "Responding: $it") }
                    },
                    isRunning = { running && !s.isClosed },
                    log = { Log.d(TAG, it) },
                ).serve()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Client handler error", e)
        }
    }
}
