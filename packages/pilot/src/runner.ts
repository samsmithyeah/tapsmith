/**
 * Minimal test runner for Pilot.
 *
 * Supports:
 *   - test(name, fn) / test.only / test.skip
 *   - describe(name, fn) / describe.only / describe.skip
 *   - beforeAll, afterAll, beforeEach, afterEach hooks
 *   - Sequential execution with proper error reporting
 *   - Screenshot capture on failure
 *   - Timing information
 */

import type { PilotConfig } from './config.js';
import type { Device } from './device.js';
import { flushSoftErrors } from './expect.js';

// ─── Result types ───

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  name: string;
  fullName: string;
  status: TestStatus;
  durationMs: number;
  error?: Error;
  screenshotPath?: string;
}

export interface SuiteResult {
  name: string;
  tests: TestResult[];
  suites: SuiteResult[];
  durationMs: number;
}

// ─── Fixtures ───

export interface TestFixtures {
  device: Device;
}

// ─── Internal registration types ───

type HookFn = () => void | Promise<void>;

/** Test functions can either take fixtures or no arguments. */
type TestCallback = ((fixtures: TestFixtures) => void | Promise<void>) | (() => void | Promise<void>);

interface TestEntry {
  name: string;
  fn: TestCallback;
  only: boolean;
  skip: boolean;
}

interface SuiteEntry {
  name: string;
  fn: () => void;
  only: boolean;
  skip: boolean;
}

// ─── Global registration state ───

interface SuiteContext {
  tests: TestEntry[];
  suites: SuiteEntry[];
  beforeAll: HookFn[];
  afterAll: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
}

let contextStack: SuiteContext[] = [];

function currentContext(): SuiteContext {
  return contextStack[contextStack.length - 1];
}

function pushContext(): SuiteContext {
  const ctx: SuiteContext = {
    tests: [],
    suites: [],
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
  };
  contextStack.push(ctx);
  return ctx;
}

function popContext(): SuiteContext {
  return contextStack.pop()!;
}

// ─── Public registration API ───

export interface TestFn {
  (name: string, fn: TestCallback): void;
  only: (name: string, fn: TestCallback) => void;
  skip: (name: string, fn: TestCallback) => void;
}

export interface DescribeFn {
  (name: string, fn: () => void): void;
  only: (name: string, fn: () => void) => void;
  skip: (name: string, fn: () => void) => void;
}

export const test: TestFn = Object.assign(
  (name: string, fn: TestCallback) => {
    currentContext().tests.push({ name, fn, only: false, skip: false });
  },
  {
    only: (name: string, fn: TestCallback) => {
      currentContext().tests.push({ name, fn, only: true, skip: false });
    },
    skip: (name: string, fn: TestCallback) => {
      currentContext().tests.push({ name, fn, only: false, skip: true });
    },
  },
);

export const describe: DescribeFn = Object.assign(
  (name: string, fn: () => void) => {
    currentContext().suites.push({ name, fn, only: false, skip: false });
  },
  {
    only: (name: string, fn: () => void) => {
      currentContext().suites.push({ name, fn, only: true, skip: false });
    },
    skip: (name: string, fn: () => void) => {
      currentContext().suites.push({ name, fn, only: false, skip: true });
    },
  },
);

export function beforeAll(fn: HookFn): void {
  currentContext().beforeAll.push(fn);
}

export function afterAll(fn: HookFn): void {
  currentContext().afterAll.push(fn);
}

export function beforeEach(fn: HookFn): void {
  currentContext().beforeEach.push(fn);
}

export function afterEach(fn: HookFn): void {
  currentContext().afterEach.push(fn);
}

// ─── Runner engine ───

export interface RunOptions {
  config: PilotConfig;
  device?: Device;
  screenshotDir?: string;
}

async function captureFailureScreenshot(
  device: Device | undefined,
  screenshotDir: string | undefined,
  testName: string,
): Promise<string | undefined> {
  if (!device || !screenshotDir) return undefined;
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(screenshotDir, { recursive: true });
    let screenshotTimer: ReturnType<typeof setTimeout>;
    const res = await Promise.race([
      device.takeScreenshot().finally(() => clearTimeout(screenshotTimer)),
      new Promise<never>((_, reject) => {
        screenshotTimer = setTimeout(() => reject(new Error('Screenshot timed out')), 10_000);
      }),
    ]);
    if (res.success && res.data) {
      const safeName = testName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(screenshotDir, `${safeName}-${Date.now()}.png`);
      fs.writeFileSync(filePath, res.data);
      return filePath;
    }
  } catch {
    // screenshot capture is best-effort
  }
  return undefined;
}

async function runSuiteContext(
  ctx: SuiteContext,
  parentPrefix: string,
  parentBeforeEach: HookFn[],
  parentAfterEach: HookFn[],
  opts: RunOptions,
): Promise<SuiteResult> {
  const result: SuiteResult = { name: parentPrefix, tests: [], suites: [], durationMs: 0 };
  const suiteStart = Date.now();

  // Determine if any test/suite in this context uses `.only`
  const hasOnlyTests = ctx.tests.some((t) => t.only);
  const hasOnlySuites = ctx.suites.some((s) => s.only);
  const hasOnly = hasOnlyTests || hasOnlySuites;

  // Run beforeAll hooks
  for (const hook of ctx.beforeAll) {
    await hook();
  }

  // All beforeEach hooks (inherited + local)
  const allBeforeEach = [...parentBeforeEach, ...ctx.beforeEach];
  const allAfterEach = [...ctx.afterEach, ...parentAfterEach];

  // Run tests
  for (const entry of ctx.tests) {
    const fullName = parentPrefix ? `${parentPrefix} > ${entry.name}` : entry.name;

    // Determine if this test should be skipped
    const shouldSkip = entry.skip || (hasOnly && !entry.only);

    if (shouldSkip) {
      result.tests.push({
        name: entry.name,
        fullName,
        status: 'skipped',
        durationMs: 0,
      });
      continue;
    }

    const testStart = Date.now();
    let status: TestStatus = 'passed';
    let error: Error | undefined;
    let screenshotPath: string | undefined;
    // 2x the assertion timeout: a test may have multiple actions, each with
    // their own timeout. The test-level timeout is a safety net against hangs.
    const testTimeoutMs = opts.config.timeout * 2;

    try {
      const testBody = async () => {
        // Run beforeEach hooks
        for (const hook of allBeforeEach) {
          await hook();
        }

        // Call with fixtures if the test function expects arguments
        if (entry.fn.length > 0 && opts.device) {
          await (entry.fn as (fixtures: TestFixtures) => void | Promise<void>)({ device: opts.device });
        } else {
          await (entry.fn as () => void | Promise<void>)();
        }
      };

      // Wrap test execution with a timeout to prevent tests from hanging forever
      let testTimer: ReturnType<typeof setTimeout>;
      await Promise.race([
        testBody().finally(() => clearTimeout(testTimer)),
        new Promise<never>((_, reject) => {
          testTimer = setTimeout(() => reject(new Error(
            `Test timed out after ${testTimeoutMs}ms`
          )), testTimeoutMs);
        }),
      ]);
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err : new Error(String(err));

      // Screenshot on failure
      if (opts.config.screenshot !== 'never') {
        screenshotPath = await captureFailureScreenshot(
          opts.device,
          opts.screenshotDir,
          fullName,
        );
      }
    } finally {
      // Run afterEach hooks (always)
      for (const hook of allAfterEach) {
        try {
          await hook();
        } catch {
          // afterEach errors should not mask test errors
        }
      }
    }

    // Collect soft assertion failures (PILOT-43)
    const softErrors = flushSoftErrors();
    if (softErrors.length > 0) {
      const messages = softErrors.map((e) => e.message).join('\n');
      const softErrorSummary = `${softErrors.length} soft assertion(s) failed:\n${messages}`;

      if (status !== 'failed') {
        status = 'failed';
        error = new Error(softErrorSummary);
      } else if (error) {
        error.message += `\n\n--- Additionally ---\n${softErrorSummary}`;
      }

      if (!screenshotPath && opts.config.screenshot !== 'never') {
        screenshotPath = await captureFailureScreenshot(
          opts.device,
          opts.screenshotDir,
          fullName,
        );
      }
    }

    // Screenshot on success if mode is "always"
    if (status === 'passed' && opts.config.screenshot === 'always') {
      screenshotPath = await captureFailureScreenshot(
        opts.device,
        opts.screenshotDir,
        fullName,
      );
    }

    result.tests.push({
      name: entry.name,
      fullName,
      status,
      durationMs: Date.now() - testStart,
      error,
      screenshotPath,
    });
  }

  // Run child suites
  for (const suiteEntry of ctx.suites) {
    const shouldSkip = suiteEntry.skip || (hasOnly && !suiteEntry.only && !hasOnlyTests);

    if (shouldSkip) {
      // Mark all tests in skipped suite as skipped (we still need to discover them)
      pushContext();
      suiteEntry.fn();
      const childCtx = popContext();
      const prefix = parentPrefix ? `${parentPrefix} > ${suiteEntry.name}` : suiteEntry.name;
      const skippedResult = skipAll(childCtx, prefix);
      result.suites.push(skippedResult);
      continue;
    }

    pushContext();
    suiteEntry.fn();
    const childCtx = popContext();
    const prefix = parentPrefix ? `${parentPrefix} > ${suiteEntry.name}` : suiteEntry.name;
    const childResult = await runSuiteContext(childCtx, prefix, allBeforeEach, allAfterEach, opts);
    result.suites.push(childResult);
  }

  // Run afterAll hooks
  for (const hook of ctx.afterAll) {
    try {
      await hook();
    } catch {
      // afterAll errors are logged but don't fail individual tests
    }
  }

  result.durationMs = Date.now() - suiteStart;
  return result;
}

function skipAll(ctx: SuiteContext, prefix: string): SuiteResult {
  const result: SuiteResult = { name: prefix, tests: [], suites: [], durationMs: 0 };
  for (const t of ctx.tests) {
    const fullName = prefix ? `${prefix} > ${t.name}` : t.name;
    result.tests.push({ name: t.name, fullName, status: 'skipped', durationMs: 0 });
  }
  for (const s of ctx.suites) {
    pushContext();
    s.fn();
    const childCtx = popContext();
    const childPrefix = prefix ? `${prefix} > ${s.name}` : s.name;
    result.suites.push(skipAll(childCtx, childPrefix));
  }
  return result;
}

/**
 * Collect all test results flattened from a suite tree.
 */
export function collectResults(suite: SuiteResult): TestResult[] {
  const results: TestResult[] = [...suite.tests];
  for (const child of suite.suites) {
    results.push(...collectResults(child));
  }
  return results;
}

/**
 * Run a single test file. The file is imported (which registers tests via the
 * global `test` / `describe` functions), then executed sequentially.
 */
export async function runTestFile(
  filePath: string,
  opts: RunOptions,
): Promise<SuiteResult> {
  // Reset context
  contextStack = [];
  pushContext();

  // Import the test file — this registers tests/suites via side effects
  await import(filePath);

  const rootCtx = popContext();
  return runSuiteContext(rootCtx, '', [], [], opts);
}
