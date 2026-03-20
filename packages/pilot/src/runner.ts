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

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PilotConfig } from './config.js';
import type { Device } from './device.js';
import type { PilotReporter } from './reporter.js';
import { flushSoftErrors } from './expect.js';
import { FixtureRegistry, resolveFixtures, type FixtureDefinitions, type BuiltinFixtures } from './fixtures.js';
import { resolveTraceConfig } from './trace/types.js';
import { shouldRecord, shouldRetain } from './trace/trace-mode.js';
import { packageTrace } from './trace/trace-packager.js';
import type { TraceCollector } from './trace/trace-collector.js';

// ─── Result types ───

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  name: string;
  fullName: string;
  status: TestStatus;
  durationMs: number;
  error?: Error;
  screenshotPath?: string;
  /** Path to the trace archive, if recorded. */
  tracePath?: string;
  /** Index of the worker that ran this test (only set in parallel mode). */
  workerIndex?: number;
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

type HookFn = ((fixtures: TestFixtures) => void | Promise<void>) | (() => void | Promise<void>);

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
let activeFixtureRegistry: FixtureRegistry = new FixtureRegistry();

/** Get the current fixture registry (used by the runner). */
export function getFixtureRegistry(): FixtureRegistry {
  return activeFixtureRegistry;
}

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
  /**
   * Create a new test function with additional fixtures.
   *
   * ```ts
   * const test = base.extend<{ auth: Device }>({
   *   auth: [async ({ device }, use) => {
   *     await loginHelper(device)
   *     await use(device)
   *   }, { scope: 'worker' }],
   * })
   * ```
   */
  extend: <T extends Record<string, unknown>>(
    definitions: FixtureDefinitions<T, BuiltinFixtures & T>,
  ) => TestFn;
}

export interface DescribeFn {
  (name: string, fn: () => void): void;
  only: (name: string, fn: () => void) => void;
  skip: (name: string, fn: () => void) => void;
}

function createTestFn(registry: FixtureRegistry): TestFn {
  const fn: TestFn = Object.assign(
    (name: string, testFn: TestCallback) => {
      currentContext().tests.push({ name, fn: testFn, only: false, skip: false });
    },
    {
      only: (name: string, testFn: TestCallback) => {
        currentContext().tests.push({ name, fn: testFn, only: true, skip: false });
      },
      skip: (name: string, testFn: TestCallback) => {
        currentContext().tests.push({ name, fn: testFn, only: false, skip: true });
      },
      extend: <T extends Record<string, unknown>>(
        definitions: FixtureDefinitions<T, BuiltinFixtures & T>,
      ): TestFn => {
        const childRegistry = new FixtureRegistry();
        childRegistry.register(definitions);
        const merged = registry.merge(childRegistry);
        activeFixtureRegistry = merged;
        return createTestFn(merged);
      },
    },
  );
  return fn;
}

export const test: TestFn = createTestFn(activeFixtureRegistry);

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

// ─── Helpers ───

function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── Runner engine ───

export interface RunOptions {
  config: PilotConfig;
  device?: Device;
  screenshotDir?: string;
  reporter?: PilotReporter;
  beforeEachTest?: (fullName: string) => Promise<void>;
  abortFileOnError?: (error: Error) => boolean;
  /** Pre-resolved worker-scoped fixture values (set by worker-runner). */
  workerFixtures?: Record<string, unknown>;
  /** Test file path — used by trace packager for testFile metadata and source inclusion. */
  testFilePath?: string;
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

// Dispatch based on Function.length (parameter count). Note: fn.length does
// not count parameters with default values or rest parameters, so hooks like
// `async ({ device } = {}) => …` would be mis-classified as zero-arg. In
// practice this is fine because hooks are simple `async ({ device }) => …`.
async function invokeHook(fn: HookFn, device?: Device): Promise<void> {
  if (fn.length > 0 && device) {
    await (fn as (fixtures: TestFixtures) => void | Promise<void>)({ device });
  } else {
    await (fn as () => void | Promise<void>)();
  }
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
    await invokeHook(hook, opts.device);
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
      const skippedResult: TestResult = {
        name: entry.name,
        fullName,
        status: 'skipped',
        durationMs: 0,
      };
      result.tests.push(skippedResult);
      opts.reporter?.onTestEnd?.(skippedResult);
      continue;
    }

    const testStart = Date.now();
    let status: TestStatus = 'passed';
    let error: Error | undefined;
    let screenshotPath: string | undefined;
    let tracePath: string | undefined;
    // 2x the assertion timeout: a test may have multiple actions, each with
    // their own timeout. The test-level timeout is a safety net against hangs.
    const testTimeoutMs = opts.config.timeout * 2;

    // Trace recording — start if configured
    const traceConfig = resolveTraceConfig(opts.config.trace);
    const attempt = 0; // TODO: wire up retry count when retries are implemented
    const recording = shouldRecord(traceConfig.mode, attempt);
    let traceCollector: TraceCollector | null = null;

    if (recording && opts.device) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-'));
      traceCollector = opts.device.tracing._startManaged(traceConfig, tempDir);

      // Start network capture if configured
      if (traceConfig.network) {
        try {
          await opts.device._startNetworkCapture();
        } catch {
          // Network capture is best-effort
        }
      }
    }

    try {
      const testBody = async () => {
        // Run beforeEach hooks
        traceCollector?.startGroup('Before Hooks');
        if (opts.beforeEachTest) {
          await opts.beforeEachTest(fullName);
        }

        for (const hook of allBeforeEach) {
          await invokeHook(hook, opts.device);
        }
        traceCollector?.endGroup();

        // Build fixture context: base (device) + worker-scoped + test-scoped
        const registry = getFixtureRegistry();
        const baseFixtures: Record<string, unknown> = {
          ...(opts.device ? { device: opts.device } : {}),
          ...(opts.workerFixtures ?? {}),
        };

        let testFixtureTeardown: (() => Promise<void>) | undefined;
        let allFixtures = baseFixtures;

        if (!registry.isEmpty) {
          const resolved = await resolveFixtures(registry, 'test', baseFixtures);
          allFixtures = resolved.fixtures;
          testFixtureTeardown = resolved.teardown;
        }

        traceCollector?.startGroup('Test');
        try {
          // Call with fixtures if the test function expects arguments
          if (entry.fn.length > 0) {
            await (entry.fn as (fixtures: Record<string, unknown>) => void | Promise<void>)(allFixtures);
          } else {
            await (entry.fn as () => void | Promise<void>)();
          }
        } finally {
          traceCollector?.endGroup();
          if (testFixtureTeardown) {
            await testFixtureTeardown();
          }
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
      if (allAfterEach.length > 0) {
        traceCollector?.startGroup('After Hooks');
        for (const hook of allAfterEach) {
          try {
            await invokeHook(hook, opts.device);
          } catch {
            // afterEach errors should not mask test errors
          }
        }
        traceCollector?.endGroup();
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

    // Finalize trace recording
    if (traceCollector && opts.device) {
      // Stop network capture and collect raw entries
      let rawNetworkEntries: Awaited<ReturnType<typeof opts.device._stopNetworkCapture>>['entries'] | undefined;
      if (traceConfig.network) {
        try {
          const res = await opts.device._stopNetworkCapture();
          if (res.success && res.entries.length > 0) {
            rawNetworkEntries = res.entries;
          }
        } catch {
          // Network capture is best-effort
        }
      }

      const collector = opts.device.tracing._stopManaged();

      // Map network entries, associating each with the closest preceding action
      let networkEntries: import('./trace/types.js').NetworkEntry[] | undefined;
      if (rawNetworkEntries && collector) {
        // Build sorted list of action timestamps with their indices
        const actionTimestamps = collector.events
          .filter((e): e is import('./trace/types.js').ActionTraceEvent | import('./trace/types.js').AssertionTraceEvent =>
            e.type === 'action' || e.type === 'assertion')
          .map((e) => ({ timestamp: e.timestamp, actionIndex: e.actionIndex }));

        const findActionIndex = (startTimeMs: number): number => {
          let best = 0;
          for (const a of actionTimestamps) {
            if (a.timestamp <= startTimeMs) {
              best = a.actionIndex;
            }
          }
          return best;
        };

        networkEntries = rawNetworkEntries.map((e, i) => ({
          index: i,
          actionIndex: findActionIndex(e.startTimeMs),
          startTime: e.startTimeMs,
          endTime: e.startTimeMs + e.durationMs,
          method: e.method,
          url: e.url,
          status: e.statusCode,
          contentType: e.contentType,
          requestSize: e.requestSize,
          responseSize: e.responseSize,
          duration: e.durationMs,
          requestHeaders: e.requestHeadersJson ? JSON.parse(e.requestHeadersJson) : {},
          responseHeaders: e.responseHeadersJson ? JSON.parse(e.responseHeadersJson) : {},
        }));
      }
      if (collector) {
        const retain = shouldRetain(traceConfig.mode, status === 'passed', attempt);
        if (retain) {
          try {
            const outputDir = path.resolve(
              opts.config.rootDir,
              opts.config.outputDir,
              'traces',
            );
            const version = getPackageVersion();
            const sourceFiles = opts.testFilePath && traceConfig.sources
              ? [opts.testFilePath]
              : undefined;
            tracePath = packageTrace(collector, {
              testFile: opts.testFilePath ?? '',
              testName: fullName,
              testStatus: status,
              testDuration: Date.now() - testStart,
              startTime: testStart,
              endTime: Date.now(),
              device: {
                serial: opts.config.device ?? 'unknown',
                isEmulator: (opts.config.device ?? '').startsWith('emulator-'),
              },
              pilotVersion: version,
              error: error?.message,
              outputDir,
              sourceFiles,
              networkEntries,
            });
          } catch {
            // Trace packaging is best-effort
          }
        }
        collector.cleanup();
      }
    }

    const testResult: TestResult = {
      name: entry.name,
      fullName,
      status,
      durationMs: Date.now() - testStart,
      error,
      screenshotPath,
      tracePath,
    };
    result.tests.push(testResult);
    opts.reporter?.onTestEnd?.(testResult);

    if (status === 'failed' && error && opts.abortFileOnError?.(error)) {
      throw error;
    }
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
      await invokeHook(hook, opts.device);
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
  // Reset context and fixture registry
  contextStack = [];
  activeFixtureRegistry = new FixtureRegistry();
  pushContext();

  // Import the test file — this registers tests/suites via side effects
  // and may call test.extend() to register fixtures.
  // Note: Node.js caches ESM imports, so the same file path cannot be
  // re-imported in the same process. Each worker runs each file at most once.
  await import(filePath);

  const rootCtx = popContext();
  const registry = getFixtureRegistry();

  // Resolve worker-scoped fixtures once for the entire file
  const baseFixtures: Record<string, unknown> = opts.device ? { device: opts.device } : {};
  let workerFixtures: Record<string, unknown> = opts.workerFixtures ?? {};
  let workerTeardown: (() => Promise<void>) | undefined;

  if (!registry.isEmpty) {
    const resolved = await resolveFixtures(registry, 'worker', {
      ...baseFixtures,
      ...workerFixtures,
    });
    workerFixtures = resolved.fixtures;
    workerTeardown = resolved.teardown;
  }

  const fileOpts: RunOptions = { ...opts, workerFixtures, testFilePath: filePath };

  try {
    return await runSuiteContext(rootCtx, '', [], [], fileOpts);
  } finally {
    if (workerTeardown) {
      await workerTeardown();
    }
  }
}
