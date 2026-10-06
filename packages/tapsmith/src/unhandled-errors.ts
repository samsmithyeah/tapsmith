// ─── Unhandled errors during a test file (PILOT-543) ───
//
// A promise a test never awaits — typically `const p = device.waitForResponse(…)`
// followed by a step that fails before `await p` — can reject after nothing is
// listening for it. Node reports that as an `unhandledRejection`, and before
// this module every run path died of it: the sequential CLI's fatal handler
// tore the run down without a summary, and the worker, UI-mode and watch
// children (which install no handler) crashed on Node's default.
//
// Playwright ties such errors to the test that is running: its worker routes
// `unhandledRejection` and `uncaughtException` to the current test and fails
// that test only. The runner does the same here. While `runTestFile` runs it
// owns both process events; an error is recorded on the active *error scope*
// — a test attempt, or a scope's beforeAll hooks — and fails it there. With no
// scope open (afterAll hooks, the runner's own work between tests) it is
// printed, as an afterAll hook's error is, and the run carries on.
//
// Outside `runTestFile` nothing changes: the CLI's fatal handlers (which ask
// `runnerOwnsUnhandledErrors()` first) still tear a crashed run down cleanly.

/** Errors raised, unhandled, while a test attempt or a beforeAll phase ran. */
export interface ErrorScope {
  readonly errors: Error[];
}

let ownerCount = 0;
let activeScope: ErrorScope | undefined;
let activeFile: string | undefined;

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(`Unhandled rejection with a non-Error value: ${describeValue(reason)}`);
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(kind: 'rejection' | 'exception', reason: unknown): void {
  const err = toError(reason);
  if (activeScope) {
    activeScope.errors.push(err);
    return;
  }
  const where = activeFile ? ` in ${activeFile}` : '';
  process.stderr.write(
    `[tapsmith] Unhandled ${kind} outside a test${where} (not attributed to any test):\n`
    + `${err.stack ?? err.message}\n`,
  );
}

const onUnhandledRejection = (reason: unknown): void => record('rejection', reason);
const onUncaughtException = (err: Error): void => record('exception', err);

/**
 * Take ownership of `unhandledRejection` / `uncaughtException` for the length
 * of a test file. Returns the release function; nested ownership is counted,
 * so the listeners come off only when the last owner releases.
 */
export function ownUnhandledErrors(filePath: string | undefined): () => void {
  if (ownerCount++ === 0) {
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
  }
  const previousFile = activeFile;
  activeFile = filePath;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFile = previousFile;
    if (--ownerCount === 0) {
      activeScope = undefined;
      process.removeListener('unhandledRejection', onUnhandledRejection);
      process.removeListener('uncaughtException', onUncaughtException);
    }
  };
}

/**
 * True while a test file is running in this process: its unhandled errors are
 * the runner's to attribute, so a process-wide fatal handler must leave them be.
 */
export function runnerOwnsUnhandledErrors(): boolean {
  return ownerCount > 0;
}

/**
 * Open a scope that collects the unhandled errors raised until it is closed.
 * Scopes do not nest: opening one replaces any other, and closing a scope
 * that is no longer the active one leaves the active one in place.
 */
export function openErrorScope(): ErrorScope {
  const scope: ErrorScope = { errors: [] };
  activeScope = scope;
  return scope;
}

/** Stop collecting into `scope` and return what it collected. */
export function closeErrorScope(scope: ErrorScope): Error[] {
  if (activeScope === scope) activeScope = undefined;
  return scope.errors;
}

/**
 * Fold a test attempt's unhandled errors into its outcome. The attempt's own
 * error, if it failed, stays the headline (it is usually the cause — the step
 * that failed before the waiter it left behind); a passing attempt fails with
 * the first unhandled error. Any others are listed after it.
 */
export function mergeUnhandledErrors(
  error: Error | undefined,
  unhandled: readonly Error[],
): Error | undefined {
  const extra = unhandled.filter((e) => e !== error);
  if (extra.length === 0) return error;
  const primary = error ?? extra.shift()!;
  if (extra.length > 0) {
    const details = extra.map((e) => `Unhandled error during the test: ${e.message}`).join('\n');
    primary.message += `\n\n--- Additionally ---\n${details}`;
  }
  return primary;
}
