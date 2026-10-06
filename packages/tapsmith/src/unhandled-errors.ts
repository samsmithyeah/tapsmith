// ─── Unhandled errors during a test file (PILOT-543) ───
//
// A promise a test never awaits — typically `const p = device.waitForResponse(…)`
// followed by a step that fails before `await p` — can reject after nothing is
// listening for it. Node reports that as an `unhandledRejection`, and before
// this module every run path died of it: the sequential CLI's fatal handler
// tore the run down without a summary, and the worker, UI-mode and watch
// children (which install no handler) crashed on Node's default.
//
// Playwright ties such errors to the test that is running and fails that test
// only. The runner does the same here. While `runTestFile` runs it owns
// `unhandledRejection`; a rejection is recorded on the active *error scope* —
// a test attempt, or a scope's beforeAll hooks — and fails it there. With no
// scope open (afterAll hooks, the runner's own work between tests), or when it
// was left behind by a test that has already ended, it is printed, as an
// afterAll hook's error is, and the run carries on.
//
// Uncaught exceptions are deliberately not taken over. A rejection nobody
// handles is, by definition, awaited by nothing, so recording it holds nothing
// up; an exception thrown from a callback can be the callback that would have
// settled a promise a hook is awaiting — hooks have no timeout — and
// swallowing it would turn a loud crash into a silent hang.
//
// Outside `runTestFile` nothing changes: the CLI's fatal handler (which asks
// `runnerClaimsUnhandledRejection()` first) still tears a crashed run down cleanly.

import { currentAttemptToken, isTestEndedError, type AttemptToken } from './attempt-fence.js';

/** Errors raised, unhandled, while a test attempt or a beforeAll phase ran. */
export interface ErrorScope {
  readonly errors: Error[];
  /** The attempt-fence token of the test attempt this scope belongs to. */
  attempt?: AttemptToken;
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

/**
 * Whether the calling async context is a test body that has already ended.
 * Node runs `unhandledRejection` listeners in the async context of the
 * promise that rejected, so for a rejection this tells a leftover of an
 * ended test — an action it forgot to await, failing late — from an error
 * of whatever is running now.
 */
function isLeftoverOfEndedTest(): boolean {
  const origin = currentAttemptToken();
  return origin?.closed === true && origin !== activeScope?.attempt;
}

function report(err: Error, what: string): void {
  process.stderr.write(
    `[tapsmith] Unhandled rejection ${what}, not attributed to any test:\n`
    + `${err.stack ?? err.message}\n`,
  );
}

function onUnhandledRejection(reason: unknown): void {
  const where = activeFile ? ` in ${activeFile}` : '';
  // A device call the attempt fence refused, from a test that has already
  // ended — typically an action it did not await, still retrying when the
  // test finished. Never a failure of the test running now; its message is
  // all there is to say (the stack is the fence's own).
  if (isTestEndedError(reason)) {
    process.stderr.write(
      `[tapsmith] A call from a test that has already ended${where} was refused`
      + ' (an action the test did not await?), not attributed to any test.\n',
    );
    return;
  }
  const fromEndedTest = isLeftoverOfEndedTest();
  if (ownerCount === 0 && !fromEndedTest) {
    // Not a test's: what happens without this module. Another listener (the
    // CLI's fatal teardown) handles it; with none, crash as Node would.
    if (process.listenerCount('unhandledRejection') === 1) throw reason;
    return;
  }
  const err = toError(reason);
  if (activeScope && !fromEndedTest) {
    activeScope.errors.push(err);
    return;
  }
  report(err, fromEndedTest
    ? `from a test that has already ended${where} (a call it did not await?)`
    : `outside a test${where}`);
}

let listenerInstalled = false;

/**
 * Take ownership of `unhandledRejection` for the length of a test file.
 * Returns the release function; nested ownership is counted.
 *
 * The listener itself stays installed once a file has run: an action the
 * file's last test forgot to await can fail after the file ends, and must be
 * reported as that test's leftover rather than crash the process.
 */
export function ownUnhandledErrors(filePath: string | undefined): () => void {
  if (!listenerInstalled) {
    listenerInstalled = true;
    process.on('unhandledRejection', onUnhandledRejection);
  }
  ownerCount++;
  const previousFile = activeFile;
  activeFile = filePath;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeFile = previousFile;
    if (--ownerCount === 0) activeScope = undefined;
  };
}

/**
 * True when the runner reports this rejection itself — it happened while a
 * test file ran, or it is a leftover of (or a call refused from) a test that
 * has already ended — so a
 * process-wide fatal handler must leave it be. Call it from an
 * `unhandledRejection` listener (it reads the rejecting promise's context).
 */
export function runnerClaimsUnhandledRejection(reason: unknown): boolean {
  return ownerCount > 0 || isTestEndedError(reason) || isLeftoverOfEndedTest();
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
