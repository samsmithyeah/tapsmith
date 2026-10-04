import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectResults,
  runTestFile,
  FILE_LOAD_FAILURE_TITLE,
  type RunOptions,
  type TestResult,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { extractStack } from '../trace/trace-collector.js';

// PILOT-545: a test file whose import throws (a missing module, a TypeError at
// load) must fail that file only — reported as a failed result, with every
// other file still running — instead of escaping runTestFile and aborting the
// whole run as a "Fatal error".

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

function writeFile(name: string, source: string): string {
  const filePath = path.join(tempDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  return filePath;
}

function setup(): void {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-load-errors-')));
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runTestFile — a file that fails to load (PILOT-545)', () => {
  it('reports a missing module as one failed result instead of throwing', async () => {
    setup();
    const filePath = writeFile('tests/a-broken.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      import { login } from '../helpers/login.mjs';
      test('never runs', async () => { login(); });
    `);
    const ended: TestResult[] = [];

    const suite = await runTestFile(filePath, makeOpts({
      projectName: 'android',
      reporter: { onTestEnd: (r) => ended.push(r) },
    }));

    const results = collectResults(suite);
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.status).toBe('failed');
    expect(result.name).toBe(FILE_LOAD_FAILURE_TITLE);
    expect(result.fullName).toBe(FILE_LOAD_FAILURE_TITLE);
    expect(result.fileLevelFailure).toBe(true);
    expect(result.filePath).toBe(filePath);
    expect(result.project).toBe('android');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toMatch(/Cannot find module/);
    // A frame at the failing import, so reporters can draw a code frame.
    expect(extractStack(result.error!.stack!)[0]).toMatchObject({ file: filePath, line: 3 });
    // Reporters hear about it like any other result, so console output, the
    // summary and JSON/JUnit all count it.
    expect(ended).toEqual([result]);
  });

  it('runs none of the tests a file registered before a TypeError at load', async () => {
    setup();
    const ran: string[] = [];
    (globalThis as Record<string, unknown>).__pilot545Ran = ran;
    const filePath = writeFile('b-typeerror.test.mjs', `
      import { test, describe } from ${JSON.stringify(runnerUrl)};
      test('registered first', async () => { globalThis.__pilot545Ran.push('first'); });
      describe('suite', () => {
        test('inside', async () => { globalThis.__pilot545Ran.push('inside'); });
        test.fixmeNotAnApi('typo', async () => {});
      });
    `);

    try {
      const suite = await runTestFile(pathToFileURL(filePath).href, makeOpts());
      const results = collectResults(suite);
      expect(results.map((r) => [r.fullName, r.status])).toEqual([[FILE_LOAD_FAILURE_TITLE, 'failed']]);
      expect(results[0].error).toBeInstanceOf(TypeError);
      expect(ran).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__pilot545Ran;
    }
  });

  it('leaves the next file in the same process to run normally', async () => {
    setup();
    // The throw lands inside a describe callback, leaving that describe's
    // context pushed: the next file must not inherit it.
    const broken = writeFile('a-broken.test.mjs', `
      import { test, describe } from ${JSON.stringify(runnerUrl)};
      describe('outer', () => {
        test('half-registered', async () => {});
        throw new Error('boom at load');
      });
    `);
    const fine = writeFile('b-fine.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      test('fine', async () => {});
    `);

    const brokenSuite = await runTestFile(pathToFileURL(broken).href, makeOpts());
    const fineSuite = await runTestFile(pathToFileURL(fine).href, makeOpts());

    expect(collectResults(brokenSuite).map((r) => [r.fullName, r.status])).toEqual([[FILE_LOAD_FAILURE_TITLE, 'failed']]);
    expect(collectResults(fineSuite).map((r) => [r.fullName, r.status])).toEqual([['fine', 'passed']]);
    expect(collectResults(fineSuite)[0].fileLevelFailure).toBeUndefined();
  });

  it('wraps a non-Error value thrown at load', async () => {
    setup();
    const filePath = writeFile('c-throws-string.test.mjs', `
      throw 'not an error object';
    `);

    const suite = await runTestFile(pathToFileURL(filePath).href, makeOpts());
    const [result] = collectResults(suite);

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe('not an error object');
  });

  it('still reports the load failure when a grep or test filter is active', async () => {
    setup();
    const filePath = writeFile('d-broken.test.mjs', `
      import './missing-helper.mjs';
    `);

    const suite = await runTestFile(pathToFileURL(filePath).href, makeOpts({
      grep: [/something else entirely/],
      testFilter: 'some other test',
    }));

    expect(collectResults(suite).map((r) => r.status)).toEqual(['failed']);
  });
});
