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
import type { PilotConfig, UseOptions } from './config.js';
import type { Device } from './device.js';
import type { PilotReporter } from './reporter.js';
import { APIRequestContext } from './api-request.js';
import { flushSoftErrors } from './expect.js';
import { FixtureRegistry, resolveFixtures, type FixtureDefinitions, type BuiltinFixtures } from './fixtures.js';
import { resolveTraceConfig } from './trace/types.js';
import { shouldRecord, shouldRetain } from './trace/trace-mode.js';
import { packageTrace } from './trace/trace-packager.js';
import { TraceCollector, setActiveTraceCollector, withActiveTraceCollector } from './trace/trace-collector.js';
import type { AnyTraceEvent } from './trace/types.js';
import { getSimulatorScreenScale } from './ios-simulator.js';

// ─── Result types ───

/**
 * Warnings emitted by the daemon's `start_network_capture` that the
 * runner has already printed once this process. Keeps repeating
 * "Network capture disabled: …" from polluting the per-test output in
 * a run where the underlying cause (e.g. SE not approved) is the same
 * for every test.
 */
const _printedCaptureWarnings = new Set<string>();

function _warnCaptureOnce(prefix: string, msg: string): void {
  const key = `${prefix}:${msg}`;
  if (_printedCaptureWarnings.has(key)) return;
  _printedCaptureWarnings.add(key);
  console.warn(`[pilot] ${prefix}: ${msg}`);
}

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
  /** Project name this test belongs to (only set when projects are configured). */
  project?: string;
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
  /** API request context for making HTTP calls during tests. */
  request: APIRequestContext;
  /** Name of the project running this test, if projects are configured. */
  projectName?: string;
}

// ─── Per-scope option overrides ───

// UseOptions is defined in config.ts (where PilotConfig lives) to avoid circular deps.
// Re-exported here for backward compatibility.
export type { UseOptions } from './config.js';

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
  useOptions?: UseOptions;
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
   * Override configuration options for all tests in the current describe scope.
   * Overrides cascade — inner describe blocks inherit and can further override.
   *
   * ```ts
   * describe("slow screen", () => {
   *   test.use({ timeout: 60000 })
   *   test("animation completes", async ({ device }) => { ... })
   * })
   * ```
   */
  use: (options: UseOptions) => void;
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
      use: (options: UseOptions) => {
        if (options.timeout !== undefined && options.timeout <= 0) {
          throw new Error('test.use() timeout must be a positive number');
        }
        if (options.retries !== undefined && options.retries < 0) {
          throw new Error('test.use() retries must be a non-negative number');
        }
        const ctx = currentContext();
        ctx.useOptions = { ...ctx.useOptions, ...options };
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
  /**
   * Notification fired before tracing/group starts so UI mode can tag
   * subsequent trace events to this test. Must be lightweight (no device
   * actions) — it runs outside the beforeEach trace group.
   */
  onTestStart?: (fullName: string) => Promise<void>;
  /**
   * Setup work that runs inside the beforeEach trace group. Use this for
   * any device actions (e.g. session readiness checks) so they appear
   * grouped in the trace viewer instead of as ungrouped top-level events.
   */
  beforeEachTest?: (fullName: string) => Promise<void>;
  abortFileOnError?: (error: Error) => boolean;
  /** Pre-resolved worker-scoped fixture values (set by worker-runner). */
  workerFixtures?: Record<string, unknown>;
  /** Test file path — used by trace packager for testFile metadata and source inclusion. */
  testFilePath?: string;
  /** Project-level use options applied as a base layer under file-level test.use(). */
  projectUseOptions?: UseOptions;
  /** Project name — stamped on test results for reporter grouping. */
  projectName?: string;
  /** Run only the test whose fullName matches this value. All other tests are skipped. */
  testFilter?: string;
  /** Called with mapped network entries after capture stops. Used by UI mode for live streaming. */
  onNetworkEntries?: (entries: import('./trace/types.js').NetworkEntry[]) => void;
  /**
   * Append a unique query parameter to the dynamic import URL so Node.js
   * treats it as a new module. Required by persistent processes (UI workers)
   * that re-run the same file — without this, the ESM cache returns the
   * stale first import and no tests are registered.
   */
  bustImportCache?: boolean;
  /** When aborted, skip remaining tests but still run afterEach/afterAll hooks. */
  abortSignal?: AbortSignal;
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
async function invokeHook(fn: HookFn, device?: Device, projectName?: string): Promise<void> {
  if (fn.length > 0 && device) {
    // Hooks receive device + projectName; request fixture is test-scoped only.
    await (fn as (fixtures: { device: Device; projectName?: string }) => void | Promise<void>)({ device, projectName });
  } else {
    await (fn as () => void | Promise<void>)();
  }
}

/**
 * Replay saved beforeAll trace events through a test's event callback.
 * Reads screenshots from the beforeAll collector's temp dir so they appear
 * in the UI for every test, not just the first.
 */
function replayBeforeAllEvents(
  testCollector: TraceCollector,
  events: readonly AnyTraceEvent[],
  beforeAllCollector: TraceCollector | null,
  hierarchies: Map<number, { before?: string; after?: string }>,
): void {
  const cb = testCollector.getEventCallback();
  if (!cb) return;
  const screenshotDir = beforeAllCollector
    ? path.join(beforeAllCollector.tempDir, 'screenshots')
    : null;

  for (const event of events) {
    if ((event.type === 'action' || event.type === 'assertion') && screenshotDir) {
      const pad = String(event.actionIndex).padStart(3, '0');
      const beforePath = path.join(screenshotDir, `action-${pad}-before.png`);
      const afterPath = path.join(screenshotDir, `action-${pad}-after.png`);
      const captures: {
        before?: Buffer; after?: Buffer;
        hierarchyBefore?: string; hierarchyAfter?: string;
      } = {};
      try { if (fs.existsSync(beforePath)) captures.before = fs.readFileSync(beforePath); } catch { /* best-effort */ }
      try { if (fs.existsSync(afterPath)) captures.after = fs.readFileSync(afterPath); } catch { /* best-effort */ }
      const hier = hierarchies.get(event.actionIndex);
      if (hier?.before) captures.hierarchyBefore = hier.before;
      if (hier?.after) captures.hierarchyAfter = hier.after;
      cb(event, captures);
    } else {
      cb(event);
    }
  }
}

async function runSuiteContext(
  ctx: SuiteContext,
  parentPrefix: string,
  parentBeforeEach: HookFn[],
  parentAfterEach: HookFn[],
  parentOpts: RunOptions,
): Promise<SuiteResult> {
  // Apply test.use() overrides for this scope (cascading from parent).
  // `timeout` is handled separately via the device — it should only affect
  // assertion/action auto-wait, not the test-level safety timeout.
  // `appState` is handled below (restore before hooks).
  const { timeout: scopeTimeout, appState: scopeAppState, ...configOverrides } = ctx.useOptions ?? {};
  const opts: RunOptions = Object.keys(configOverrides).length > 0
    ? { ...parentOpts, config: { ...parentOpts.config, ...configOverrides } }
    : parentOpts;

  // Propagate timeout override to the device so assertion auto-wait uses it
  const prevDeviceTimeout = scopeTimeout && opts.device
    ? opts.device._getDefaultTimeout()
    : undefined;
  if (scopeTimeout && opts.device) {
    opts.device._setDefaultTimeout(scopeTimeout);
  }

  const result: SuiteResult = { name: parentPrefix, tests: [], suites: [], durationMs: 0 };
  const suiteStart = Date.now();

  // try/finally ensures device timeout is restored even if a hook or
  // abortFileOnError throws. Body intentionally not re-indented.
  try {

  // Restore or clear app state if test.use({ appState }) was specified for this scope.
  // Mirrors Playwright's storageState: tests start already authenticated.
  // - appState: './path.tar.gz' → restore saved state
  // - appState: '' → clear app data (fresh unauthenticated state)
  if (scopeAppState !== undefined && opts.device && opts.config.package) {
    if (scopeAppState) {
      // Resolve relative paths against rootDir so the daemon can find the archive
      // regardless of its own working directory.
      const resolvedPath = path.isAbsolute(scopeAppState)
        ? scopeAppState
        : path.resolve(opts.config.rootDir, scopeAppState);
      await opts.device.restoreAppState(opts.config.package, resolvedPath);
    } else {
      await opts.device.clearAppData(opts.config.package);
    }
    await opts.device.restartApp(opts.config.package);
  }

  // Determine if any test/suite in this context uses `.only`
  const hasOnlyTests = ctx.tests.some((t) => t.only);
  const hasOnlySuites = ctx.suites.some((s) => s.only);
  const hasOnly = hasOnlyTests || hasOnlySuites;

  // Run beforeAll hooks with tracing. We create a standalone collector
  // (via setActiveTraceCollector) that Device._traceCollector falls back to.
  // This is simpler than managing the Tracing-managed collector lifecycle.
  //
  // After beforeAll completes, we save the recorded events so they can be
  // replayed into each test's trace. This ensures beforeAll actions are
  // visible for every test in the suite (UI mode + trace viewer).
  let beforeAllCollector: TraceCollector | null = null;
  let beforeAllFirstFullName: string | undefined;
  if (ctx.beforeAll.length > 0 && opts.device) {
    const traceConfig = resolveTraceConfig(opts.config.trace);
    if (shouldRecord(traceConfig.mode, 0)) {
      // Pick the test to tag beforeAll trace events with. When running a
      // single test (testFilter), use that test so we don't mark an
      // unrelated test as 'running' in the UI.
      const targetTest = opts.testFilter
        ? ctx.tests.find((t) => {
            const fn = parentPrefix ? `${parentPrefix} > ${t.name}` : t.name;
            return fn === opts.testFilter;
          })
        : ctx.tests.find((t) => !t.skip);
      if (targetTest && opts.onTestStart) {
        beforeAllFirstFullName = parentPrefix ? `${parentPrefix} > ${targetTest.name}` : targetTest.name;
        await opts.onTestStart(beforeAllFirstFullName);
      }
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-ba-'));
      // Trigger _startManaged to fire the monkey-patch (ui-run.ts sets up
      // the event callback), then transfer the callback to a standalone
      // collector and clear the managed one.
      const managedCollector = opts.device.tracing._startManaged(traceConfig, tempDir);
      beforeAllCollector = new TraceCollector(traceConfig, tempDir);
      const cb = managedCollector.getEventCallback();
      if (cb) beforeAllCollector.setEventCallback(cb);
      opts.device.tracing._stopManaged();

      beforeAllCollector.startGroup('beforeAll Hooks');
    }
  }
  try {
    if (beforeAllCollector) {
      await withActiveTraceCollector(beforeAllCollector, async () => {
        for (const hook of ctx.beforeAll) {
          await invokeHook(hook, opts.device, opts.projectName);
        }
      });
      beforeAllCollector.endGroup();
    } else {
      for (const hook of ctx.beforeAll) {
        await invokeHook(hook, opts.device, opts.projectName);
      }
    }
  } catch (err) {
    // beforeAll failed — mark all tests in this context as failed and bail out.
    // This prevents a single beforeAll error from crashing the entire runner.
    const beforeAllError = err instanceof Error ? err : new Error(String(err));

    // Capture a screenshot so the user can see the device state at the time
    // of failure — otherwise beforeAll errors are text-only with no visual
    // context for debugging.
    let beforeAllScreenshot: string | undefined;
    if (opts.config.screenshot !== 'never') {
      const label = parentPrefix ? `beforeAll_${parentPrefix}` : 'beforeAll';
      beforeAllScreenshot = await captureFailureScreenshot(opts.device, opts.screenshotDir, label);
    }

    // Package whatever the beforeAll collector recorded into a trace ZIP.
    // The trace captures every action that ran before the failure — invaluable
    // for debugging why beforeAll couldn't find an element or timed out.
    let beforeAllTrace: string | undefined;
    if (beforeAllCollector) {
      try {
        beforeAllCollector.endGroup();
        const outputDir = path.resolve(opts.config.rootDir, opts.config.outputDir, 'traces');
        const label = parentPrefix || 'beforeAll';
        beforeAllTrace = packageTrace(beforeAllCollector, {
          testFile: opts.testFilePath ?? '',
          testName: label,
          testStatus: 'failed',
          testDuration: Date.now() - suiteStart,
          startTime: suiteStart,
          endTime: Date.now(),
          device: {
            serial: opts.config.device ?? 'unknown',
            isEmulator: (opts.config.device ?? '').startsWith('emulator-'),
            devicePixelRatio: opts.config.platform === 'ios' && opts.config.device
              ? getSimulatorScreenScale(opts.config.device)
              : undefined,
          },
          pilotVersion: getPackageVersion(),
          error: beforeAllError.message,
          outputDir,
          project: opts.projectName,
        });
      } catch {
        // Trace packaging is best-effort
      }
      beforeAllCollector.cleanup();
    }

    const failed = failAll(ctx, parentPrefix, beforeAllError, opts.projectName, beforeAllScreenshot, beforeAllTrace);
    for (const tr of collectResults(failed)) {
      result.tests.push(tr);
      opts.reporter?.onTestEnd?.(tr);
    }
    result.durationMs = Date.now() - suiteStart;
    return result;
  }

  // Save beforeAll events for replay into each test's trace.
  const savedBeforeAllEvents = beforeAllCollector ? beforeAllCollector.events.slice() : [];
  const beforeAllActionCount = beforeAllCollector ? beforeAllCollector.currentActionIndex : 0;
  // Build hierarchy lookup for replay (hierarchies are in-memory, not on disk)
  const beforeAllHierarchies = new Map<number, { before?: string; after?: string }>();
  if (beforeAllCollector) {
    for (const h of beforeAllCollector.hierarchies) {
      const match = h.archivePath.match(/action-(\d+)-(before|after)\.xml/);
      if (match) {
        const idx = parseInt(match[1]);
        const position = match[2];
        const entry = beforeAllHierarchies.get(idx) ?? {};
        if (position === 'before') entry.before = h.xml;
        else entry.after = h.xml;
        beforeAllHierarchies.set(idx, entry);
      }
    }
  }

  // All beforeEach hooks (inherited + local)
  const allBeforeEach = [...parentBeforeEach, ...ctx.beforeEach];
  const allAfterEach = [...ctx.afterEach, ...parentAfterEach];

  // Run tests
  for (const entry of ctx.tests) {
    const fullName = parentPrefix ? `${parentPrefix} > ${entry.name}` : entry.name;

    // Determine if this test should be skipped.
    // testFilter matches either an exact test name or a describe prefix.
    const filteredOut = opts.testFilter
      && fullName !== opts.testFilter
      && !fullName.startsWith(opts.testFilter + ' > ');
    const shouldSkip = entry.skip || (hasOnly && !entry.only) || filteredOut
      || opts.abortSignal?.aborted;

    if (shouldSkip) {
      const skippedResult: TestResult = {
        name: entry.name,
        fullName,
        status: 'skipped',
        durationMs: 0,
        project: opts.projectName,
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
    // Safety timeout for the test body (hooks run outside this).
    // 3x the assertion timeout gives headroom for tests with multiple
    // device operations (clearAppData, launchApp, openDeepLink, etc.)
    // that each include their own internal waits.
    const testTimeoutMs = opts.config.timeout * 3;

    // Trace recording — start if configured
    const traceConfig = resolveTraceConfig(opts.config.trace);
    const attempt = 0; // TODO: wire up retry count when retries are implemented
    const recording = shouldRecord(traceConfig.mode, attempt);
    let traceCollector: TraceCollector | null = null;

    if (recording && opts.device) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-'));
      traceCollector = opts.device.tracing._startManaged(traceConfig, tempDir);
      setActiveTraceCollector(traceCollector);

      // Offset action index so per-test actions don't collide with beforeAll
      if (beforeAllActionCount > 0) {
        traceCollector.setActionIndexOffset(beforeAllActionCount);
      }

      // Start network capture if configured. PILOT-182: iOS traffic
      // routing is now fully owned by pilot-core via the macOS Network
      // Extension redirector, so there's no CLI-side proxy setup.
      //
      // The daemon may surface a non-fatal warning (e.g. "SE not approved
      // — run pilot setup-ios") via the `errorMessage` field even when
      // `success` is true and the proxy port was allocated. We log it
      // loudly (once per run — same failure applies to every test) so
      // users whose trace has no network entries know exactly why and
      // exactly what to do.
      if (traceConfig.network) {
        try {
          const res = await opts.device._startNetworkCapture();
          if (!res.success && res.errorMessage) {
            _warnCaptureOnce('Network capture disabled', res.errorMessage);
          } else if (res.errorMessage) {
            _warnCaptureOnce('Network capture warning', res.errorMessage);
          }
        } catch (err) {
          _warnCaptureOnce(
            'Network capture failed to start',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Create request fixture outside try so it's accessible in trace finalization
    const requestContext = new APIRequestContext({
      baseURL: opts.config.baseURL,
      extraHTTPHeaders: opts.config.extraHTTPHeaders,
    });

    try {
      // ── Setup phase (not subject to test timeout) ──
      // Hooks and fixture resolution run outside the test timeout so that
      // slow operations like restartApp() under heavy load don't eat into
      // the budget for the actual test assertions.

      // Notify UI mode (lightweight, no device actions) so subsequent trace
      // events can be tagged to this test. Must run before the group starts
      // so the test-start message arrives before any group-start events.
      if (opts.onTestStart) {
        await opts.onTestStart(fullName);
      }

      // Replay beforeAll events into this test's trace stream.
      // For the first test (which received beforeAll's live-streamed events),
      // skip replay to avoid duplicates.
      if (fullName !== beforeAllFirstFullName && savedBeforeAllEvents.length > 0 && traceCollector) {
        replayBeforeAllEvents(traceCollector, savedBeforeAllEvents, beforeAllCollector, beforeAllHierarchies);
      }

      // Open the beforeEach group before running setup work and hooks.
      // Heavy setup (session readiness, idle waits, user beforeEach hooks)
      // is captured inside this group so device actions don't appear as
      // ungrouped top-level events in the trace viewer.
      const hasBeforeEachWork =
        !!opts.beforeEachTest || !!opts.device || allBeforeEach.length > 0;
      if (hasBeforeEachWork) {
        traceCollector?.startGroup('beforeEach Hooks');
      }

      // Setup work that may issue device actions (e.g. ensureSessionReady
      // in UI worker mode). Runs inside the beforeEach group.
      if (opts.beforeEachTest) {
        await opts.beforeEachTest(fullName);
      }

      // Wait for the device to be idle before each test. This ensures
      // previous test actions (toasts, animations, async operations) have
      // settled before hooks and assertions start, preventing flakiness
      // under load (e.g. parallel workers sharing host CPU).
      if (opts.device) {
        try {
          await opts.device.waitForIdle();
        } catch {
          // Best effort — don't fail the test if idle wait times out
        }
      }

      for (const hook of allBeforeEach) {
        await invokeHook(hook, opts.device, opts.projectName);
      }
      if (hasBeforeEachWork) {
        traceCollector?.endGroup();
      }

      // Build fixture context: base (device + request) + worker-scoped + test-scoped
      const registry = getFixtureRegistry();
      const baseFixtures: Record<string, unknown> = {
        ...(opts.device ? { device: opts.device } : {}),
        request: requestContext,
        ...(opts.projectName != null ? { projectName: opts.projectName } : {}),
        ...(opts.workerFixtures ?? {}),
      };

      let testFixtureTeardown: (() => Promise<void>) | undefined;
      let allFixtures = baseFixtures;

      if (!registry.isEmpty) {
        const resolved = await resolveFixtures(registry, 'test', baseFixtures);
        allFixtures = resolved.fixtures;
        testFixtureTeardown = resolved.teardown;
      }

      // ── Test body (subject to test timeout) ──
      const testFn = async () => {
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
          requestContext.dispose();
        }
      };

      // Wrap only the test body with a timeout — hooks run outside this
      // so slow setup (restartApp, navigation) under load doesn't cause
      // spurious timeouts.
      let testTimer: ReturnType<typeof setTimeout>;
      await Promise.race([
        testFn().finally(() => clearTimeout(testTimer)),
        new Promise<never>((_, reject) => {
          testTimer = setTimeout(() => reject(new Error(
            `Test timed out after ${testTimeoutMs}ms`
          )), testTimeoutMs);
        }),
      ]);
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err : new Error(String(err));

      // Fail any in-flight traced action/assertion so it appears in the trace
      traceCollector?.failPendingOperation(error.message);

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
        traceCollector?.startGroup('afterEach Hooks');
        for (const hook of allAfterEach) {
          try {
            await invokeHook(hook, opts.device, opts.projectName);
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
          if (res.success) {
            // Apply user-supplied host allowlist, if any. On physical iOS
            // the Wi-Fi proxy is system-wide and captures every app's
            // traffic — this is how users scrub system services (captive
            // portal, analytics, iCloud) out of their trace archives.
            // On simulators the macOS Network Extension redirector
            // already filters per-PID, so the allowlist is usually
            // redundant for sim runs but still honoured when set.
            const { filterEntriesByHosts } = await import('./trace/filter-hosts.js');
            rawNetworkEntries = filterEntriesByHosts(res.entries, traceConfig.networkHosts);
            if (
              traceConfig.networkHosts &&
              traceConfig.networkHosts.length > 0 &&
              res.entries.length > 0 &&
              rawNetworkEntries.length === 0
            ) {
              console.warn(
                `[pilot] trace.networkHosts allowlist matched 0 of ${res.entries.length} captured entries — trace will have no network data.`,
              );
            }
          } else {
            console.warn(`[pilot] Network capture stopped with error: ${res.errorMessage}`);
          }
        } catch (err) {
          console.warn(`[pilot] Failed to stop network capture: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Capture a final screenshot so the last action has an "after" view.
      // The trace viewer uses the next action's before-screenshot as "after",
      // so this provides the terminal state.
      if (traceCollector.config.screenshots) {
        const tracing = opts.device!.tracing;
        const { actionIndex: finalIdx } = await traceCollector.captureBeforeAction(
          tracing['_getScreenshot'],
          tracing['_getHierarchy'],
        );
        // Flush to UI mode live stream — emit a lightweight event so the
        // screenshot buffer reaches the frontend.
        traceCollector.emitPendingCaptures(finalIdx);
      }

      const collector = opts.device.tracing._stopManaged();
      setActiveTraceCollector(null);

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
          requestBody: e.requestBody,
          responseBody: e.responseBody,
        }));

      }

      // Merge API request fixture network entries (test-level HTTP calls)
      const apiEntries = requestContext.getNetworkEntries();
      if (apiEntries.length > 0) {
        const deviceEntries = networkEntries ?? [];
        const offset = deviceEntries.length;
        const mappedApiEntries = apiEntries.map((e, i) => ({
          ...e,
          index: offset + i,
        }));
        networkEntries = [...deviceEntries, ...mappedApiEntries];
      }

      // Notify UI mode with the full set of network entries (device + API)
      if (networkEntries && opts.onNetworkEntries) {
        opts.onNetworkEntries(networkEntries);
      }
      if (collector) {
        const retain = shouldRetain(traceConfig.mode, status === 'passed', attempt);
        if (retain) {
          // Flush any pending after-action captures before packaging
          await collector.flushPendingCaptures();
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
                devicePixelRatio: opts.config.platform === 'ios' && opts.config.device
                  ? getSimulatorScreenScale(opts.config.device)
                  : undefined,
              },
              pilotVersion: version,
              error: error?.message,
              outputDir,
              sourceFiles,
              networkEntries,
              project: opts.projectName,
              appState: scopeAppState || undefined,
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
      project: opts.projectName,
    };
    result.tests.push(testResult);
    opts.reporter?.onTestEnd?.(testResult);

    if (status === 'failed' && error && opts.abortFileOnError?.(error)) {
      throw error;
    }
  }

  // Run child suites
  for (const suiteEntry of ctx.suites) {
    const shouldSkip = suiteEntry.skip || (hasOnly && !suiteEntry.only && !hasOnlyTests)
      || opts.abortSignal?.aborted;

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

  // Run afterAll hooks with tracing (same pattern as beforeAll).
  // Events are streamed to the UI tagged with the last test that ran.
  if (ctx.afterAll.length > 0 && opts.device) {
    const traceConfig = resolveTraceConfig(opts.config.trace);
    if (shouldRecord(traceConfig.mode, 0)) {
      // Find the last test that actually ran (not skipped/filtered) to tag events.
      // Must account for testFilter and .only so we don't tag with a test that didn't run.
      const lastRunTest = [...ctx.tests].reverse().find((t) => {
        if (t.skip) return false;
        if (hasOnly && !t.only) return false;
        if (opts.testFilter) {
          const fn = parentPrefix ? `${parentPrefix} > ${t.name}` : t.name;
          if (fn !== opts.testFilter && !fn.startsWith(opts.testFilter + ' > ')) return false;
        }
        return true;
      });
      if (lastRunTest && opts.onTestStart) {
        const lastFullName = parentPrefix ? `${parentPrefix} > ${lastRunTest.name}` : lastRunTest.name;
        await opts.onTestStart(lastFullName);
      }
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-aa-'));
      const managedCollector = opts.device.tracing._startManaged(traceConfig, tempDir);
      const afterAllCollector = new TraceCollector(traceConfig, tempDir);
      const cb = managedCollector.getEventCallback();
      if (cb) afterAllCollector.setEventCallback(cb);
      opts.device.tracing._stopManaged();

      afterAllCollector.startGroup('afterAll Hooks');
      await withActiveTraceCollector(afterAllCollector, async () => {
        for (const hook of ctx.afterAll) {
          try {
            await invokeHook(hook, opts.device, opts.projectName);
          } catch {
            // afterAll errors are logged but don't fail individual tests
          }
        }
      });
      afterAllCollector.endGroup();
      afterAllCollector.cleanup();
    } else {
      for (const hook of ctx.afterAll) {
        try {
          await invokeHook(hook, opts.device, opts.projectName);
        } catch {
          // afterAll errors are logged but don't fail individual tests
        }
      }
    }
  } else {
    for (const hook of ctx.afterAll) {
      try {
        await invokeHook(hook, opts.device, opts.projectName);
      } catch {
        // afterAll errors are logged but don't fail individual tests
      }
    }
  }

  // Clean up beforeAll trace temp dir (screenshots are no longer needed)
  if (beforeAllCollector) {
    beforeAllCollector.cleanup();
  }

  } finally {
    // Restore previous device timeout when leaving this scope
    if (prevDeviceTimeout !== undefined && opts.device) {
      opts.device._setDefaultTimeout(prevDeviceTimeout);
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
 * Mark all tests in a context as failed with the given error.
 * Used when beforeAll hooks throw — individual tests never got a chance to run.
 */
function failAll(ctx: SuiteContext, prefix: string, error: Error, project?: string, screenshotPath?: string, tracePath?: string): SuiteResult {
  const result: SuiteResult = { name: prefix, tests: [], suites: [], durationMs: 0 };
  for (const t of ctx.tests) {
    const fullName = prefix ? `${prefix} > ${t.name}` : t.name;
    result.tests.push({ name: t.name, fullName, status: 'failed', durationMs: 0, error, project, screenshotPath, tracePath });
  }
  for (const s of ctx.suites) {
    pushContext();
    s.fn();
    const childCtx = popContext();
    const childPrefix = prefix ? `${prefix} > ${s.name}` : s.name;
    result.suites.push(failAll(childCtx, childPrefix, error, project, screenshotPath, tracePath));
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
  // Node.js caches ESM imports by URL. Persistent processes (UI workers)
  // that re-run the same file must bust the cache with a unique query.
  const importUrl = opts.bustImportCache ? `${filePath}?t=${Date.now()}` : filePath;
  await import(importUrl);

  const rootCtx = popContext();

  // Apply project-level use options as a base layer under file-level test.use()
  if (opts.projectUseOptions) {
    rootCtx.useOptions = { ...opts.projectUseOptions, ...rootCtx.useOptions };
  }

  const registry = getFixtureRegistry();

  // Resolve worker-scoped fixtures once for the entire file
  const baseFixtures: Record<string, unknown> = {
    ...(opts.device ? { device: opts.device } : {}),
    ...(opts.projectName != null ? { projectName: opts.projectName } : {}),
  };
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

// ─── Test discovery (UI mode) ───

export interface DiscoveredTest {
  name: string
  fullName: string
  only: boolean
  skip: boolean
}

export interface DiscoveredSuite {
  name: string
  tests: DiscoveredTest[]
  suites: DiscoveredSuite[]
}

/**
 * Import a test file and collect its test/suite tree without executing
 * any test bodies. Used by UI mode for test discovery.
 */
export async function discoverTestFile(filePath: string): Promise<DiscoveredSuite> {
  contextStack = [];
  activeFixtureRegistry = new FixtureRegistry();
  pushContext();

  // Bust ESM cache so re-discovery in persistent processes (UI workers)
  // picks up file changes instead of returning stale cached modules.
  const importUrl = `${filePath}?t=${Date.now()}`;
  await import(importUrl);

  const rootCtx = popContext();
  return discoverSuiteContext(rootCtx, '');
}

function discoverSuiteContext(ctx: SuiteContext, parentPrefix: string): DiscoveredSuite {
  const tests: DiscoveredTest[] = ctx.tests.map((t) => ({
    name: t.name,
    fullName: parentPrefix ? `${parentPrefix} > ${t.name}` : t.name,
    only: t.only,
    skip: t.skip,
  }));

  const suites: DiscoveredSuite[] = [];
  for (const entry of ctx.suites) {
    const suitePrefix = parentPrefix ? `${parentPrefix} > ${entry.name}` : entry.name;
    // Execute the describe callback to register nested tests/suites
    pushContext();
    entry.fn();
    const childCtx = popContext();
    suites.push(discoverSuiteContext(childCtx, suitePrefix));
  }

  return { name: parentPrefix, tests, suites };
}

/** @internal — exposed for unit testing only. */
export const _internal = { pushContext, popContext, runSuiteContext };
