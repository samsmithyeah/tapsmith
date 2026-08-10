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
/** Abandoned locks older than this are broken, so a crash cannot wedge us. */
const STALE_MS = 10_000;

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
 */
export function withFileLockSync<T>(
  file: string,
  fn: () => T,
  options?: { attempts?: number; waitMs?: number; staleMs?: number },
): LockOutcome<T> {
  const attempts = options?.attempts ?? DEFAULT_ATTEMPTS;
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  // proper-lockfile keeps a held lock fresh from a timer, which cannot fire
  // while `fn` blocks the event loop. A critical section that runs synchronous
  // subprocesses therefore has to declare a stale window long enough to cover
  // itself, or a concurrent process breaks the lock and both proceed.
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
    return { locked: true, value: fn() };
  } finally {
    try { release(); } catch { /* lock already released or broken */ }
  }
}
