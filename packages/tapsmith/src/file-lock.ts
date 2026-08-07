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

/**
 * Run `fn` while holding an exclusive lock on `file`.
 *
 * Returns `fn`'s result, or `undefined` when the lock could not be acquired —
 * callers decide whether to skip the work or proceed unlocked.
 */
export function withFileLockSync<T>(
  file: string,
  fn: () => T,
  options?: { attempts?: number; waitMs?: number },
): T | undefined {
  const attempts = options?.attempts ?? DEFAULT_ATTEMPTS;
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;

  let release: (() => void) | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      release = lockfile.lockSync(file, { stale: STALE_MS });
      break;
    } catch (err) {
      // ENOENT means the target vanished — retrying cannot help.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(file)) return undefined;
      if (attempt === attempts - 1) return undefined;
      sleepSync(waitMs);
    }
  }
  if (!release) return undefined;

  try {
    return fn();
  } finally {
    try { release(); } catch { /* lock already released or broken */ }
  }
}
