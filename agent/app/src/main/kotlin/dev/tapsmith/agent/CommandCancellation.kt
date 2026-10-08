package dev.tapsmith.agent

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Thrown at a cancellation checkpoint once the command's daemon has given up
 * on it (PILOT-605). Nobody reads the answer to a cancelled command — the
 * connection it came in on is gone — so this only has to stop the work.
 */
class CommandCancelledException(
    message: String,
) : RuntimeException(message)

/**
 * The cancellation token of one agent command (PILOT-605).
 *
 * The daemon gives up on a command by dropping its connection — at its read
 * deadline (the command's timeout plus `TAPSMITH_AGENT_READ_HEADROOM_MS`),
 * or when the SDK cancels the call (a test timeout, a stop). Until then
 * nothing stopped the agent: a find on a busy screen, a selector wait or a
 * scroll-until-visible ran on to the end, holding a connection thread and
 * still touching the screen in the middle of whatever the test did next.
 * [CommandConnection] cancels the token when the connection closes, and the
 * long-running loops call [checkpoint] and [sleep], which throw
 * [CommandCancelledException] from then on.
 *
 * Cancellation is sticky: a checkpoint inside a fallback that caught the
 * first [CommandCancelledException] throws again, so a cancelled command
 * cannot reach a touch whatever its error handling does.
 *
 * Not every step can be stopped — a hierarchy dump or `device.findObjects`
 * is one native call — which is why each connection also gets a thread of
 * its own (see SocketServer): a new command never waits behind one that
 * could not be stopped.
 *
 * The token of the command running on a thread is thread-local ([runWith]),
 * so the loops reach it without every finder and executor signature carrying
 * it. Plain Kotlin with no Android dependencies, for the JVM unit tests.
 */
class CommandCancellation {
    private val cancelled = CountDownLatch(1)

    @Volatile
    private var reason: String? = null

    val isCancelled: Boolean
        get() = cancelled.count == 0L

    /** Cancel the command. The first [reason] is kept; later calls do nothing. */
    fun cancel(reason: String) {
        synchronized(this) {
            if (this.reason == null) this.reason = reason
        }
        cancelled.countDown()
    }

    /** @throws CommandCancelledException once [cancel] has been called. */
    fun throwIfCancelled() {
        if (isCancelled) throw CommandCancelledException("Command abandoned: $reason")
    }

    /** Sleep [ms], waking at once when the command is cancelled. */
    fun sleep(ms: Long) {
        throwIfCancelled()
        if (ms > 0) cancelled.await(ms, TimeUnit.MILLISECONDS)
        throwIfCancelled()
    }

    companion object {
        private val current = ThreadLocal<CommandCancellation?>()

        /** The token of the command running on this thread, if any. */
        fun current(): CommandCancellation? = current.get()

        /** Run [block] as the command [token] belongs to. */
        fun <T> runWith(
            token: CommandCancellation,
            block: () -> T,
        ): T {
            val outer = current.get()
            current.set(token)
            try {
                return block()
            } finally {
                current.set(outer)
            }
        }

        /**
         * @throws CommandCancelledException when the command running on this
         *   thread was cancelled. A no-op outside a command.
         */
        fun checkpoint() {
            current.get()?.throwIfCancelled()
        }

        /**
         * Sleep [ms] — cut short, with [CommandCancelledException], when the
         * command running on this thread is cancelled. Outside a command, a
         * plain sleep.
         */
        fun sleep(ms: Long) {
            val token = current.get()
            if (token != null) {
                token.sleep(ms)
            } else if (ms > 0) {
                Thread.sleep(ms)
            }
        }
    }
}
