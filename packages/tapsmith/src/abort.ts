// ─── Abort primitives (PILOT-222) ───
//
// Shared cancellation helpers used to make a user-initiated stop take
// effect immediately: the runner sets an AbortSignal on the gRPC client,
// in-flight RPCs are cancelled, and polling loops bail between ticks.

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const ABORT_ERROR_BRAND = Symbol.for('tapsmith.AbortError');

/**
 * Thrown when a test run is stopped by the user (or the file is being
 * abandoned after an unrecoverable error). Distinguishable from ordinary
 * failures so callers can skip retries, recovery, and failure screenshots.
 */
/**
 * The message a user-requested stop leaves on the test it ended.
 *
 * Both transports classify a stopped test by this string, so it lives here
 * rather than being spelled out at each site: a stop that reads as a failure
 * in one transport and as interrupted in the other is exactly the divergence
 * this constant exists to prevent.
 */
export const STOPPED_BY_USER = 'Stopped by user';

export class TestAbortedError extends Error {
  /** @internal */
  readonly [ABORT_ERROR_BRAND] = true;

  constructor(message: string = STOPPED_BY_USER) {
    super(message);
    this.name = 'AbortError';
  }
}

/** Returns true if `err` is a {@link TestAbortedError} (brand-based, safe across CJS/ESM copies). */
export function isAbortError(err: unknown): err is TestAbortedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[ABORT_ERROR_BRAND] === true
  );
}

/** Throws {@link TestAbortedError} if the signal has already fired. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TestAbortedError();
}

/**
 * Abortable setTimeout: resolves after `ms`, or rejects with
 * {@link TestAbortedError} as soon as `signal` fires. The abort listener is
 * removed when the timer settles, so long-lived signals don't accumulate
 * listeners across poll ticks.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new TestAbortedError());
  return new Promise<void>((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TestAbortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
