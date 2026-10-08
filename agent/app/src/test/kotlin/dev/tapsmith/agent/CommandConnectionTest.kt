package dev.tapsmith.agent

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Host-side tests for how one daemon connection is served (PILOT-605): each
 * command runs off the connection's reader, so the daemon dropping the
 * connection while a command is still running cancels that command instead
 * of leaving it to run on.
 */
class CommandConnectionTest {
    private val executor = Executors.newCachedThreadPool()
    private val logs = Collections.synchronizedList(mutableListOf<String>())

    @After
    fun tearDown() {
        executor.shutdownNow()
    }

    /** A connection under test: what the daemon writes, and what it reads back. */
    private inner class Wire(
        handle: (String) -> String,
    ) {
        private val toAgent = PipedOutputStream()
        private val agentIn = PipedInputStream(toAgent, 1 shl 16)
        private val agentOut = PipedOutputStream()
        private val fromAgent = BufferedReader(InputStreamReader(PipedInputStream(agentOut, 1 shl 16), Charsets.UTF_8))
        private val served = CountDownLatch(1)

        init {
            val connection = CommandConnection(agentIn, agentOut, executor, handle) { logs.add(it) }
            executor.submit {
                try {
                    connection.serve()
                } finally {
                    served.countDown()
                }
            }
        }

        fun send(line: String) {
            toAgent.write((line + "\n").toByteArray(Charsets.UTF_8))
            toAgent.flush()
        }

        fun readLine(): String? = fromAgent.readLine()

        /** The daemon giving up on the connection. */
        fun close() = toAgent.close()

        fun awaitServed(): Boolean = served.await(5, TimeUnit.SECONDS)
    }

    private fun request(
        id: String,
        method: String = "ping",
    ) = """{"id":"$id","method":"$method","params":{}}"""

    private fun idOf(response: String?) = JSONObject(response!!).getString("id")

    @Test
    fun `answers each request on the connection`() {
        val wire = Wire { line -> """{"id":"${JSONObject(line).getString("id")}","result":{}}""" }
        wire.send(request("a"))
        assertEquals("a", idOf(wire.readLine()))
        wire.send(request("b"))
        assertEquals("b", idOf(wire.readLine()))
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `runs one command at a time, in order, even when requests arrive together`() {
        val running = AtomicInteger(0)
        val maxRunning = AtomicInteger(0)
        val wire =
            Wire { line ->
                maxRunning.accumulateAndGet(running.incrementAndGet(), ::maxOf)
                Thread.sleep(50)
                running.decrementAndGet()
                """{"id":"${JSONObject(line).getString("id")}","result":{}}"""
            }
        wire.send(request("1") + "\n" + request("2") + "\n" + request("3"))
        assertEquals(listOf("1", "2", "3"), List(3) { idOf(wire.readLine()) })
        assertEquals(1, maxRunning.get())
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `the daemon closing the connection cancels the running command`() {
        val started = CountDownLatch(1)
        val outcome = AtomicReference<Throwable?>()
        val finished = CountDownLatch(1)
        val wire =
            Wire { _ ->
                started.countDown()
                try {
                    CommandCancellation.sleep(30_000)
                    "{}"
                } catch (e: Throwable) {
                    outcome.set(e)
                    throw e
                } finally {
                    finished.countDown()
                }
            }
        wire.send(request("slow", "waitForElement"))
        assertTrue(started.await(5, TimeUnit.SECONDS))
        wire.close()
        assertTrue("the abandoned command kept running", finished.await(5, TimeUnit.SECONDS))
        assertTrue(outcome.get() is CommandCancelledException)
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `the connection is released without waiting for a command that cannot be interrupted`() {
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        val wire =
            Wire { _ ->
                started.countDown()
                // An uninterruptible native step (a hierarchy dump).
                release.await()
                "{}"
            }
        wire.send(request("dump", "getUiHierarchy"))
        assertTrue(started.await(5, TimeUnit.SECONDS))
        wire.close()
        assertTrue("serving the closed connection waited for the command", wire.awaitServed())
        release.countDown()
    }

    @Test
    fun `a command that answers after the daemon left does not throw`() {
        val release = CountDownLatch(1)
        val answered = CountDownLatch(1)
        val wire =
            Wire { _ ->
                release.await()
                answered.countDown()
                "{}"
            }
        wire.send(request("late"))
        wire.close()
        assertTrue(wire.awaitServed())
        release.countDown()
        assertTrue(answered.await(5, TimeUnit.SECONDS))
    }

    @Test
    fun `a handler failure is answered as an internal error`() {
        val wire = Wire { _ -> throw IllegalStateException("boom \"quoted\"") }
        wire.send(request("x"))
        val response = JSONObject(wire.readLine()!!)
        assertEquals("INTERNAL_ERROR", response.getJSONObject("error").getString("type"))
        assertEquals("boom \"quoted\"", response.getJSONObject("error").getString("message"))
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `blank lines are ignored`() {
        val wire = Wire { line -> """{"id":"${JSONObject(line).getString("id")}","result":{}}""" }
        wire.send("")
        wire.send("   ")
        wire.send(request("a"))
        assertEquals("a", idOf(wire.readLine()))
        wire.close()
        assertTrue(wire.awaitServed())
    }
}
