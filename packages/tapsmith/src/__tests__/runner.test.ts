import { describe, it, expect } from 'vitest';

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
  _internal,
  type SuiteResult,
  type TestResult,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';

const { pushContext, popContext, runSuiteContext, resolvePlatformFixture } = _internal;

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
