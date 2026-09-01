import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import {
  test as tapsmithTest,
  describe as tapsmithDescribe,
  beforeAll as tapsmithBeforeAll,
  beforeEach as tapsmithBeforeEach,
  collectResults,
  _internal,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import type { SessionPreflightContext } from '../session-preflight.js';
import type { PreparedState } from '../app-reset.js';
import { Tracing } from '../trace/tracing.js';
import { getActiveTraceCollector } from '../trace/trace-collector.js';

const { pushContext, popContext, runSuiteContext } = _internal;

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    testMatch: [],
    daemonAddress: 'localhost:50051',
    rootDir: '/proj',
    outputDir: 'out',
    workers: 1,
    launchEmulators: false,
    package: 'com.example.app',
    platform: 'android',
    ...overrides,
  };
}

/**
 * A device double that satisfies both the runner (waitForIdle, tracing) and
 * the session-preflight context (restart/clear/launch/… + client ping).
 * Android: ensureSessionReady = waitForIdle → getUiHierarchy → currentPackage.
 */
function makeDevice() {
  const calls: string[] = [];
  const record = (name: string) => vi.fn(async (..._args: unknown[]) => { calls.push(name); });
  const device = {
    tracing: new Tracing(async () => undefined, async () => undefined),
    waitForIdle: vi.fn(async () => {}),
    startAgent: record('startAgent'),
    terminateApp: record('terminateApp'),
    launchApp: record('launchApp'),
    restartApp: record('restartApp'),
    clearAppData: record('clearAppData'),
    restoreAppState: record('restoreAppState'),
    openDeepLink: record('openDeepLink'),
    _resetApp: vi.fn(async (_pkg: string, opts: { mode?: 'warm' | 'restart' | 'clear'; forceCold?: boolean }) => {
      const mode = opts.mode ?? 'warm';
      calls.push(`resetApp:${mode}`);
      return {
        modeRequested: mode, modeUsed: mode, fellBack: false, coldLaunch: mode !== 'warm',
        durationMs: 5, hooksDetected: false, steps: [{ name: mode, durationMs: 5, ok: true }],
      };
    }),
    currentPackage: vi.fn(async () => 'com.example.app'),
    getByText: vi.fn(() => ({ tap: vi.fn(async () => undefined) })),
    pressBack: vi.fn(async () => {}),
    getAppState: vi.fn(async () => 'foreground' as const),
    _stopDeviceLogStream: vi.fn(),
    _startDeviceLogStream: vi.fn(),
    _startDaemonLogStream: vi.fn(),
    _stopDaemonLogStream: vi.fn(),
    _setForceColdDeepLinks: vi.fn(),
  };
  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
      errorMessage: '',
    })),
  };
  return { device, client, calls };
}

function makeOpts(d: ReturnType<typeof makeDevice>, config: TapsmithConfig, extra: Partial<RunOptions> = {}): RunOptions {
  const sessionContext: SessionPreflightContext = {
    label: 'test',
    config,
    device: d.device as unknown as SessionPreflightContext['device'],
    client: d.client as unknown as SessionPreflightContext['client'],
  };
  return {
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner double
    device: d.device as any,
    sessionContext,
    resetCapabilities: {},
    ...extra,
  };
}

/** Mimic the real Device recording a lifecycle call into the active collector. */
function recordAction(action: string): void {
  getActiveTraceCollector()?.addActionEvent({
    category: 'device', action, duration: 1, success: true,
    hasScreenshotBefore: false, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
  });
}

/** Device-level reset calls only (drop readiness-check noise). */
function resetCalls(d: ReturnType<typeof makeDevice>): string[] {
  return d.calls.filter((c) => !['startAgent'].includes(c));
}

describe('runner app reset (declared isolation)', () => {
  it('default policy: one clear reset per file, before beforeAll hooks, attributed to the first test', async () => {
    const d = makeDevice();
    const order: string[] = [];
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      order.push('clear'); d.calls.push(`resetApp:${opts.mode}`);
      return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });

    pushContext();
    tapsmithBeforeAll(async () => { order.push('beforeAll'); });
    tapsmithTest('one', async () => { order.push('one'); });
    tapsmithTest('two', async () => { order.push('two'); });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
    expect(order).toEqual(['clear', 'beforeAll', 'one', 'two']);
    expect(resetCalls(d)).toEqual(['resetApp:clear']);
    const [first, second] = collectResults(result);
    // setupMs is only recorded when non-zero; with instant mocks it may be 0.
    expect(first.setupMs ?? 0).toBeGreaterThanOrEqual(0);
    expect(first.durationMs).toBeGreaterThanOrEqual(first.setupMs ?? 0);
    expect(second.setupMs).toBeUndefined();
  });

  it('runs no reset without a sessionContext (embedders that own isolation, unit tests)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    const opts = makeOpts(d, makeConfig());
    delete opts.sessionContext;
    const result = await runSuiteContext(ctx, '', [], [], opts);

    expect(result.tests[0].status).toBe('passed');
    expect(resetCalls(d)).toEqual([]);
  });

  it('appResetScope: test resets before every test and again on each retry', async () => {
    const d = makeDevice();
    let attempts = 0;
    pushContext();
    tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('first attempt fails'); });
    tapsmithTest('stable', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
      appReset: 'restart', appResetScope: 'test', retries: 1,
    })));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
    // flaky: attempt 0 + retry; stable: once. No file-level reset for a
    // test-scoped policy without beforeAll hooks.
    expect(resetCalls(d)).toEqual(['resetApp:restart', 'resetApp:restart', 'resetApp:restart']);
    expect(d.device._setForceColdDeepLinks).toHaveBeenCalledWith(true);
    // The retry attempt asks for a cold delivery explicitly.
    expect(d.device._resetApp.mock.calls.map((c) => c[1].forceCold)).toEqual([false, true, false]);
  });

  it('per-test resets record in an APP RESET group ahead of BEFORE EACH', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-pertest-'));
    const d = makeDevice();
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      recordAction('resetApp');
      return { modeRequested: opts.mode ?? 'warm', modeUsed: 'restart', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });
    try {
      pushContext();
      tapsmithBeforeEach(async () => { recordAction('tap'); });
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot, appReset: 'restart', appResetScope: 'test',
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      })));
      const zip = unzipSync(fs.readFileSync(result.tests[0].tracePath!));
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const ordered = events.filter((e) => e.type === 'action' || e.type === 'group-start' || e.type === 'group-end')
        .map((e) => e.type === 'action' ? `action:${e.action}` : `${e.type}:${e.name}`);
      expect(ordered.slice(0, 6)).toEqual([
        'group-start:App reset', 'action:resetApp', 'group-end:App reset',
        'group-start:beforeEach Hooks', 'action:tap', 'group-end:beforeEach Hooks',
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('test-scoped policy still resets at file entry when the file has beforeAll hooks', async () => {
    const d = makeDevice();
    const order: string[] = [];
    d.device._resetApp.mockImplementation(async () => {
      order.push('restart');
      return { modeRequested: 'restart', modeUsed: 'restart', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });
    pushContext();
    tapsmithBeforeAll(async () => { order.push('beforeAll'); });
    tapsmithTest('one', async () => { order.push('one'); });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ appReset: 'restart', appResetScope: 'test' })));

    expect(order).toEqual(['restart', 'beforeAll', 'restart', 'one']);
  });

  it('auto isolation with in-app hooks: one warm reset per file (per-test is an explicit opt-in)', async () => {
    const d = makeDevice();
    const order: string[] = [];
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      order.push(`reset:${opts.mode}`);
      return { modeRequested: opts.mode ?? 'warm', modeUsed: 'warm', fellBack: false, coldLaunch: false, durationMs: 5, hooksDetected: true, steps: [] };
    });
    pushContext();
    tapsmithDescribe('shared setup', () => {
      tapsmithBeforeAll(async () => { order.push('beforeAll'); });
      tapsmithTest('one', async () => { order.push('one'); });
      tapsmithTest('two', async () => { order.push('two'); });
    });
    tapsmithDescribe('independent', () => {
      tapsmithTest('three', async () => { order.push('three'); });
      tapsmithTest('four', async () => { order.push('four'); });
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      resetCapabilities: { hooksDetected: true },
    }));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    // One warm reset at file entry; the nested describes declare no policy of
    // their own, so nothing resets between tests (per-test isolation is an
    // explicit `appResetScope: 'test'` opt-in).
    expect(order).toEqual([
      'reset:warm', 'beforeAll', 'one', 'two', 'three', 'four',
    ]);
  });

  it('a nested describe with appState restores (never pm clear) and resolves the path against rootDir', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('logged out', async () => {});
    tapsmithDescribe('authenticated', () => {
      tapsmithTest.use({ appState: './auth.tar.gz' });
      tapsmithTest('logged in', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed', 'passed']);
    expect(resetCalls(d)).toEqual([
      'resetApp:clear',                  // root: clear (daemon ladder)
      'restoreAppState', 'restartApp',   // nested: restore (never pm clear)
    ]);
    expect(d.device.restoreAppState).toHaveBeenCalledWith('com.example.app', path.resolve('/proj', './auth.tar.gz'));
  });

  it('appState "" in a nested describe clears again; the same policy does not re-reset', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithDescribe('same policy', () => {
      tapsmithTest('a', async () => {});
    });
    tapsmithDescribe('fresh', () => {
      tapsmithTest.use({ appState: '' });
      tapsmithTest('b', async () => {});
    });
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    expect(resetCalls(d)).toEqual(['resetApp:clear', 'resetApp:clear']);
  });

  it('a prepared device satisfying the policy skips the reset (first file after launch)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();
    const prepared: PreparedState = {
      policy: { mode: 'clear', scope: 'file' }, preparedAt: Date.now(), durationMs: 1200, source: 'startup launch',
    };
    const holder = { current: prepared };

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), { _prepared: holder }));

    expect(result.tests[0].status).toBe('passed');
    expect(resetCalls(d)).toEqual([]);
    expect(d.client.ping).toHaveBeenCalled();       // readiness still verified
    expect(holder.current).toBeUndefined();          // consumed exactly once
  });

  it('a nested describe that resets first consumes the prepared device (root scope did not reset)', async () => {
    const d = makeDevice();
    const prepared = { current: { policy: { mode: 'warm' as const, scope: 'test' as const }, preparedAt: Date.now(), durationMs: 1000, source: 'background preparation' } };
    pushContext();
    // Root: hooks detected → auto per-test → no root reset. The describe has
    // a beforeAll → per-file → resets on entry; that reset is the file's first
    // and must use the prepared device instead of resetting again.
    tapsmithDescribe('shared setup', () => {
      tapsmithBeforeAll(async () => {});
      tapsmithTest('one', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), {
      resetCapabilities: { hooksDetected: true },
      _prepared: prepared,
    }));

    expect(collectResults(result).map((t) => t.status)).toEqual(['passed']);
    expect(resetCalls(d)).toEqual([]);
    expect(prepared.current).toBeUndefined();
  });

  it('a prepared device that does not satisfy the policy is ignored (appState wins)', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest.use({ appState: '/abs/auth.tar.gz' });
    tapsmithTest('one', async () => {});
    const ctx = popContext();
    const holder = { current: { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: 0, durationMs: 0, source: 'x' } };

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig(), { _prepared: holder }));

    expect(resetCalls(d)).toEqual(['restoreAppState', 'restartApp']);
  });

  it('appReset: none only verifies the session', async () => {
    const d = makeDevice();
    pushContext();
    tapsmithTest('one', async () => {});
    const ctx = popContext();

    await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({ appReset: 'none' })));

    expect(resetCalls(d)).toEqual([]);
    expect(d.client.ping).toHaveBeenCalled();
  });

  it('a failing reset fails every test in the scope with the reset error', async () => {
    const d = makeDevice();
    d.device._resetApp.mockRejectedValue(new Error('pm clear failed'));
    pushContext();
    tapsmithTest('one', async () => {});
    tapsmithTest('two', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig()));

    const flat = collectResults(result);
    expect(flat.map((t) => t.status)).toEqual(['failed', 'failed']);
    expect(flat[0].error?.message).toContain('pm clear failed');
  });

  it('test.use() rejects unknown appReset values', () => {
    pushContext();
    expect(() => tapsmithTest.use({ appReset: 'bogus' as never })).toThrow(/appReset must be one of/);
    expect(() => tapsmithTest.use({ appResetScope: 'sometimes' as never })).toThrow(/appResetScope must be one of/);
    popContext();
  });

  it('records the reset in its own APP RESET group ahead of BEFORE ALL, with policy metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-'));
    const d = makeDevice();
    // The real Device records each lifecycle call as a traced action into the
    // active collector; mimic that so the group has children (empty groups
    // are dropped from traces by design).
    d.device._resetApp.mockImplementation(async (_pkg, opts) => {
      d.calls.push(`resetApp:${opts.mode}`);
      getActiveTraceCollector()?.addActionEvent({
        category: 'device', action: 'resetApp', duration: 1, success: true, detail: 'cleared app data and relaunched, 0.0s',
        hasScreenshotBefore: false, hasScreenshotAfter: false, hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
      return { modeRequested: 'clear', modeUsed: 'clear', fellBack: false, coldLaunch: true, durationMs: 5, hooksDetected: false, steps: [] };
    });
    try {
      pushContext();
      tapsmithBeforeAll(async () => { recordAction('tap'); });
      tapsmithTest('one', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot,
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      })));

      const tracePath = result.tests[0].tracePath;
      expect(tracePath).toBeDefined();
      const zip = unzipSync(fs.readFileSync(tracePath!));
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const groups = events.filter((e) => e.type === 'group-start').map((e) => e.name);
      // The reset is a sibling section *before* the hooks group — not nested
      // inside it (the actions panel renders groups as flat headers, so a
      // nested group would swallow the hook's own actions) and not mixed into
      // BEFORE ALL (which holds only the user's hook code).
      expect(groups.slice(0, 2)).toEqual(['App reset', 'beforeAll Hooks']);
      const ordered = events.filter((e) => e.type === 'action' || e.type === 'group-start' || e.type === 'group-end')
        .map((e) => e.type === 'action' ? `action:${e.action}` : `${e.type}:${e.name}`);
      expect(ordered.slice(0, 6)).toEqual([
        'group-start:App reset', 'action:resetApp', 'group-end:App reset',
        'group-start:beforeAll Hooks', 'action:tap', 'group-end:beforeAll Hooks',
      ]);
      const metadata = JSON.parse(new TextDecoder().decode(zip['metadata.json']));
      expect(metadata).toMatchObject({ appReset: 'clear', appResetScope: 'file' });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('records a summary row when the reset was satisfied by a prepared device', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-appreset-prepared-'));
    const d = makeDevice();
    try {
      pushContext();
      tapsmithTest('one', async () => {});
      const ctx = popContext();
      const holder = { current: { policy: { mode: 'clear' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' } };

      const result = await runSuiteContext(ctx, '', [], [], makeOpts(d, makeConfig({
        rootDir: tempRoot,
        trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
      }), { _prepared: holder }));

      const zip = unzipSync(fs.readFileSync(result.tests[0].tracePath!));
      const events = new TextDecoder().decode(zip['trace.json']).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      const summary = events.find((e) => e.type === 'action' && e.action === 'appReset');
      expect(summary).toMatchObject({ origin: 'prepared', category: 'device' });
      expect(summary.detail).toMatch(/satisfied by startup launch/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
