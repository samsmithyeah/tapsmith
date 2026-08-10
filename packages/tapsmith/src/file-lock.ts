import * as fs from 'node:fs';
import lockfile from 'proper-lockfile';

/**
 * Synchronous file locking with retries.
 *
 * `proper-lockfile`'s sync API rejects a `retries` option outright — it throws
 * "Cannot use retries with the sync api" — so passing one means the lock is
 * *never* acquired and the caller silently runs unlocked, which is exactly the
 * race the lock was meant to close. The retry loop has to live here instead.
 */

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_WAIT_MS = 25;
/**
 * Abandoned locks older than this are broken, so a crash cannot wedge us.
 *
 * Kept short on purpose. A window sized to cover the longest critical section
 * would mean a process killed mid-section blocks every other run for that whole
 * window; holders call `heartbeat` instead, so length of work costs nothing and
 * only genuine death costs this.
 */
const STALE_MS = 30_000;

/** Block the thread briefly. The lock is held for a filesystem write, not I/O. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Outcome of {@link withFileLockSync}: whether the lock was held, and what `fn` returned. */
export type LockOutcome<T> =
  | { locked: true; value: T }
  | { locked: false };

/**
 * Run `fn` while holding an exclusive lock on `file`.
 *
 * The result says whether the lock was acquired, separately from what `fn`
 * returned — callers decide whether to skip the work or proceed unlocked, and
 * a bare `undefined` return could not tell "never ran" from "ran and returned
 * nothing". Any caller whose `fn` returns `undefined` or `false` would
 * otherwise read its own success as contention.
 *
 * `fn` is handed a `heartbeat` it should call between slow steps. See
 * {@link STALE_MS} for why that beats simply declaring a long stale window.
 *
 * `fn` must be synchronous — see {@link Synchronous}.
 */
/**
 * A value that is not a promise, which is what the lock can actually guard.
 *
 * An `async fn` typechecks against a bare `T` but is released the instant it
 * returns its promise — so the guarded work runs outside the lock, and
 * `{ locked: true }` says otherwise. Worse, once it yields, proper-lockfile's
 * update timer can fire, see the mtime {@link touchLock} wrote, decide the lock
 * was compromised, and throw from an fs callback where nothing can catch it.
 * Rejecting it at the type level is cheaper than diagnosing either.
 */
type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

export function withFileLockSync<T>(
  file: string,
  fn: (heartbeat: () => void) => Synchronous<T>,
  options?: { attempts?: number; waitMs?: number; staleMs?: number },
): LockOutcome<T> {
  const attempts = options?.attempts ?? DEFAULT_ATTEMPTS;
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options?.staleMs ?? STALE_MS;

  let release: (() => void) | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      release = lockfile.lockSync(file, { stale: staleMs });
      break;
    } catch (err) {
      // ENOENT means the target vanished — retrying cannot help.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(file)) return { locked: false };
      if (attempt === attempts - 1) return { locked: false };
      sleepSync(waitMs);
    }
  }
  if (!release) return { locked: false };

  try {
    return { locked: true, value: fn(() => touchLock(file)) as T };
  } finally {
    try { release(); } catch { /* lock already released or broken */ }
  }
}

/**
 * Mark a held lock as still alive.
 *
 * proper-lockfile judges staleness from the lock directory's mtime and keeps
 * its own copy fresh from a timer — which cannot fire while a synchronous
 * critical section blocks the event loop. Touching it by hand is what lets the
 * stale window stay short: the alternative, a window long enough to cover the
 * whole section, means a process that dies mid-section wedges every other run
 * for that entire window.
 */
function touchLock(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(`${file}.lock`, now, now);
  } catch {
    // The lock was broken or removed under us. Nothing useful to do here: the
    // section is already running, and `release()` handles a missing lock.
  }
}
