package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Host-side tests for the token an abandoned command is cancelled through
 * (PILOT-605).
 */
class CommandCancellationTest {
    private inline fun expectCancelled(block: () -> Unit): CommandCancelledException {
        try {
            block()
        } catch (e: CommandCancelledException) {
            return e
        }
        fail("expected CommandCancelledException, nothing thrown")
        throw IllegalStateException()
    }

    @Test
    fun `a fresh token is not cancelled and its checkpoint passes`() {
        val token = CommandCancellation()
        assertFalse(token.isCancelled)
        token.throwIfCancelled()
    }

    @Test
    fun `a cancelled token fails its checkpoint with the reason`() {
        val token = CommandCancellation()
        token.cancel("the daemon closed the connection")
        assertTrue(token.isCancelled)
        val e = expectCancelled { token.throwIfCancelled() }
        assertTrue(e.message!!.contains("the daemon closed the connection"))
    }

    @Test
    fun `the first reason wins and cancelling twice is harmless`() {
        val token = CommandCancellation()
        token.cancel("first")
        token.cancel("second")
        val e = expectCancelled { token.throwIfCancelled() }
        assertTrue(e.message!!.contains("first"))
        assertFalse(e.message!!.contains("second"))
    }

    @Test
    fun `a sleep wakes as soon as the token is cancelled`() {
        val token = CommandCancellation()
        val thrown = AtomicReference<Throwable?>()
        val sleeping = CountDownLatch(1)
        val done = CountDownLatch(1)
        val sleeper =
            Thread {
                CommandCancellation.runWith(token) {
                    sleeping.countDown()
                    try {
                        CommandCancellation.sleep(30_000)
                    } catch (e: Throwable) {
                        thrown.set(e)
                    }
                }
                done.countDown()
            }
        sleeper.start()
        assertTrue(sleeping.await(5, TimeUnit.SECONDS))
        val cancelledAt = System.nanoTime()
        token.cancel("abandoned")
        assertTrue("the sleep did not wake on cancel", done.await(5, TimeUnit.SECONDS))
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - cancelledAt) < 5_000)
        assertTrue(thrown.get() is CommandCancelledException)
    }

    @Test
    fun `a sleep on a live token lasts its full time`() {
        val token = CommandCancellation()
        val start = System.nanoTime()
        CommandCancellation.runWith(token) { CommandCancellation.sleep(50) }
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) >= 45)
    }

    @Test
    fun `checkpoint and sleep outside a command are no-ops`() {
        assertNull(CommandCancellation.current())
        CommandCancellation.checkpoint()
        CommandCancellation.sleep(1)
    }

    @Test
    fun `the checkpoint sees the token of the command running on this thread`() {
        val token = CommandCancellation()
        token.cancel("abandoned")
        expectCancelled { CommandCancellation.runWith(token) { CommandCancellation.checkpoint() } }
        // The scope ends with the command: nothing leaks to the next one.
        assertNull(CommandCancellation.current())
        CommandCancellation.checkpoint()
    }

    @Test
    fun `runWith restores the outer token and returns the block's value`() {
        val outer = CommandCancellation()
        val inner = CommandCancellation()
        val value =
            CommandCancellation.runWith(outer) {
                CommandCancellation.runWith(inner) { assertEquals(inner, CommandCancellation.current()) }
                assertEquals(outer, CommandCancellation.current())
                42
            }
        assertEquals(42, value)
        assertNull(CommandCancellation.current())
    }
}
