import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';
import { emitActionProgress } from '../action-progress.js';

// We need to test the runner's registration and execution logic.
// The runner uses module-level state, so we import the internal helpers
// by importing the module and resetting state between tests.
import {
  test as tapsmithTest,
  describe as tapsmithDescribe,
  beforeAll as tapsmithBeforeAll,
  afterAll as tapsmithAfterAll,
  beforeEach as tapsmithBeforeEach,
  afterEach as tapsmithAfterEach,
  collectResults,
  markFileRetryFlakes,
  runTestFile,
  _internal,
  type SuiteResult,
  type TestResult,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { Tracing } from '../trace/tracing.js';
import { getActiveTraceCollector, type TraceCollector } from '../trace/trace-collector.js';
import { isCurrentAttemptClosed } from '../attempt-fence.js';

const { pushContext, popContext, runSuiteContext, resolvePlatformFixture, resetFixtureRegistry } = _internal;

/** Minimal config sufficient for runSuiteContext. */
function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    testMatch: [],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'out',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

/** Minimal RunOptions for test execution. */
function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return { config: makeConfig(), ...overrides };
}

describe('collectResults()', () => {
  it('returns empty array for suite with no tests', () => {
    const suite: SuiteResult = { name: 'root', tests: [], suites: [], durationMs: 0 };
    expect(collectResults(suite)).toEqual([]);
  });

  it('returns tests from a flat suite', () => {
    const suite: SuiteResult = {
      name: 'root',
      tests: [
        { name: 'test1', fullName: 'test1', status: 'passed', durationMs: 10 },
        { name: 'test2', fullName: 'test2', status: 'failed', durationMs: 20 },
      ],
      suites: [],
      durationMs: 30,
    };
    const results = collectResults(suite);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('test1');
    expect(results[1].name).toBe('test2');
  });

  it('flattens nested suites', () => {
    const suite: SuiteResult = {
      name: 'root',
      tests: [
        { name: 'root-test', fullName: 'root-test', status: 'passed', durationMs: 5 },
      ],
      suites: [
        {
          name: 'child',
          tests: [
            { name: 'child-test', fullName: 'child > child-test', status: 'passed', durationMs: 10 },
          ],
          suites: [
            {
              name: 'grandchild',
              tests: [
                {
                  name: 'gc-test',
                  fullName: 'child > grandchild > gc-test',
                  status: 'skipped',
                  durationMs: 0,
                },
              ],
              suites: [],
              durationMs: 0,
            },
          ],
          durationMs: 15,
        },
      ],
      durationMs: 20,
    };
    const results = collectResults(suite);
    expect(results).toHaveLength(3);
    expect(results[0].name).toBe('root-test');
    expect(results[1].name).toBe('child-test');
    expect(results[2].name).toBe('gc-test');
    expect(results[2].status).toBe('skipped');
  });

  it('preserves error information in results', () => {
    const err = new Error('assertion failed');
    const suite: SuiteResult = {
      name: 'root',
      tests: [
        {
          name: 'failing',
          fullName: 'failing',
          status: 'failed',
          durationMs: 100,
          error: err,
        },
      ],
      suites: [],
      durationMs: 100,
    };
    const results = collectResults(suite);
    expect(results[0].error).toBe(err);
    expect(results[0].error?.message).toBe('assertion failed');
  });

  it('preserves screenshotPath in results', () => {
    const suite: SuiteResult = {
      name: 'root',
      tests: [
        {
          name: 'with-screenshot',
          fullName: 'with-screenshot',
          status: 'failed',
          durationMs: 50,
          screenshotPath: '/tmp/screenshot.png',
        },
      ],
      suites: [],
      durationMs: 50,
    };
    const results = collectResults(suite);
    expect(results[0].screenshotPath).toBe('/tmp/screenshot.png');
  });

  it('preserves videoPath in results (PILOT-114)', () => {
    const suite: SuiteResult = {
      name: 'root',
      tests: [
        {
          name: 'with-video',
          fullName: 'with-video',
          status: 'failed',
          durationMs: 50,
          videoPath: '/tmp/with-video-1.mp4',
        },
      ],
      suites: [],
      durationMs: 50,
    };
    const results = collectResults(suite);
    expect(results[0].videoPath).toBe('/tmp/with-video-1.mp4');
  });

  it('handles multiple nested suites at the same level', () => {
    const suite: SuiteResult = {
      name: 'root',
      tests: [],
      suites: [
        {
          name: 'suite-a',
          tests: [{ name: 'a1', fullName: 'suite-a > a1', status: 'passed', durationMs: 1 }],
          suites: [],
          durationMs: 1,
        },
        {
          name: 'suite-b',
          tests: [{ name: 'b1', fullName: 'suite-b > b1', status: 'passed', durationMs: 2 }],
          suites: [],
          durationMs: 2,
        },
      ],
      durationMs: 3,
    };
    const results = collectResults(suite);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('a1');
    expect(results[1].name).toBe('b1');
  });
});

// ─── Test/describe registration ───

describe('test registration API shape', () => {
  it('test is a function', () => {
    expect(typeof tapsmithTest).toBe('function');
  });

  it('test.only is a function', () => {
    expect(typeof tapsmithTest.only).toBe('function');
  });

  it('test.skip is a function', () => {
    expect(typeof tapsmithTest.skip).toBe('function');
  });

  it('describe is a function', () => {
    expect(typeof tapsmithDescribe).toBe('function');
  });

  it('describe.only is a function', () => {
    expect(typeof tapsmithDescribe.only).toBe('function');
  });

  it('describe.skip is a function', () => {
    expect(typeof tapsmithDescribe.skip).toBe('function');
  });

  it('hook functions are functions', () => {
    expect(typeof tapsmithBeforeAll).toBe('function');
    expect(typeof tapsmithAfterAll).toBe('function');
    expect(typeof tapsmithBeforeEach).toBe('function');
    expect(typeof tapsmithAfterEach).toBe('function');
  });
});

// ─── Runner execution via _internal ───

describe('runner execution', () => {
  it('TestResult has the expected shape', () => {
    const result: TestResult = {
      name: 'my test',
      fullName: 'suite > my test',
      status: 'passed',
      durationMs: 42,
    };
    expect(result.name).toBe('my test');
    expect(result.fullName).toBe('suite > my test');
    expect(result.status).toBe('passed');
    expect(result.durationMs).toBe(42);
    expect(result.error).toBeUndefined();
    expect(result.screenshotPath).toBeUndefined();
  });

  it('TestResult can carry error and screenshotPath', () => {
    const result: TestResult = {
      name: 'fail',
      fullName: 'fail',
      status: 'failed',
      durationMs: 100,
      error: new Error('boom'),
      screenshotPath: '/shots/fail.png',
    };
    expect(result.error?.message).toBe('boom');
    expect(result.screenshotPath).toBe('/shots/fail.png');
  });

  it('SuiteResult can contain nested suites and tests', () => {
    const suite: SuiteResult = {
      name: 'outer',
      durationMs: 500,
      tests: [
        { name: 't1', fullName: 'outer > t1', status: 'passed', durationMs: 100 },
      ],
      suites: [
        {
          name: 'inner',
          durationMs: 200,
          tests: [
            { name: 't2', fullName: 'outer > inner > t2', status: 'failed', durationMs: 200, error: new Error('oops') },
          ],
          suites: [],
        },
      ],
    };
    const flat = collectResults(suite);
    expect(flat).toHaveLength(2);
    expect(flat[0].status).toBe('passed');
    expect(flat[1].status).toBe('failed');
  });

  it('runs a simple test via _internal helpers', async () => {
    pushContext();
    tapsmithTest('simple', async () => {});
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts());
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].status).toBe('passed');
  });

  it('passes platform fixture to beforeEach hooks', async () => {
    const seenPlatforms: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    pushContext();
    tapsmithBeforeEach(async ({ platform }) => {
      seenPlatforms.push(platform);
    });
    tapsmithTest('uses platform in hook', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ platform: 'ios' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
      device: mockDevice as any,
    }));

    expect(result.tests[0].status).toBe('passed');
    expect(seenPlatforms).toEqual(['ios']);
  });

  it('passes custom fixtures from test.extend() to beforeEach hooks', async () => {
    const seenValues: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const extended = tapsmithTest.extend<{ greeting: string }>({
        greeting: async (_fixtures, use) => { await use('hello from fixture'); },
      });

      pushContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime fixture injection
      tapsmithBeforeEach(async (fixtures: any) => {
        seenValues.push(fixtures.greeting);
      });
      extended('uses custom fixture in hook', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      expect(seenValues).toEqual(['hello from fixture']);
    } finally {
      resetFixtureRegistry();
    }
  });

  it('passes custom fixtures from test.extend() to afterEach hooks', async () => {
    const seenValues: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const extended = tapsmithTest.extend<{ greeting: string }>({
        greeting: async (_fixtures, use) => { await use('hello after'); },
      });

      pushContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime fixture injection
      tapsmithAfterEach(async (fixtures: any) => {
        seenValues.push(fixtures.greeting);
      });
      extended('custom fixture available in afterEach', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      expect(seenValues).toEqual(['hello after']);
    } finally {
      resetFixtureRegistry();
    }
  });

  it('passes worker-scoped fixtures to beforeAll hooks', async () => {
    const seenValues: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    pushContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime fixture injection
    tapsmithBeforeAll(async (fixtures: any) => {
      seenValues.push(fixtures.workerVal);
    });
    tapsmithTest('after beforeAll with worker fixtures', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ platform: 'android' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
      device: mockDevice as any,
      workerFixtures: { workerVal: 'from-worker' },
    }));

    expect(result.tests[0].status).toBe('passed');
    expect(seenValues).toEqual(['from-worker']);
  });

  it('resolves worker fixtures from extended tests inside describe blocks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-worker-fixtures-'));
    const filePath = path.join(tempDir, 'nested-worker-fixtures.mjs');
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;

    try {
      fs.writeFileSync(filePath, `
        import { test as base, describe } from ${JSON.stringify(runnerUrl)};

        const testA = base.extend({
          workerA: [async ({}, use) => { await use('worker-a'); }, { scope: 'worker' }],
        });
        const testB = base.extend({
          workerB: [async ({}, use) => { await use('worker-b'); }, { scope: 'worker' }],
        });

        describe('nested', () => {
          testA('uses worker A', async ({ workerA }) => {
            if (workerA !== 'worker-a') throw new Error('workerA was ' + workerA);
          });
        });

        testB('uses worker B', async ({ workerB }) => {
          if (workerB !== 'worker-b') throw new Error('workerB was ' + workerB);
        });
      `);

      const result = await runTestFile(pathToFileURL(filePath).href, makeOpts({
        config: makeConfig({ platform: 'android' }),
        bustImportCache: true,
      }));

      expect(collectResults(result).map(t => t.status)).toEqual(['passed', 'passed']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      resetFixtureRegistry();
    }
  });

  it('tears down test fixtures after afterEach hooks', async () => {
    const order: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const extended = tapsmithTest.extend<{ tracked: string }>({
        tracked: async (_fixtures, use) => {
          order.push('fixture-setup');
          await use('value');
          order.push('fixture-teardown');
        },
      });

      pushContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime fixture injection
      tapsmithAfterEach(async (_fixtures: any) => {
        order.push('afterEach');
      });
      extended('teardown order', async () => { order.push('test-body'); });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      expect(order).toEqual(['fixture-setup', 'test-body', 'afterEach', 'fixture-teardown']);
    } finally {
      resetFixtureRegistry();
    }
  });

  it('test.beforeEach() registers hooks same as standalone', async () => {
    const seenPlatforms: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    pushContext();
    tapsmithTest.beforeEach(async ({ platform }) => {
      seenPlatforms.push(platform);
    });
    tapsmithTest('hook via test.beforeEach', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ platform: 'ios' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
      device: mockDevice as any,
    }));

    expect(result.tests[0].status).toBe('passed');
    expect(seenPlatforms).toEqual(['ios']);
  });

  it('warns when a hook destructures a fixture not in the test registry', async () => {
    const warnings: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const testA = tapsmithTest.extend<{ foo: string }>({
        foo: async (_fixtures, use) => { await use('foo-value'); },
      });
      const testB = tapsmithTest.extend<{ bar: string }>({
        bar: async (_fixtures, use) => { await use('bar-value'); },
      });

      pushContext();
      // Register a beforeEach via testA that destructures 'foo'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime fixture mismatch warning
      testA.beforeEach(async ({ foo }: any) => { void foo; });
      // Register a test via testB — its registry has 'bar' but not 'foo'
      testB('test with different fixtures', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      const hookWarning = warnings.find(w => w.includes('fixture "foo" which is not available'));
      expect(hookWarning).toBeDefined();
    } finally {
      process.stderr.write = origWrite;
      resetFixtureRegistry();
    }
  });

  it('test.beforeAll() registers hooks same as standalone beforeAll', async () => {
    const order: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    pushContext();
    tapsmithTest.beforeAll(async () => { order.push('beforeAll'); });
    tapsmithTest('after test.beforeAll', async () => { order.push('test'); });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ platform: 'android' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
      device: mockDevice as any,
    }));

    expect(result.tests[0].status).toBe('passed');
    expect(order).toEqual(['beforeAll', 'test']);
  });

  it('resolves test-scoped fixtures for beforeAll hooks and tears them down', async () => {
    // Playwright parity: each beforeAll gets its own test-fixture scope, set up
    // before the hook and torn down after — so test-scoped fixtures (e.g. page
    // objects) work in beforeAll without being forced to worker scope.
    const order: string[] = [];
    const seen: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const extended = tapsmithTest.extend<{ myScreen: string }>({
        myScreen: async (_fixtures, use) => {
          order.push('setup');
          await use('screen-value');
          order.push('teardown');
        },
      });

      pushContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime fixture injection
      extended.beforeAll(async ({ myScreen }: any) => { seen.push(myScreen); order.push('beforeAll'); });
      extended('test after beforeAll', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      expect(seen).toEqual(['screen-value']);
      expect(order).toEqual(['setup', 'beforeAll', 'teardown']);
    } finally {
      resetFixtureRegistry();
    }
  });

  it('test.afterAll() registers hooks same as standalone afterAll', async () => {
    const order: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    pushContext();
    tapsmithTest.afterAll(async () => { order.push('afterAll'); });
    tapsmithTest('before test.afterAll', async () => { order.push('test'); });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ platform: 'android' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
      device: mockDevice as any,
    }));

    expect(result.tests[0].status).toBe('passed');
    expect(order).toEqual(['test', 'afterAll']);
  });

  it('marks the afterAll trace re-tag as attributionOnly so the UI does not restart a finished test', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-retag-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _stopDeviceLogStream: vi.fn(),
      _startDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };
    const startCalls: Array<{ fullName: string; attributionOnly: boolean }> = [];

    try {
      pushContext();
      tapsmithTest.afterAll(async () => {});
      tapsmithTest('only test', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        device: mockDevice as any,
        onTestStart: async (fullName, options) => {
          startCalls.push({ fullName, attributionOnly: options?.attributionOnly ?? false });
        },
      }));

      expect(result.tests[0].status).toBe('passed');
      // Real start first, then the afterAll re-tag for the same (finished)
      // test — the re-tag must be flagged so UI mode doesn't reset the
      // test's status or clear its trace.
      expect(startCalls).toEqual([
        { fullName: 'only test', attributionOnly: false },
        { fullName: 'only test', attributionOnly: true },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('attributes the afterAll re-tag to the last run test in a nested suite', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-retag-nested-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _stopDeviceLogStream: vi.fn(),
      _startDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };
    const startCalls: Array<{ fullName: string; attributionOnly: boolean }> = [];

    try {
      pushContext();
      // afterAll on the outer scope; the only tests live in a nested describe.
      tapsmithAfterAll(async () => {});
      tapsmithDescribe('inner', () => {
        tapsmithTest('nested test', async () => {});
      });
      const ctx = popContext();

      await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        device: mockDevice as any,
        onTestStart: async (fullName, options) => {
          startCalls.push({ fullName, attributionOnly: options?.attributionOnly ?? false });
        },
      }));

      // The outer scope has no direct tests, but the nested test ran — the
      // re-tag must target it, not skip attribution (which would leave the
      // hook events tagged to whatever test the UI saw last).
      expect(startCalls).toEqual([
        { fullName: 'inner > nested test', attributionOnly: false },
        { fullName: 'inner > nested test', attributionOnly: true },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('skips the afterAll re-tag and traced streaming when no test ran', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-retag-skipped-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const startManagedSpy = vi.spyOn(tracing, '_startManaged');
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _stopDeviceLogStream: vi.fn(),
      _startDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };
    const startCalls: string[] = [];
    let hookRan = false;

    try {
      pushContext();
      tapsmithAfterAll(async () => { hookRan = true; });
      tapsmithTest.skip('skipped test', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        device: mockDevice as any,
        onTestStart: async (fullName) => { startCalls.push(fullName); },
      }));

      expect(result.tests[0].status).toBe('skipped');
      // The hook still runs, but nothing is re-tagged and no hook collector
      // is started — there is no test to attribute the events to, and
      // streaming them would pollute whichever test the UI last tagged.
      expect(hookRan).toBe(true);
      expect(startCalls).toEqual([]);
      expect(startManagedSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('starts device log streaming for each traced test collector', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-logs-'));
    let activeLogCollector: TraceCollector | null = null;
    const streamStarts: TraceCollector[] = [];
    const streamStops: TraceCollector[] = [];
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _startDeviceLogStream: vi.fn((collector: TraceCollector) => {
        if (activeLogCollector) return;
        activeLogCollector = collector;
        streamStarts.push(collector);
        collector.addLogcatEntry('info', `device-log-${streamStarts.length}`);
      }),
      _stopDeviceLogStream: vi.fn(() => {
        if (activeLogCollector) streamStops.push(activeLogCollector);
        activeLogCollector = null;
      }),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };

    try {
      pushContext();
      tapsmithTest('first traced test', async () => {});
      tapsmithTest('second traced test', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        device: mockDevice as any,
      }));

      expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
      expect(mockDevice._startDeviceLogStream).toHaveBeenCalledTimes(2);
      expect(mockDevice._stopDeviceLogStream).toHaveBeenCalledTimes(2);
      expect(streamStarts).toHaveLength(2);
      expect(streamStops).toEqual(streamStarts);

      for (let i = 0; i < result.tests.length; i++) {
        const tracePath = result.tests[i].tracePath;
        expect(tracePath).toBeTruthy();
        const files = unzipSync(new Uint8Array(fs.readFileSync(tracePath!)));
        const traceJson = Buffer.from(files['trace.json']).toString('utf8');
        const deviceMessages = traceJson
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { source?: string; message?: string })
          .filter((event) => event.source === 'device')
          .map((event) => event.message);
        expect(deviceMessages).toEqual([`device-log-${i + 1}`]);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('drains network capture between traced tests without hard teardown', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-network-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _startNetworkCapture: vi.fn(async () => ({
        success: true,
        proxyPort: 12345,
        errorMessage: '',
      })),
      _stopNetworkCapture: vi.fn(async () => ({
        success: true,
        entries: [],
        errorMessage: '',
      })),
      _stopDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
      _disposeRouteManager: vi.fn(async () => {}),
      _disposeWebViewManager: vi.fn(async () => {}),
      _resetWebViewContext: vi.fn(),
    };

    try {
      pushContext();
      tapsmithTest('first traced test', async () => {});
      tapsmithTest('second traced test', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: true,
            screenshots: false,
            snapshots: false,
            sources: false,
            deviceLogs: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        device: mockDevice as any,
      }));

      expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
      expect(mockDevice._startNetworkCapture).toHaveBeenCalledTimes(2);
      expect(mockDevice._stopNetworkCapture).toHaveBeenCalledTimes(2);
      expect(mockDevice._stopNetworkCapture).toHaveBeenNthCalledWith(1, { keepRunning: true });
      expect(mockDevice._stopNetworkCapture).toHaveBeenNthCalledWith(2, { keepRunning: true });
      expect(mockDevice._disposeRouteManager).not.toHaveBeenCalled();
      // The WebView connection is kept alive across tests (PILOT-288):
      // per-test teardown only resets the active context.
      expect(mockDevice._disposeWebViewManager).not.toHaveBeenCalled();
      expect(mockDevice._resetWebViewContext).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ─── test.use() ───

describe('test.use()', () => {
  it('test.use is a function', () => {
    expect(typeof tapsmithTest.use).toBe('function');
  });

  it('rejects non-positive timeout', () => {
    pushContext();
    expect(() => tapsmithTest.use({ timeout: 0 })).toThrow('timeout must be a positive number');
    expect(() => tapsmithTest.use({ timeout: -1 })).toThrow('timeout must be a positive number');
    popContext();
  });

  it('rejects negative retries', () => {
    pushContext();
    expect(() => tapsmithTest.use({ retries: -1 })).toThrow('retries must be a non-negative number');
    popContext();
  });

  it('stores useOptions on the current context', () => {
    pushContext();
    tapsmithTest.use({ timeout: 5000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 5000 });
  });

  it('merges multiple test.use() calls in the same scope', () => {
    pushContext();
    tapsmithTest.use({ timeout: 5000 });
    tapsmithTest.use({ screenshot: 'always' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 5000, screenshot: 'always' });
  });

  it('last call wins for the same key', () => {
    pushContext();
    tapsmithTest.use({ timeout: 5000 });
    tapsmithTest.use({ timeout: 10000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 10000 });
  });

  it('stores appState in useOptions', () => {
    pushContext();
    tapsmithTest.use({ appState: './auth-state.tar.gz' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ appState: './auth-state.tar.gz' });
  });

  it('merges appState with other options', () => {
    pushContext();
    tapsmithTest.use({ timeout: 5000, appState: './state.tar.gz' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 5000, appState: './state.tar.gz' });
  });

  it('applies timeout override during execution', async () => {
    pushContext();

    tapsmithDescribe('scoped', () => {
      tapsmithTest.use({ timeout: 99999 });
      tapsmithTest('check timeout', async () => {
        // The test itself just passes — we verify via the result
        // that it ran (meaning the context was applied)
      });
    });

    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ timeout: 30_000 }),
    }));

    const flat = collectResults(result);
    expect(flat).toHaveLength(1);
    expect(flat[0].status).toBe('passed');
  });

  it('inner describe overrides outer describe', async () => {
    pushContext();

    tapsmithDescribe('outer', () => {
      tapsmithTest.use({ timeout: 60000 });

      tapsmithDescribe('inner', () => {
        tapsmithTest.use({ timeout: 5000 });
        tapsmithTest('inner test', async () => {});
      });

      tapsmithTest('outer test', async () => {});
    });

    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts());

    const flat = collectResults(result);
    expect(flat).toHaveLength(2);
    expect(flat.every((t) => t.status === 'passed')).toBe(true);
  });

  it('does not leak overrides to sibling scopes', async () => {
    pushContext();

    tapsmithDescribe('first', () => {
      tapsmithTest.use({ timeout: 1000 });
      tapsmithTest('t1', async () => {});
    });

    tapsmithDescribe('second', () => {
      // No test.use() — should inherit from parent, not from sibling
      tapsmithTest('t2', async () => {});
    });

    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ timeout: 30_000 }),
    }));

    const flat = collectResults(result);
    expect(flat).toHaveLength(2);
    expect(flat.every((t) => t.status === 'passed')).toBe(true);
  });

  it('propagates timeout to device and restores it', async () => {
    const timeoutLog: number[] = [];
    const mockDevice = {
      _getDefaultTimeout: () => timeoutLog[timeoutLog.length - 1] ?? 10000,
      _setDefaultTimeout: (ms: number) => { timeoutLog.push(ms); },
    };

    pushContext();
    tapsmithDescribe('scoped', () => {
      tapsmithTest.use({ timeout: 5000 });
      tapsmithTest('t', async () => {});
    });

    const ctx = popContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock device for testing
    await runSuiteContext(ctx, '', [], [], makeOpts({ device: mockDevice as any }));

    // Should have set 5000 then restored to original
    expect(timeoutLog).toEqual([5000, 10000]);
  });

  it('restores device timeout even when suite throws', async () => {
    const timeoutLog: number[] = [];
    const mockDevice = {
      _getDefaultTimeout: () => timeoutLog[timeoutLog.length - 1] ?? 10000,
      _setDefaultTimeout: (ms: number) => { timeoutLog.push(ms); },
    };

    pushContext();
    tapsmithDescribe('failing', () => {
      tapsmithTest.use({ timeout: 3000 });
      tapsmithTest('boom', async () => { throw new Error('fail'); });
    });

    const ctx = popContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock device for testing
    await runSuiteContext(ctx, '', [], [], makeOpts({ device: mockDevice as any }));

    // Timeout should still be restored after the failure
    expect(timeoutLog).toEqual([3000, 10000]);
  });

  it('file-scope test.use() applies to all tests', async () => {
    pushContext();

    tapsmithTest.use({ screenshot: 'always' });
    tapsmithTest('t1', async () => {});
    tapsmithTest('t2', async () => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    // The useOptions should be set on the root context
    expect(ctx.useOptions).toEqual({ screenshot: 'always' });

    const result = await runSuiteContext(ctx, '', [], [], makeOpts());
    const flat = collectResults(result);
    expect(flat).toHaveLength(2);
    expect(flat.every((t) => t.status === 'passed')).toBe(true);
  });
});

// ─── testFilter (single-test) filtering ───

describe('testFilter', () => {
  it('runs the matching test and skips the rest (case-insensitive substring)', async () => {
    pushContext();
    tapsmithDescribe('Login screen', () => {
      tapsmithTest('submits the form', async () => {});
      tapsmithTest('shows an error', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      testFilter: 'submits the form',
    }));

    const byName = new Map(collectResults(result).map((t) => [t.fullName, t.status]));
    expect(byName.get('Login screen > submits the form')).toBe('passed');
    expect(byName.get('Login screen > shows an error')).toBe('skipped');
  });

  it('matches a describe prefix (runs all tests under it)', async () => {
    pushContext();
    tapsmithDescribe('Login screen', () => {
      tapsmithTest('a', async () => {});
      tapsmithTest('b', async () => {});
    });
    tapsmithDescribe('Home screen', () => {
      tapsmithTest('c', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      testFilter: 'Login screen',
    }));

    const byName = new Map(collectResults(result).map((t) => [t.fullName, t.status]));
    expect(byName.get('Login screen > a')).toBe('passed');
    expect(byName.get('Login screen > b')).toBe('passed');
    expect(byName.get('Home screen > c')).toBe('skipped');
  });

  it('can match multiple tests by a shared substring', async () => {
    pushContext();
    tapsmithTest('renders header', async () => {});
    tapsmithTest('renders footer', async () => {});
    tapsmithTest('taps button', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      testFilter: 'renders',
    }));

    const byName = new Map(collectResults(result).map((t) => [t.name, t.status]));
    expect(byName.get('renders header')).toBe('passed');
    expect(byName.get('renders footer')).toBe('passed');
    expect(byName.get('taps button')).toBe('skipped');
  });

  it('skips every test when nothing matches', async () => {
    pushContext();
    tapsmithTest('alpha', async () => {});
    tapsmithTest('beta', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      testFilter: 'does-not-exist',
    }));

    const flat = collectResults(result);
    expect(flat.every((t) => t.status === 'skipped')).toBe(true);
  });
});

// ─── grep / grepInvert filtering ───

describe('grep / grepInvert', () => {
  it('grep keeps only matching tests, marks the rest skipped', async () => {
    pushContext();
    tapsmithTest('login flow', async () => {});
    tapsmithTest('logout flow', async () => {});
    tapsmithTest('signup flow', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grep: [/login|logout/],
    }));

    const flat = collectResults(result);
    expect(flat).toHaveLength(3);
    const byName = new Map(flat.map((t) => [t.name, t.status]));
    expect(byName.get('login flow')).toBe('passed');
    expect(byName.get('logout flow')).toBe('passed');
    expect(byName.get('signup flow')).toBe('skipped');
  });

  it('grep matches against fullName so describe scope counts', async () => {
    pushContext();
    tapsmithDescribe('checkout', () => {
      tapsmithTest('happy path', async () => {});
      tapsmithTest('failure', async () => {});
    });
    tapsmithDescribe('login', () => {
      tapsmithTest('happy path', async () => {});
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grep: [/^checkout/],
    }));

    const flat = collectResults(result);
    expect(flat).toHaveLength(3);
    const byName = new Map(flat.map((t) => [t.fullName, t.status]));
    expect(byName.get('checkout > happy path')).toBe('passed');
    expect(byName.get('checkout > failure')).toBe('passed');
    expect(byName.get('login > happy path')).toBe('skipped');
  });

  it('grepInvert skips matching tests', async () => {
    pushContext();
    tapsmithTest('fast assert', async () => {});
    tapsmithTest('slow integration', async () => {});
    tapsmithTest('slow load', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grepInvert: [/slow/],
    }));

    const flat = collectResults(result);
    const byName = new Map(flat.map((t) => [t.name, t.status]));
    expect(byName.get('fast assert')).toBe('passed');
    expect(byName.get('slow integration')).toBe('skipped');
    expect(byName.get('slow load')).toBe('skipped');
  });

  it('grep and grepInvert together: must match grep AND not match grepInvert', async () => {
    pushContext();
    tapsmithTest('login fast', async () => {});
    tapsmithTest('login slow', async () => {});
    tapsmithTest('signup fast', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grep: [/login/],
      grepInvert: [/slow/],
    }));

    const flat = collectResults(result);
    const byName = new Map(flat.map((t) => [t.name, t.status]));
    expect(byName.get('login fast')).toBe('passed');
    expect(byName.get('login slow')).toBe('skipped');
    expect(byName.get('signup fast')).toBe('skipped');
  });

  it('grep with multiple patterns matches union (any pattern is enough)', async () => {
    pushContext();
    tapsmithTest('alpha', async () => {});
    tapsmithTest('beta', async () => {});
    tapsmithTest('gamma', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grep: [/alpha/, /gamma/],
    }));

    const flat = collectResults(result);
    const byName = new Map(flat.map((t) => [t.name, t.status]));
    expect(byName.get('alpha')).toBe('passed');
    expect(byName.get('beta')).toBe('skipped');
    expect(byName.get('gamma')).toBe('passed');
  });

  it('projectGrep is intersected with grep (both must match)', async () => {
    pushContext();
    tapsmithTest('login fast', async () => {});
    tapsmithTest('login slow', async () => {});
    tapsmithTest('signup fast', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grep: [/login/],
      projectGrep: [/fast/],
    }));

    const flat = collectResults(result);
    const byName = new Map(flat.map((t) => [t.name, t.status]));
    // Only the test matching BOTH the root grep and the project grep runs.
    expect(byName.get('login fast')).toBe('passed');
    expect(byName.get('login slow')).toBe('skipped');
    expect(byName.get('signup fast')).toBe('skipped');
  });

  it('projectGrepInvert is unioned with grepInvert', async () => {
    pushContext();
    tapsmithTest('alpha', async () => {});
    tapsmithTest('beta', async () => {});
    tapsmithTest('gamma', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grepInvert: [/alpha/],
      projectGrepInvert: [/gamma/],
    }));

    const flat = collectResults(result);
    const byName = new Map(flat.map((t) => [t.name, t.status]));
    expect(byName.get('alpha')).toBe('skipped');
    expect(byName.get('beta')).toBe('passed');
    expect(byName.get('gamma')).toBe('skipped');
  });

  it('empty grep arrays behave the same as undefined', async () => {
    pushContext();
    tapsmithTest('a', async () => {});
    tapsmithTest('b', async () => {});
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      grep: [],
      grepInvert: [],
    }));

    const flat = collectResults(result);
    expect(flat.every((t) => t.status === 'passed')).toBe(true);
  });
});

// ─── beforeAll failure ───

describe('beforeAll failure marks all tests as failed', () => {
  it('marks flat tests as failed with the beforeAll error', async () => {
    pushContext();
    tapsmithBeforeAll(async () => { throw new Error('setup exploded'); });
    tapsmithTest('test-a', async () => {});
    tapsmithTest('test-b', async () => {});
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts());
    const flat = collectResults(result);
    expect(flat).toHaveLength(2);
    expect(flat[0].status).toBe('failed');
    expect(flat[0].error?.message).toBe('setup exploded');
    expect(flat[1].status).toBe('failed');
    expect(flat[1].error?.message).toBe('setup exploded');
  });

  it('marks nested describe tests as failed', async () => {
    pushContext();
    tapsmithBeforeAll(async () => { throw new Error('boom'); });
    tapsmithDescribe('inner', () => {
      tapsmithTest('nested-test', async () => {});
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, 'root', [], [], makeOpts());
    const flat = collectResults(result);
    expect(flat).toHaveLength(1);
    expect(flat[0].status).toBe('failed');
    expect(flat[0].fullName).toBe('root > inner > nested-test');
    expect(flat[0].error?.message).toBe('boom');
  });
});

// ─── platform fixture resolution ───

describe('resolvePlatformFixture()', () => {
  it('returns the explicit platform when set', () => {
    expect(resolvePlatformFixture(makeConfig({ platform: 'ios' }))).toBe('ios');
    expect(resolvePlatformFixture(makeConfig({ platform: 'android' }))).toBe('android');
  });

  it('defaults to android when no platform indicators are present', () => {
    expect(resolvePlatformFixture(makeConfig())).toBe('android');
  });

  it('throws when iOS-only `app` is set without explicit platform', () => {
    expect(() => resolvePlatformFixture(makeConfig({ app: '/path/to/App.app' })))
      .toThrowError(/iOS-only field\(s\) \[app\].*platform.*not set/);
  });

  it('throws when iOS-only `simulator` is set without explicit platform', () => {
    expect(() => resolvePlatformFixture(makeConfig({ simulator: 'iPhone 17' })))
      .toThrowError(/simulator/);
  });

  it('throws when iOS-only `iosXctestrun` is set without explicit platform', () => {
    expect(() => resolvePlatformFixture(makeConfig({ iosXctestrun: '/x.xctestrun' })))
      .toThrowError(/iosXctestrun/);
  });

  it('lists all present iOS indicators in the error message', () => {
    expect(() => resolvePlatformFixture(makeConfig({
      app: '/path/to/App.app',
      simulator: 'iPhone 17',
    }))).toThrowError(/\[app, simulator\]/);
  });

  it('does not throw when iOS indicators are present AND platform is explicitly ios', () => {
    expect(() => resolvePlatformFixture(makeConfig({
      platform: 'ios',
      app: '/path/to/App.app',
      simulator: 'iPhone 17',
    }))).not.toThrow();
  });

  it('does not throw when iOS indicators are present AND platform is explicitly android', () => {
    // Pathological but legal — caller knows what they want.
    expect(() => resolvePlatformFixture(makeConfig({
      platform: 'android',
      app: '/path/to/App.app',
    }))).not.toThrow();
  });
});

// ─── Retries ───

describe('retries', () => {
  it('forces cold deep links on retry attempts and resets on first attempts', async () => {
    const setForceColdDeepLinks = vi.fn();
    const mockDevice = {
      waitForIdle: vi.fn(async () => {}),
      _setForceColdDeepLinks: setForceColdDeepLinks,
    };
    let callCount = 0;
    pushContext();
    tapsmithTest('fails then passes', async () => {
      callCount++;
      if (callCount < 2) throw new Error('not yet');
    });
    tapsmithTest('passes first time', async () => {});
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 1 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner retry mock
      device: mockDevice as any,
    }));
    expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
    // Test 1 attempt 0 → false, attempt 1 (retry) → true; test 2 attempt 0
    // → false again so the previous retry doesn't leak into it.
    expect(setForceColdDeepLinks.mock.calls.map((c) => c[0])).toEqual([false, true, false]);
  });

  it('excludes progress-tracked device-action time from the test timeout', async () => {
    // Device actions carry their own bounded deadlines; time inside them is
    // infrastructure time, not test time. config.timeout 100ms → test
    // timeout 300ms; the body spends ~600ms inside a tracked action and
    // only ~50ms outside — it must pass.
    pushContext();
    tapsmithTest('slow action, fast test', async () => {
      emitActionProgress({ kind: 'start', id: 9001, action: 'openDeepLink' });
      await new Promise((r) => setTimeout(r, 600));
      emitActionProgress({ kind: 'end', id: 9001, action: 'openDeepLink', durationMs: 600, success: true });
      await new Promise((r) => setTimeout(r, 50));
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ timeout: 100 }),
    }));
    expect(result.tests[0].status).toBe('passed');
  });

  it('still times out on test-side time and enforces the wall-clock cap', async () => {
    pushContext();
    // 300ms test timeout; 500ms of untracked (test-side) time → timeout.
    tapsmithTest('slow test body', async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    // Wall cap: 5× timeout = 1.5s; a tracked action that never ends must
    // still be killed at the cap, not run unbounded.
    tapsmithTest('action never ends', async () => {
      emitActionProgress({ kind: 'start', id: 9002, action: 'openDeepLink' });
      await new Promise((r) => setTimeout(r, 2_500));
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ timeout: 100 }),
    }));
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].error?.message).toContain('Test timed out after 300ms');
    expect(result.tests[1].status).toBe('failed');
    expect(result.tests[1].error?.message).toContain('wall clock');
  }, 15_000);

  it('attributes a timeout error to the in-flight operation instead of the runner timer', async () => {
    // The timeout Error is constructed in the runner's timer callback, so its
    // natural stack has no user frames. When an operation registered pending
    // frames (via setPendingOperation), the error's stack must be rewritten to
    // those frames so reporters render the test line, not runner internals.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-timeout-attr-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _stopDeviceLogStream: vi.fn(),
      _startDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };

    try {
      pushContext();
      tapsmithTest('hangs inside a device operation', async () => {
        getActiveTraceCollector()?.setPendingOperation(() => {}, [
          { file: '/repo/e2e/login.test.ts', line: 110, column: 35 },
          { file: '/repo/e2e/helpers/screens.ts', line: 12, column: 3 },
        ]);
        await new Promise((r) => setTimeout(r, 2_000));
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          timeout: 100,
          rootDir: tempRoot,
          trace: { mode: 'on', network: false, screenshots: false, snapshots: false, sources: false },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner timeout mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('failed');
      const error = result.tests[0].error;
      expect(error?.message).toContain('Test timed out');
      expect(error?.stack).toContain('at /repo/e2e/login.test.ts:110:35');
      expect(error?.stack).toContain('at /repo/e2e/helpers/screens.ts:12:3');
      expect(error?.stack).not.toContain('runner');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('marks tests that failed on a discarded file-retry attempt as flaky', () => {
    const mkTest = (fullName: string, status: 'passed' | 'failed', error?: Error): TestResult => ({
      name: fullName, fullName, status, durationMs: 1, error,
    });
    const firstAttempt: SuiteResult = {
      name: '', durationMs: 1, suites: [{
        name: 'suite', durationMs: 1, suites: [],
        tests: [
          mkTest('suite > recovered', 'failed', new Error('session recovered during before test')),
          mkTest('suite > clean', 'passed'),
        ],
      }], tests: [],
    };
    const retried: SuiteResult = {
      name: '', durationMs: 1, suites: [{
        name: 'suite', durationMs: 1, suites: [],
        tests: [
          mkTest('suite > recovered', 'passed'),
          mkTest('suite > clean', 'passed'),
        ],
      }], tests: [],
    };

    markFileRetryFlakes(firstAttempt, retried);

    const results = collectResults(retried);
    const recovered = results.find((t) => t.fullName === 'suite > recovered');
    // Flaky = passed with retry > 0, carrying the first attempt's real error.
    expect(recovered?.retry).toBe(1);
    expect(recovered?.firstAttemptError?.message).toContain('session recovered');
    const clean = results.find((t) => t.fullName === 'suite > clean');
    expect(clean?.retry).toBeUndefined();
    expect(clean?.firstAttemptError).toBeUndefined();
  });

  it('does not consume per-test retries on a file-abort-worthy failure', async () => {
    // "session recovered" means the app was relaunched by infra and any
    // beforeAll-established state is gone — per-test retries would run
    // against the recovered app, fail with ordinary assertion errors, and
    // erase the infra signal that triggers the file-level retry (which
    // re-runs beforeAll). The attempt loop must stop retrying immediately.
    let attempts = 0;
    let secondTestRan = false;
    pushContext();
    tapsmithTest('hits session recovery', async () => {
      attempts++;
      throw new Error('session recovered during before test X; retrying file');
    });
    tapsmithTest('later test', async () => { secondTestRan = true; });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 2 }),
      abortFileOnError: (err) => err.message.includes('session recovered during'),
    }));
    expect(attempts).toBe(1);
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].error?.message).toContain('session recovered during');
    // File aborted — the remaining test never ran.
    expect(secondTestRan).toBe(false);
  });

  it('does not retry a passing test', async () => {
    let callCount = 0;
    pushContext();
    tapsmithTest('passes first time', async () => { callCount++; });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 2 }),
    }));
    expect(callCount).toBe(1);
    expect(result.tests[0].status).toBe('passed');
    expect(result.tests[0].retry).toBeUndefined();
  });

  it('retries a failing test up to the configured count', async () => {
    let callCount = 0;
    pushContext();
    tapsmithTest('always fails', async () => {
      callCount++;
      throw new Error('boom');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 2 }),
    }));
    expect(callCount).toBe(3);
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].retry).toBe(2);
  });

  it('passes on retry and reports the successful attempt', async () => {
    let callCount = 0;
    pushContext();
    tapsmithTest('fails then passes', async () => {
      callCount++;
      if (callCount < 3) throw new Error('not yet');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 3 }),
    }));
    expect(callCount).toBe(3);
    expect(result.tests[0].status).toBe('passed');
    expect(result.tests[0].retry).toBe(2);
  });

  it('does not retry when retries is 0', async () => {
    let callCount = 0;
    pushContext();
    tapsmithTest('fails once', async () => {
      callCount++;
      throw new Error('fail');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 0 }),
    }));
    expect(callCount).toBe(1);
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].retry).toBeUndefined();
  });

  it('runs beforeEach and afterEach on every attempt', async () => {
    const log: string[] = [];
    let callCount = 0;
    pushContext();
    tapsmithBeforeEach(async () => { log.push('before'); });
    tapsmithAfterEach(async () => { log.push('after'); });
    tapsmithTest('flaky', async () => {
      callCount++;
      if (callCount < 2) throw new Error('fail');
    });
    const ctx = popContext();
    await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 2 }),
    }));
    expect(log).toEqual(['before', 'after', 'before', 'after']);
  });

  it('only produces one test result even with retries', async () => {
    pushContext();
    let callCount = 0;
    tapsmithTest('flaky', async () => {
      callCount++;
      if (callCount === 1) throw new Error('first attempt');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 1 }),
    }));
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].status).toBe('passed');
  });

  it('reports retry via reporter.onTestEnd', async () => {
    const reported: TestResult[] = [];
    let callCount = 0;
    pushContext();
    tapsmithTest('flaky', async () => {
      callCount++;
      if (callCount === 1) throw new Error('first attempt');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 1 }),
      reporter: { onTestEnd: (t: TestResult) => { reported.push(t); } },
    }));
    expect(reported).toHaveLength(2);
    expect(reported[0].status).toBe('failed');
    expect(reported[0]._willRetry).toBe(true);
    expect(reported[0].retry).toBe(0);
    expect(reported[1].status).toBe('passed');
    expect(reported[1].retry).toBe(1);

    const canonical = collectResults(result);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].status).toBe('passed');
    expect(canonical[0].retry).toBe(1);
    expect(canonical[0]._willRetry).toBeUndefined();
  });

  it('keeps the first failed attempt error on a flaky pass', async () => {
    let callCount = 0;
    pushContext();
    tapsmithTest('flaky', async () => {
      callCount++;
      if (callCount === 1) throw new Error('first attempt boom');
      if (callCount === 2) throw new Error('second attempt boom');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 2 }),
    }));
    expect(result.tests[0].status).toBe('passed');
    expect(result.tests[0].retry).toBe(2);
    expect(result.tests[0].firstAttemptError?.message).toBe('first attempt boom');
  });

  it('does not set firstAttemptError on a permanently failing test', async () => {
    pushContext();
    tapsmithTest('always fails', async () => { throw new Error('boom'); });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 1 }),
    }));
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].firstAttemptError).toBeUndefined();
  });

  it('does not set firstAttemptError on a first-attempt pass', async () => {
    pushContext();
    tapsmithTest('passes', async () => {});
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 2 }),
    }));
    expect(result.tests[0].firstAttemptError).toBeUndefined();
  });

  it('links the failed attempt trace on a flaky pass', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-flaky-trace-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _startDeviceLogStream: vi.fn(),
      _stopDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
      _disposeRouteManager: vi.fn(async () => {}),
      _disposeWebViewManager: vi.fn(async () => {}),
    };
    const reported: TestResult[] = [];
    let callCount = 0;

    try {
      pushContext();
      tapsmithTest('flaky traced test', async () => {
        callCount++;
        if (callCount === 1) throw new Error('first boom');
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          retries: 1,
          trace: {
            mode: 'retain-on-failure-and-retries',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner lifecycle mock
        device: mockDevice as any,
        reporter: { onTestEnd: (t: TestResult) => { reported.push(t); } },
      }));

      const final = result.tests[0];
      expect(final.status).toBe('passed');

      // The final result links the FAILED attempt's trace, not the retry's.
      const failedAttempt = reported.find((t) => t._willRetry);
      expect(failedAttempt?.tracePath).toBeTruthy();
      expect(final.tracePath).toBe(failedAttempt!.tracePath);
      expect(fs.existsSync(final.tracePath!)).toBe(true);
      expect(final.firstAttemptError?.message).toBe('first boom');
      // Provenance flags mark which linked artifacts came from the failure
      // (no screenshot/video were captured here — only the trace flag set).
      expect(final.failedAttemptArtifacts?.trace).toBe(true);
      expect(final.failedAttemptArtifacts?.screenshot).toBeUndefined();
      expect(final.failedAttemptArtifacts?.video).toBeUndefined();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('closes the attempt fence when the body times out', async () => {
    let zombieObservedClosed: boolean | undefined;
    let resolveZombieDone!: () => void;
    const zombieDone = new Promise<void>((r) => { resolveZombieDone = r; });

    pushContext();
    tapsmithTest('times out but keeps running', async () => {
      // Outlive the body timeout (config.timeout * 3 = 90ms), then observe
      // the fence from the abandoned continuation.
      await new Promise((r) => setTimeout(r, 300));
      zombieObservedClosed = isCurrentAttemptClosed();
      resolveZombieDone();
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ timeout: 30, retries: 0 }),
    }));

    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].error?.message).toContain('Test timed out');
    // The zombie body is still running when the runner returns; once it
    // resumes it must see its attempt as closed so device calls get fenced.
    await zombieDone;
    expect(zombieObservedClosed).toBe(true);
  });

  it('fences a zombie body of a passed attempt too', async () => {
    let zombieObservedClosed: boolean | undefined;
    let resolveZombieDone!: () => void;
    const zombieDone = new Promise<void>((r) => { resolveZombieDone = r; });

    pushContext();
    tapsmithTest('passes but leaks a continuation', async () => {
      void (async () => {
        await new Promise((r) => setTimeout(r, 100));
        zombieObservedClosed = isCurrentAttemptClosed();
        resolveZombieDone();
      })();
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts({ config: makeConfig() }));
    expect(result.tests[0].status).toBe('passed');
    await zombieDone;
    expect(zombieObservedClosed).toBe(true);
  });

  it('uses test.use({ retries }) to override config retries', async () => {
    let callCount = 0;
    pushContext();
    tapsmithDescribe('scoped', () => {
      tapsmithTest.use({ retries: 3 });
      tapsmithTest('always fails', async () => {
        callCount++;
        throw new Error('fail');
      });
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 0 }),
    }));
    expect(callCount).toBe(4);
    const flat = collectResults(result);
    expect(flat[0].status).toBe('failed');
  });

  it('only resolves fixtures that the test destructures', async () => {
    const resolved: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const extended = tapsmithTest.extend<{ used: string; unused: string }>({
        used: async (_fixtures, use) => { resolved.push('used'); await use('used-val'); },
        unused: async (_fixtures, use) => { resolved.push('unused'); await use('unused-val'); },
      });

      pushContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing lazy fixture resolution
      extended('lazy test', async ({ used }: any) => {
        void used;
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      expect(resolved).toEqual(['used']);
      expect(resolved).not.toContain('unused');
    } finally {
      resetFixtureRegistry();
    }
  });

  it('resolves all fixtures when test uses non-destructured param with default', async () => {
    const resolved: string[] = [];
    const mockDevice = { waitForIdle: vi.fn(async () => {}) };

    try {
      const extended = tapsmithTest.extend<{ a: string; b: string }>({
        a: async (_fixtures, use) => { resolved.push('a'); await use('a-val'); },
        b: async (_fixtures, use) => { resolved.push('b'); await use('b-val'); },
      });

      pushContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing non-destructured param with default
      extended('non-destructured default', async (fixtures: any = {}) => {
        void fixtures;
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({ platform: 'android' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner hook fixture mock
        device: mockDevice as any,
      }));

      expect(result.tests[0].status).toBe('passed');
      // Both fixtures should be resolved since we can't determine which are needed
      expect(resolved).toContain('a');
      expect(resolved).toContain('b');
    } finally {
      resetFixtureRegistry();
    }
  });

  it('stops retrying when abort signal fires', async () => {
    let callCount = 0;
    const ac = new AbortController();
    pushContext();
    tapsmithTest('aborted', async () => {
      callCount++;
      if (callCount === 1) ac.abort();
      throw new Error('fail');
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      config: makeConfig({ retries: 5 }),
      abortSignal: ac.signal,
    }));
    expect(callCount).toBe(1);
    expect(result.tests[0].status).toBe('failed');
  });

  it('interrupts an in-flight test body when the abort signal fires (PILOT-222)', async () => {
    const ac = new AbortController();
    let afterEachRan = false;
    let secondTestRan = false;
    pushContext();
    tapsmithAfterEach(async () => { afterEachRan = true; });
    tapsmithTest('hangs forever', async () => {
      await new Promise(() => { /* a pure-JS wait that never settles */ });
    });
    tapsmithTest('never reached', async () => { secondTestRan = true; });
    const ctx = popContext();

    const run = runSuiteContext(ctx, '', [], [], makeOpts({
      abortSignal: ac.signal,
    }));
    // Let the first test body start, then stop the run. The race against
    // the abort signal must settle the suite without waiting for the
    // (30s default) test timeout — vitest's own timeout guards this.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const result = await run;

    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].error?.message).toBe('Stopped by user');
    expect(afterEachRan).toBe(true);
    expect(secondTestRan).toBe(false);
  });

  it('rejects a test that starts after the signal already aborted', async () => {
    // The between-test check normally prevents this, but the race arm must
    // also handle an already-aborted signal (it never fires 'abort' again).
    const ac = new AbortController();
    pushContext();
    tapsmithBeforeEach(async () => { ac.abort(); });
    tapsmithTest('first', async () => {
      await new Promise(() => { /* hang — the pre-aborted arm must reject */ });
    });
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts({
      abortSignal: ac.signal,
    }));
    expect(result.tests[0].status).toBe('failed');
    expect(result.tests[0].error?.message).toBe('Stopped by user');
  });
});

describe('beforeAll trace replay into packaged traces', () => {
  it('includes beforeAll actions in every test trace of a headless run', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-ba-trace-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _startDeviceLogStream: vi.fn(),
      _stopDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };

    try {
      pushContext();
      tapsmithBeforeAll(async () => {
        // Simulate a device action recorded during beforeAll (the runner
        // routes these to a standalone collector, not any test's collector).
        getActiveTraceCollector()!.addActionEvent({
          category: 'device',
          action: 'openDeepLink',
          duration: 5,
          success: true,
          log: [],
          hasScreenshotBefore: false,
          hasScreenshotAfter: false,
          hasHierarchyBefore: false,
          hasHierarchyAfter: false,
        });
      });
      tapsmithTest('first test', async () => {});
      tapsmithTest('second test', async () => {});
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner tracing mock
        device: mockDevice as any,
      }));

      expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
      for (const test of result.tests) {
        expect(test.tracePath).toBeTruthy();
        const files = unzipSync(new Uint8Array(fs.readFileSync(test.tracePath!)));
        const events = Buffer.from(files['trace.json']).toString('utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string; name?: string; action?: string });
        expect(
          events.some((e) => e.type === 'group-start' && e.name === 'beforeAll Hooks'),
          `trace for "${test.name}" should contain the beforeAll Hooks group`,
        ).toBe(true);
        expect(
          events.some((e) => e.type === 'action' && e.action === 'openDeepLink'),
          `trace for "${test.name}" should contain the beforeAll openDeepLink action`,
        ).toBe(true);
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('afterAll trace amendment into packaged traces', () => {
  it('appends afterAll actions to the last test trace of a headless run', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-runner-aa-trace-'));
    const tracing = new Tracing(async () => undefined, async () => undefined);
    const mockDevice = {
      tracing,
      waitForIdle: vi.fn(async () => {}),
      _startDeviceLogStream: vi.fn(),
      _stopDeviceLogStream: vi.fn(),
      _startDaemonLogStream: vi.fn(),
      _stopDaemonLogStream: vi.fn(),
    };

    try {
      pushContext();
      tapsmithTest('first test', async () => {});
      tapsmithTest('second test', async () => {
        // A regular test action, so the amendment's index offset is exercised
        // against a trace that already contains actions of its own.
        getActiveTraceCollector()!.addActionEvent({
          category: 'device',
          action: 'tap',
          duration: 3,
          success: true,
          log: [],
          hasScreenshotBefore: false,
          hasScreenshotAfter: false,
          hasHierarchyBefore: false,
          hasHierarchyAfter: false,
        });
      });
      tapsmithAfterAll(async () => {
        // Simulate a device action recorded during afterAll (the runner
        // routes these to a standalone collector after all tests packaged).
        getActiveTraceCollector()!.addActionEvent({
          category: 'device',
          action: 'terminateApp',
          duration: 5,
          success: true,
          log: [],
          hasScreenshotBefore: false,
          hasScreenshotAfter: false,
          hasHierarchyBefore: false,
          hasHierarchyAfter: false,
        });
      });
      const ctx = popContext();

      const result = await runSuiteContext(ctx, '', [], [], makeOpts({
        config: makeConfig({
          rootDir: tempRoot,
          outputDir: 'out',
          trace: {
            mode: 'on',
            network: false,
            screenshots: false,
            snapshots: false,
            sources: false,
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused runner tracing mock
        device: mockDevice as any,
      }));

      expect(result.tests.map((t) => t.status)).toEqual(['passed', 'passed']);
      const readEvents = (tracePath: string) =>
        Buffer.from(unzipSync(new Uint8Array(fs.readFileSync(tracePath)))['trace.json'])
          .toString('utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as {
            type: string; name?: string; action?: string; actionIndex?: number;
          });

      // afterAll ran after the first test's trace was packaged — it must not
      // appear there.
      const firstEvents = readEvents(result.tests[0].tracePath!);
      expect(firstEvents.some((e) => e.type === 'group-start' && e.name === 'afterAll Hooks')).toBe(false);

      // The last run test's archive is amended with the afterAll group.
      const lastEvents = readEvents(result.tests[1].tracePath!);
      expect(
        lastEvents.some((e) => e.type === 'group-start' && e.name === 'afterAll Hooks'),
        'last test trace should contain the afterAll Hooks group',
      ).toBe(true);
      const hookAction = lastEvents.find((e) => e.action === 'terminateApp');
      expect(hookAction, 'last test trace should contain the afterAll terminateApp action').toBeTruthy();

      // Appended action indices must not collide with the test's own actions.
      const indices = lastEvents
        .filter((e) => e.type === 'action')
        .map((e) => e.actionIndex);
      expect(new Set(indices).size).toBe(indices.length);
      const testAction = lastEvents.find((e) => e.action === 'tap');
      expect(hookAction!.actionIndex!).toBeGreaterThan(testAction!.actionIndex!);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
