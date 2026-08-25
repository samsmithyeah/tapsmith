import { describe, it, expect } from 'vitest';
import {
  serializeTestResult,
  deserializeTestResult,
  serializeSuiteResult,
  deserializeSuiteResult,
  serializeRegExp,
  serializeRegExpArray,
  deserializeRegExpArray,
  serializeConfig,
  configFromSerialized,
} from '../worker-protocol.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult, SuiteResult } from '../runner.js';

describe('worker-protocol serialization', () => {
  describe('serializeTestResult / deserializeTestResult', () => {
    it('round-trips a passing test', () => {
      const result: TestResult = {
        name: 'my test',
        fullName: 'suite > my test',
        status: 'passed',
        durationMs: 123,
      };

      const serialized = serializeTestResult(result, 2);
      expect(serialized.workerIndex).toBe(2);
      expect(serialized.error).toBeUndefined();

      const deserialized = deserializeTestResult(serialized);
      expect(deserialized.name).toBe('my test');
      expect(deserialized.fullName).toBe('suite > my test');
      expect(deserialized.status).toBe('passed');
      expect(deserialized.durationMs).toBe(123);
      expect(deserialized.workerIndex).toBe(2);
      expect(deserialized.error).toBeUndefined();
    });

    it('round-trips a failed test with error', () => {
      const error = new Error('assertion failed');
      error.stack = 'Error: assertion failed\n    at test.ts:10';

      const result: TestResult = {
        name: 'failing test',
        fullName: 'failing test',
        status: 'failed',
        durationMs: 456,
        error,
        screenshotPath: '/tmp/screenshot.png',
      };

      const serialized = serializeTestResult(result, 0);
      expect(serialized.error).toEqual({
        message: 'assertion failed',
        stack: 'Error: assertion failed\n    at test.ts:10',
      });
      expect(serialized.screenshotPath).toBe('/tmp/screenshot.png');

      const deserialized = deserializeTestResult(serialized);
      expect(deserialized.status).toBe('failed');
      expect(deserialized.error).toBeInstanceOf(Error);
      expect(deserialized.error!.message).toBe('assertion failed');
      expect(deserialized.screenshotPath).toBe('/tmp/screenshot.png');
    });

    it('round-trips a skipped test', () => {
      const result: TestResult = {
        name: 'skipped',
        fullName: 'skipped',
        status: 'skipped',
        durationMs: 0,
      };

      const serialized = serializeTestResult(result, 1);
      const deserialized = deserializeTestResult(serialized);
      expect(deserialized.status).toBe('skipped');
      expect(deserialized.durationMs).toBe(0);
    });

    it('round-trips the retry field', () => {
      const result: TestResult = {
        name: 'flaky',
        fullName: 'flaky',
        status: 'passed',
        durationMs: 500,
        retry: 2,
      };

      const serialized = serializeTestResult(result, 0);
      expect(serialized.retry).toBe(2);

      const deserialized = deserializeTestResult(serialized);
      expect(deserialized.retry).toBe(2);
    });

    it('omits retry when undefined', () => {
      const result: TestResult = {
        name: 'clean pass',
        fullName: 'clean pass',
        status: 'passed',
        durationMs: 100,
      };

      const serialized = serializeTestResult(result, 0);
      expect(serialized.retry).toBeUndefined();

      const deserialized = deserializeTestResult(serialized);
      expect(deserialized.retry).toBeUndefined();
    });

    it('round-trips intermediate retry reporter events', () => {
      const result: TestResult = {
        name: 'flaky',
        fullName: 'flaky',
        status: 'failed',
        durationMs: 100,
        error: new Error('first attempt'),
        retry: 0,
        _willRetry: true,
      };

      const serialized = serializeTestResult(result, 1);
      expect(serialized._willRetry).toBe(true);

      const deserialized = deserializeTestResult(serialized);
      expect(deserialized._willRetry).toBe(true);
      expect(deserialized.retry).toBe(0);
      expect(deserialized.error?.message).toBe('first attempt');
    });
  });

  describe('serializeSuiteResult / deserializeSuiteResult', () => {
    it('round-trips a suite with nested suites and tests', () => {
      const suite: SuiteResult = {
        name: 'root',
        durationMs: 1000,
        tests: [
          { name: 'test1', fullName: 'root > test1', status: 'passed', durationMs: 100 },
          { name: 'test2', fullName: 'root > test2', status: 'failed', durationMs: 200, error: new Error('fail') },
        ],
        suites: [
          {
            name: 'child',
            durationMs: 500,
            tests: [
              { name: 'test3', fullName: 'root > child > test3', status: 'passed', durationMs: 300 },
            ],
            suites: [],
          },
        ],
      };

      const serialized = serializeSuiteResult(suite, 3);
      expect(serialized.tests[0].workerIndex).toBe(3);
      expect(serialized.suites[0].tests[0].workerIndex).toBe(3);

      const deserialized = deserializeSuiteResult(serialized);
      expect(deserialized.name).toBe('root');
      expect(deserialized.durationMs).toBe(1000);
      expect(deserialized.tests).toHaveLength(2);
      expect(deserialized.tests[1].error).toBeInstanceOf(Error);
      expect(deserialized.suites).toHaveLength(1);
      expect(deserialized.suites[0].tests[0].name).toBe('test3');
    });

    it('handles empty suite', () => {
      const suite: SuiteResult = {
        name: '',
        durationMs: 0,
        tests: [],
        suites: [],
      };

      const serialized = serializeSuiteResult(suite, 0);
      const deserialized = deserializeSuiteResult(serialized);
      expect(deserialized.tests).toEqual([]);
      expect(deserialized.suites).toEqual([]);
    });
  });

  describe('serializeRegExp / serializeRegExpArray / deserializeRegExpArray', () => {
    it('round-trips source and flags through serialization', () => {
      const original = /Foo|Bar/i;
      const serialized = serializeRegExp(original);
      expect(serialized).toEqual({ source: 'Foo|Bar', flags: 'i' });

      const [restored] = deserializeRegExpArray([serialized])!;
      expect(restored.source).toBe(original.source);
      expect(restored.flags).toBe(original.flags);
      expect(restored.test('foo')).toBe(true);
      expect(restored.test('baz')).toBe(false);
    });

    it('returns undefined for empty/missing arrays so the runner can skip filtering', () => {
      expect(serializeRegExpArray(undefined)).toBeUndefined();
      expect(serializeRegExpArray([])).toBeUndefined();
      expect(deserializeRegExpArray(undefined)).toBeUndefined();
      expect(deserializeRegExpArray([])).toBeUndefined();
    });

    it('round-trips multi-flag patterns (e.g. global + multiline)', () => {
      const original = /^cart\b/gm;
      const serialized = serializeRegExpArray([original])!;
      const [restored] = deserializeRegExpArray(serialized)!;
      expect(restored.source).toBe(original.source);
      // Order is implementation-defined; compare as set.
      expect(restored.flags.split('').sort().join('')).toBe(
        original.flags.split('').sort().join(''),
      );
    });
  });

  describe('serializeConfig / configFromSerialized', () => {
    it('round-trips every worker-relevant key, including video and the app reset policy', () => {
      const config: TapsmithConfig = {
        timeout: 15_000,
        retries: 2,
        screenshot: 'always',
        testMatch: ['**/*.test.ts'],
        daemonAddress: 'localhost:1',
        rootDir: '/proj',
        outputDir: 'out',
        workers: 4,
        launchEmulators: true,
        apk: './app.apk',
        activity: '.Main',
        package: 'com.example.app',
        agentApk: './agent.apk',
        agentTestApk: './agent-test.apk',
        trace: { mode: 'retain-on-failure' },
        video: 'on-first-retry',
        platform: 'android',
        app: './App.app',
        iosXctestrun: './x.xctestrun',
        simulator: 'iPhone 16',
        resetAppDeepLink: 'app:///__reset',
        resetAppWaitMs: 500,
        appReset: 'restart',
        appResetScope: 'test',
        baseURL: 'https://api.example.com',
        extraHTTPHeaders: { Authorization: 'Bearer x' },
        grep: [/smoke/i],
        grepInvert: /slow/,
      };

      const back = configFromSerialized(serializeConfig(config), 'localhost:2');

      // Worker-side synthetic fields: fresh daemon address, single worker, no emulator launches.
      expect(back).toMatchObject({
        ...config,
        daemonAddress: 'localhost:2',
        testMatch: [],
        workers: 1,
        launchEmulators: false,
        grep: [/smoke/i],
        grepInvert: [/slow/],
      });
      // Regression: the headless dispatcher used to hand-roll this object and
      // dropped `video`, so workers never recorded video.
      expect(back.video).toBe('on-first-retry');
    });
  });
});
