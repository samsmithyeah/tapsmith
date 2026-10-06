import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectResults,
  runTestFile,
  type RunOptions,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { runnerOwnsUnhandledErrors } from '../unhandled-errors.js';
import { Device } from '../device.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import type { NetworkRouteManager } from '../network.js';

// PILOT-543: a promise a test never awaits (typically a waitForResponse()
// left behind by a step that failed) used to reject unhandled and kill the
// whole run. While a file runs, the runner owns unhandled rejections and
// fails the test they happen in — only that test.

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

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return { config: makeConfig(), devices: [], resetCapabilities: {}, runMode: 'test', ...overrides };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
let tempDir: string;
let savedRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
let savedExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];

function writeFile(name: string, source: string): string {
  const filePath = path.join(tempDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `import { test, describe } from ${JSON.stringify(runnerUrl)};\n${source}`);
  return filePath;
}

/** Let Node run its unhandled-rejection check (after the microtask queue drains). */
const SETTLE = 'await new Promise((r) => setTimeout(r, 10));';

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-unhandled-')));
  // Vitest's own listeners would report the deliberate rejections below as
  // errors of this test file; the runner's are what is under test.
  savedRejectionListeners = process.listeners('unhandledRejection');
  savedExceptionListeners = process.listeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
});

afterEach(() => {
  for (const l of savedRejectionListeners) process.on('unhandledRejection', l);
  for (const l of savedExceptionListeners) process.on('uncaughtException', l);
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runTestFile — unhandled errors during a test (PILOT-543)', () => {
  it('fails only the test whose promise rejected unhandled, and runs the rest', async () => {
    const filePath = writeFile('a.test.mjs', `
      test('leaves a rejection behind', async () => {
        Promise.reject(new Error('waitForResponse timed out after 30000ms'));
        ${SETTLE}
      });
      test('runs after it', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['leaves a rejection behind', 'failed'],
      ['runs after it', 'passed'],
    ]);
    expect(results[0].error!.message).toBe('waitForResponse timed out after 30000ms');
  });

  it('keeps the test\'s own failure as the headline and lists the unhandled error after it', async () => {
    const filePath = writeFile('b.test.mjs', `
      test('fails, then its waiter rejects', async () => {
        Promise.reject(new Error('waitForResponse timed out after 30000ms'));
        ${SETTLE}
        throw new Error('Element not found: button "Missing"');
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      'Element not found: button "Missing"\n\n--- Additionally ---\n'
      + 'Unhandled error during the test: waitForResponse timed out after 30000ms',
    );
  });

  it('leaves uncaught exceptions alone: swallowing one could hang a hook awaiting its callback', async () => {
    const filePath = writeFile('c.test.mjs', `
      test('observes the listeners', async () => {
        globalThis.__pilot543Listeners = process.listenerCount('uncaughtException');
      });
    `);

    try {
      const [result] = collectResults(await runTestFile(filePath, makeOpts()));
      expect(result.status).toBe('passed');
      expect((globalThis as Record<string, unknown>).__pilot543Listeners).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).__pilot543Listeners;
    }
  });

  it('wraps a rejection with a non-Error value', async () => {
    const filePath = writeFile('d.test.mjs', `
      test('rejects with a string', async () => {
        Promise.reject('nope');
        ${SETTLE}
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe('Unhandled rejection with a non-Error value: "nope"');
  });

  it('gives a retry its own scope: an error in the first attempt does not fail the second', async () => {
    const filePath = writeFile('e.test.mjs', `
      let attempt = 0;
      test('flaky', async () => {
        if (attempt++ === 0) Promise.reject(new Error('first attempt only'));
        ${SETTLE}
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts({ config: makeConfig({ retries: 1 }) })));

    expect(result.status).toBe('passed');
    expect(result.retry).toBe(1);
  });

  it('fails the scope like a throwing beforeAll when the error happens during beforeAll', async () => {
    const filePath = writeFile('f.test.mjs', `
      describe('scope', () => {
        test.beforeAll(async () => {
          Promise.reject(new Error('rejected during beforeAll'));
          ${SETTLE}
        });
        test('one', async () => {});
        test('two', async () => {});
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(results[0].error!.message).toMatch(/rejected during beforeAll/);
  });

  it('prints an error raised outside any test and carries on', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('g.test.mjs', `
      test.afterAll(async () => {
        Promise.reject(new Error('rejected during afterAll'));
        ${SETTLE}
      });
      test('passes', async () => {});
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => r.status)).toEqual(['passed']);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain(`Unhandled rejection outside a test in ${filePath}`);
    expect(printed).toContain('rejected during afterAll');
  });

  it('does not blame the running test for a leftover of a test that already ended', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('j.test.mjs', `
      test('forgets to await an action', async () => {
        // Stands in for an un-awaited device action that fails late.
        new Promise((_, reject) => setTimeout(() => reject(new Error('late tap failure')), 30));
      });
      test('is running when it fails', async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts()));

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain(`Unhandled rejection from a test that has already ended in ${filePath}`);
    expect(printed).toContain('late tap failure');
  });

  it('still fails the test whose own leftover rejects during its afterEach', async () => {
    const filePath = writeFile('k.test.mjs', `
      test.afterEach(async () => { await new Promise((r) => setTimeout(r, 80)); });
      test('leftover rejects after the body', async () => {
        new Promise((_, reject) => setTimeout(() => reject(new Error('rejected during afterEach')), 20));
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe('rejected during afterEach');
  });

  it('ignores a rejected call that the attempt fence refused', async () => {
    const fenceUrl = pathToFileURL(path.resolve('src/attempt-fence.ts')).href;
    const filePath = writeFile('l.test.mjs', `
      import { TestEndedError } from ${JSON.stringify(fenceUrl)};
      test('a fenced call nobody awaited', async () => {
        Promise.reject(new TestEndedError("'tap'"));
        ${SETTLE}
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.status).toBe('passed');
  });

  it('owns unhandled errors only while a file runs', async () => {
    const filePath = writeFile('h.test.mjs', `
      test('observes ownership', async () => {
        if (!globalThis.__pilot543Owned()) throw new Error('runner did not own unhandled errors during the test');
      });
    `);
    (globalThis as Record<string, unknown>).__pilot543Owned = runnerOwnsUnhandledErrors;
    try {
      const [result] = collectResults(await runTestFile(filePath, makeOpts()));
      expect(result.status).toBe('passed');
    } finally {
      delete (globalThis as Record<string, unknown>).__pilot543Owned;
    }

    expect(runnerOwnsUnhandledErrors()).toBe(false);
    expect(process.listenerCount('unhandledRejection')).toBe(0);
    expect(process.listenerCount('uncaughtException')).toBe(0);
  });

  it('releases ownership when the file fails to load', async () => {
    const filePath = writeFile('i.test.mjs', `import './missing-helper.mjs';`);

    const [result] = collectResults(await runTestFile(filePath, makeOpts()));

    expect(result.fileLevelFailure).toBe(true);
    expect(runnerOwnsUnhandledErrors()).toBe(false);
  });
});

describe('runTestFile — network waiters end with their test (PILOT-543)', () => {
  function makeRealDevice(): Device {
    const client = {
      waitForIdle: async () => ({ success: true }),
      _setAbortSignal: () => {},
    } as unknown as TapsmithGrpcClient;
    const device = new Device(client, { timeout: 30_000 });
    device._routeManager = {
      addRequestListener: () => {},
      removeRequestListener: () => {},
      addResponseListener: () => {},
      removeResponseListener: () => {},
      hasRoutes: false,
      dispose: async () => {},
    } as unknown as NetworkRouteManager;
    return device;
  }

  it('a waiter a failed test never awaited does not fail the next test when its timeout passes', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filePath = writeFile('w.test.mjs', `
      test('loads products', async ({ device }) => {
        const p = device.waitForResponse('**/products?*', { timeout: 30 });
        throw new Error('Element not found: button "Missing"');
        await p;
      });
      test('runs past the waiter timeout', async () => {
        await new Promise((r) => setTimeout(r, 80));
      });
    `);

    const results = collectResults(await runTestFile(filePath, makeOpts({
      devices: [{ name: 'device-1', device: makeRealDevice() }],
    })));

    expect(results.map((r) => [r.fullName, r.status])).toEqual([
      ['loads products', 'failed'],
      ['runs past the waiter timeout', 'passed'],
    ]);
    expect(results[0].error!.message).toBe('Element not found: button "Missing"');
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).not.toContain('waitForResponse timed out');
  });

  it('a waiter that times out while its test still runs fails that test', async () => {
    const filePath = writeFile('x.test.mjs', `
      test('forgets to await', async ({ device }) => {
        device.waitForResponse('**/never', { timeout: 20 });
        await new Promise((r) => setTimeout(r, 80));
      });
    `);

    const [result] = collectResults(await runTestFile(filePath, makeOpts({
      devices: [{ name: 'device-1', device: makeRealDevice() }],
    })));

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe('waitForResponse timed out after 20ms');
    // The stack points at the call in the test, for the reporter's code frame.
    expect(result.error!.stack).toContain('x.test.mjs');
  });
});
