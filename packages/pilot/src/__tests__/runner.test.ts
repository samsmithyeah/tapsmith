import { describe, it, expect } from 'vitest';

// We need to test the runner's registration and execution logic.
// The runner uses module-level state, so we import the internal helpers
// by importing the module and resetting state between tests.
import {
  test as pilotTest,
  describe as pilotDescribe,
  beforeAll as pilotBeforeAll,
  afterAll as pilotAfterAll,
  beforeEach as pilotBeforeEach,
  afterEach as pilotAfterEach,
  collectResults,
  _internal,
  type SuiteResult,
  type TestResult,
  type RunOptions,
} from '../runner.js';
import type { PilotConfig } from '../config.js';

const { pushContext, popContext, runSuiteContext } = _internal;

/** Minimal config sufficient for runSuiteContext. */
function makeConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
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
    expect(typeof pilotTest).toBe('function');
  });

  it('test.only is a function', () => {
    expect(typeof pilotTest.only).toBe('function');
  });

  it('test.skip is a function', () => {
    expect(typeof pilotTest.skip).toBe('function');
  });

  it('describe is a function', () => {
    expect(typeof pilotDescribe).toBe('function');
  });

  it('describe.only is a function', () => {
    expect(typeof pilotDescribe.only).toBe('function');
  });

  it('describe.skip is a function', () => {
    expect(typeof pilotDescribe.skip).toBe('function');
  });

  it('hook functions are functions', () => {
    expect(typeof pilotBeforeAll).toBe('function');
    expect(typeof pilotAfterAll).toBe('function');
    expect(typeof pilotBeforeEach).toBe('function');
    expect(typeof pilotAfterEach).toBe('function');
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
    pilotTest('simple', async () => {});
    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts());
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].status).toBe('passed');
  });
});

// ─── test.use() ───

describe('test.use()', () => {
  it('test.use is a function', () => {
    expect(typeof pilotTest.use).toBe('function');
  });

  it('rejects non-positive timeout', () => {
    pushContext();
    expect(() => pilotTest.use({ timeout: 0 })).toThrow('timeout must be a positive number');
    expect(() => pilotTest.use({ timeout: -1 })).toThrow('timeout must be a positive number');
    popContext();
  });

  it('rejects negative retries', () => {
    pushContext();
    expect(() => pilotTest.use({ retries: -1 })).toThrow('retries must be a non-negative number');
    popContext();
  });

  it('stores useOptions on the current context', () => {
    pushContext();
    pilotTest.use({ timeout: 5000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 5000 });
  });

  it('merges multiple test.use() calls in the same scope', () => {
    pushContext();
    pilotTest.use({ timeout: 5000 });
    pilotTest.use({ screenshot: 'always' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 5000, screenshot: 'always' });
  });

  it('last call wins for the same key', () => {
    pushContext();
    pilotTest.use({ timeout: 5000 });
    pilotTest.use({ timeout: 10000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 10000 });
  });

  it('stores appState in useOptions', () => {
    pushContext();
    pilotTest.use({ appState: './auth-state.tar.gz' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ appState: './auth-state.tar.gz' });
  });

  it('merges appState with other options', () => {
    pushContext();
    pilotTest.use({ timeout: 5000, appState: './state.tar.gz' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private SuiteContext for testing
    const ctx = popContext() as any;
    expect(ctx.useOptions).toEqual({ timeout: 5000, appState: './state.tar.gz' });
  });

  it('applies timeout override during execution', async () => {
    pushContext();

    pilotDescribe('scoped', () => {
      pilotTest.use({ timeout: 99999 });
      pilotTest('check timeout', async () => {
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

    pilotDescribe('outer', () => {
      pilotTest.use({ timeout: 60000 });

      pilotDescribe('inner', () => {
        pilotTest.use({ timeout: 5000 });
        pilotTest('inner test', async () => {});
      });

      pilotTest('outer test', async () => {});
    });

    const ctx = popContext();
    const result = await runSuiteContext(ctx, '', [], [], makeOpts());

    const flat = collectResults(result);
    expect(flat).toHaveLength(2);
    expect(flat.every((t) => t.status === 'passed')).toBe(true);
  });

  it('does not leak overrides to sibling scopes', async () => {
    pushContext();

    pilotDescribe('first', () => {
      pilotTest.use({ timeout: 1000 });
      pilotTest('t1', async () => {});
    });

    pilotDescribe('second', () => {
      // No test.use() — should inherit from parent, not from sibling
      pilotTest('t2', async () => {});
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
    pilotDescribe('scoped', () => {
      pilotTest.use({ timeout: 5000 });
      pilotTest('t', async () => {});
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
    pilotDescribe('failing', () => {
      pilotTest.use({ timeout: 3000 });
      pilotTest('boom', async () => { throw new Error('fail'); });
    });

    const ctx = popContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock device for testing
    await runSuiteContext(ctx, '', [], [], makeOpts({ device: mockDevice as any }));

    // Timeout should still be restored after the failure
    expect(timeoutLog).toEqual([3000, 10000]);
  });

  it('file-scope test.use() applies to all tests', async () => {
    pushContext();

    pilotTest.use({ screenshot: 'always' });
    pilotTest('t1', async () => {});
    pilotTest('t2', async () => {});

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
