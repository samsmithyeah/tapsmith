package dev.pilot.agent

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
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
 * operations. Each client connection is handled on a dedicated thread from
 * a fixed thread pool to ensure UIAutomator calls have the right context.
 */
class SocketServer(
    private val port: Int,
    private val commandHandler: CommandHandler,
) {
    companion object {
        private const val TAG = "PilotSocket"
    }

    private val executor = Executors.newFixedThreadPool(2)
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
                val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
                val writer = PrintWriter(s.getOutputStream(), true)

                while (running && !s.isClosed) {
                    val line =
                        try {
                            reader.readLine()
                        } catch (e: SocketException) {
                            Log.d(TAG, "Client read error: ${e.message}")
                            null
                        }

                    if (line == null) {
                        Log.i(TAG, "Client disconnected")
                        break
                    }

                    if (line.isBlank()) continue

                    Log.d(TAG, "Received: $line")

                    val response =
                        try {
                            commandHandler.handle(line)
                        } catch (e: Exception) {
                            Log.e(TAG, "Unhandled error processing command", e)
                            val msg = e.message?.replace("\"", "\\\"") ?: "Unknown error"
                            """{"id":null,"error":{"type":"INTERNAL_ERROR","message":"$msg"}}"""
                        }

                    Log.d(TAG, "Responding: $response")

                    try {
                        writer.println(response)
                        writer.flush()
                    } catch (e: SocketException) {
                        Log.d(TAG, "Client write error: ${e.message}")
                        break
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Client handler error", e)
        }
    }
}
