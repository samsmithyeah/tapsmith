import { describe, it, expect } from 'vitest';
import {
  planMultiBucket,
  mergeBucketResults,
  PORTS_PER_BUCKET,
  type DispatcherOptions,
} from '../dispatcher.js';
import type { ResolvedProject } from '../project.js';
import type { PilotConfig } from '../config.js';
import type { FullResult } from '../reporter.js';
import type { SuiteResult, TestResult } from '../runner.js';

// Planning is pure: we don't need a real reporter / testFiles — just enough
// of the DispatcherOptions shape to exercise the bucket logic.
function stubReporter(): DispatcherOptions['reporter'] {
  return {
    onRunStart: async () => {},
    onTestFileStart: () => {},
    onTestStart: () => {},
    onTestEnd: () => {},
    onTestFileEnd: () => {},
    onRunEnd: async () => {},
  } as unknown as DispatcherOptions['reporter'];
}

function makeConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'pilot-results',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function makeProject(
  name: string,
  deviceSignature: string,
  testFiles: string[],
  overrides: Partial<ResolvedProject> = {},
): ResolvedProject {
  return {
    name,
    testMatch: ['**/*.test.ts'],
    testIgnore: [],
    dependencies: [],
    testFiles,
    effectiveConfig: makeConfig(),
    deviceSignature,
    ...overrides,
  };
}

function makeOpts(projects: ResolvedProject[], workers: number): DispatcherOptions {
  return {
    config: makeConfig({ workers }),
    reporter: stubReporter(),
    testFiles: projects.flatMap((p) => p.testFiles),
    workers,
    projects,
  };
}

// ─── planMultiBucket ───

describe('planMultiBucket()', () => {
  it('assigns non-overlapping port ranges to each bucket', () => {
    const projects = [
      makeProject('a', 'android|emu1||', ['t1.test.ts']),
      makeProject('b', 'ios|iPhone 16|', ['t2.test.ts']),
      makeProject('c', 'android|emu2||', ['t3.test.ts']),
    ];
    const opts = makeOpts(projects, 3);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
      ['2-android|emu2||', 1],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.portOffset)).toEqual([
      0,
      PORTS_PER_BUCKET,
      PORTS_PER_BUCKET * 2,
    ]);
    // Each plan must have a strictly higher offset than the previous.
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].portOffset).toBeGreaterThanOrEqual(
        plans[i - 1].portOffset + PORTS_PER_BUCKET,
      );
    }
  });

  it('routes each file only to the bucket that owns it', () => {
    const projects = [
      makeProject('android-smoke', 'android|emu1||', ['a.test.ts', 'b.test.ts']),
      makeProject('ios-smoke', 'ios|iPhone 16|', ['c.test.ts']),
    ];
    const opts = makeOpts(projects, 2);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans[0].bucketOpts.testFiles).toEqual(['a.test.ts', 'b.test.ts']);
    expect(plans[1].bucketOpts.testFiles).toEqual(['c.test.ts']);
    // A file must not leak between buckets.
    expect(plans[0].bucketOpts.testFiles).not.toContain('c.test.ts');
    expect(plans[1].bucketOpts.testFiles).not.toContain('a.test.ts');
  });

  it('passes the bucket-specific worker count into bucketOpts', () => {
    const projects = [
      makeProject('android', 'android|emu1||', ['a.test.ts'], { workers: 3 }),
      makeProject('ios', 'ios|iPhone 16|', ['b.test.ts']),
    ];
    const opts = makeOpts(projects, 2);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 3],
      ['1-ios|iPhone 16|', 2],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans[0].bucketOpts.workers).toBe(3);
    expect(plans[1].bucketOpts.workers).toBe(2);
  });

  it('omits buckets that received zero workers', () => {
    const projects = [
      makeProject('android', 'android|emu1||', ['a.test.ts']),
      makeProject('ios', 'ios|iPhone 16|', ['b.test.ts']),
    ];
    const opts = makeOpts(projects, 1);
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 0],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans).toHaveLength(1);
    expect(plans[0].bucketOpts.workers).toBe(1);
  });

  it('keeps correct portOffset and workerIndexBase when a middle bucket has zero workers', () => {
    // Regression guard: if we incremented workerIndexBase for skipped buckets
    // or reused indices for portOffset, later buckets would collide.
    const projects = [
      makeProject('android1', 'android|emu1||', ['a.test.ts']),
      makeProject('android2', 'android|emu2||', ['b.test.ts']),
      makeProject('ios', 'ios|iPhone 16|', ['c.test.ts']),
    ];
    const opts = makeOpts(projects, 3);
    // Middle bucket (emu2) gets 0 workers; first and last get 2 each.
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 2],
      ['1-android|emu2||', 0],
      ['2-ios|iPhone 16|', 2],
    ]);

    const plans = planMultiBucket(opts, allocation);

    expect(plans).toHaveLength(2);

    // First bucket: original index 0 → portOffset 0, workerIndexBase 0.
    expect(plans[0].bucketOpts.workers).toBe(2);
    expect(plans[0].portOffset).toBe(0);
    expect(plans[0].bucketOpts.workerIndexBase).toBe(0);

    // Third bucket: original index 2 → portOffset 2 * PORTS_PER_BUCKET,
    // workerIndexBase = 2 (one past the first bucket's 2 workers; the skipped
    // middle bucket contributes nothing).
    expect(plans[1].bucketOpts.workers).toBe(2);
    expect(plans[1].portOffset).toBe(PORTS_PER_BUCKET * 2);
    expect(plans[1].bucketOpts.workerIndexBase).toBe(2);
  });

  it('filters projectWaves to each bucket independently', () => {
    const androidA = makeProject('a-android', 'android|emu1||', ['a.test.ts']);
    const iosB = makeProject('b-ios', 'ios|iPhone 16|', ['b.test.ts']);
    const androidC = makeProject('c-android', 'android|emu1||', ['c.test.ts'], {
      dependencies: ['a-android'],
    });
    const projects = [androidA, iosB, androidC];
    const opts: DispatcherOptions = {
      ...makeOpts(projects, 2),
      // Wave 0: roots (androidA, iosB). Wave 1: androidC depends on androidA.
      projectWaves: [[androidA, iosB], [androidC]],
    };
    const allocation = new Map<string, number>([
      ['0-android|emu1||', 1],
      ['1-ios|iPhone 16|', 1],
    ]);

    const plans = planMultiBucket(opts, allocation);

    // Android bucket: wave 0 = [androidA], wave 1 = [androidC]
    const androidWaves = plans[0].bucketOpts.projectWaves ?? [];
    expect(androidWaves).toHaveLength(2);
    expect(androidWaves[0].map((p) => p.name)).toEqual(['a-android']);
    expect(androidWaves[1].map((p) => p.name)).toEqual(['c-android']);

    // iOS bucket: wave 0 = [iosB] only, wave 1 dropped entirely (empty after filter)
    const iosWaves = plans[1].bucketOpts.projectWaves ?? [];
    expect(iosWaves).toHaveLength(1);
    expect(iosWaves[0].map((p) => p.name)).toEqual(['b-ios']);
  });
});

// ─── mergeBucketResults ───

describe('mergeBucketResults()', () => {
  function makeTest(id: string, status: TestResult['status'] = 'passed'): TestResult {
    return {
      name: id,
      fullName: id,
      status,
      durationMs: 10,
    };
  }

  function makeSuite(name: string): SuiteResult {
    return { name, tests: [], suites: [], durationMs: 0 };
  }

  function makeFullResult(
    status: FullResult['status'],
    duration: number,
    tests: TestResult[],
    setupDuration = 0,
  ): FullResult {
    return {
      status,
      duration,
      setupDuration,
      tests,
      suites: tests.map((t) => makeSuite(t.name)),
    };
  }

  it('uses max duration (buckets run in parallel)', () => {
    const a = makeFullResult('passed', 5000, [makeTest('a')]);
    const b = makeFullResult('passed', 7000, [makeTest('b')]);
    const merged = mergeBucketResults([a, b]);
    expect(merged.duration).toBe(7000);
  });

  it('uses max setupDuration', () => {
    const a = makeFullResult('passed', 1000, [makeTest('a')], 3000);
    const b = makeFullResult('passed', 1000, [makeTest('b')], 5000);
    const merged = mergeBucketResults([a, b]);
    expect(merged.setupDuration).toBe(5000);
  });

  it('concatenates tests and suites across buckets without dropping any', () => {
    const a = makeFullResult('passed', 1000, [makeTest('a1'), makeTest('a2')]);
    const b = makeFullResult('passed', 1000, [makeTest('b1')]);
    const merged = mergeBucketResults([a, b]);
    expect(merged.tests.map((t) => t.name)).toEqual(['a1', 'a2', 'b1']);
    expect(merged.suites).toHaveLength(3);
  });

  it('marks the merged run failed when any bucket failed', () => {
    const a = makeFullResult('passed', 1000, [makeTest('a')]);
    const b = makeFullResult('failed', 1000, [makeTest('b', 'failed')]);
    expect(mergeBucketResults([a, b]).status).toBe('failed');
  });

  it('returns passed and zero durations for an empty input (no buckets ran)', () => {
    const merged = mergeBucketResults([]);
    expect(merged.status).toBe('passed');
    expect(merged.duration).toBe(0);
    expect(merged.setupDuration).toBe(0);
    expect(merged.tests).toEqual([]);
    expect(merged.suites).toEqual([]);
  });
});
