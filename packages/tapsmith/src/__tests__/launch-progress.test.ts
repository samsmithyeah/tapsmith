import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { TapsmithConfig } from '../config.js';
import type { ResolvedProject } from '../project.js';
import { createUiLaunchSteps, formatLaunchTable, UiLaunchProgress, type LaunchStep } from '../launch-progress.js';

class CaptureStream extends Writable {
  columns = 80;
  isTTY = true;
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  output(): string {
    return this.chunks.join('');
  }
}

const baseConfig = (overrides: Partial<TapsmithConfig> = {}): TapsmithConfig => ({
  timeout: 10_000,
  retries: 0,
  screenshot: 'only-on-failure',
  testMatch: ['tests/**/*.test.ts'],
  daemonAddress: '127.0.0.1:50051',
  rootDir: '/repo',
  outputDir: 'tapsmith-results',
  package: 'dev.tapsmith.testapp',
  workers: 1,
  launchEmulators: false,
  platform: 'android',
  ...overrides,
});

describe('createUiLaunchSteps', () => {
  it('builds a compact plan from a single Android config', () => {
    const steps = createUiLaunchSteps({
      config: baseConfig({ apk: 'app-debug.apk', workers: 1 }),
      testFileCount: 3,
      workerCount: 1,
    });

    expect(steps.map((s) => s.id)).toEqual([
      'config',
      'primary-device',
      'daemon',
      'app-install',
      'agent',
      'app-launch',
      'ui-server',
      'mcp',
      'test-tree',
      'browser',
    ]);
    expect(steps[0]!.detail).toContain('1 worker');
    expect(steps[0]!.detail).toContain('3 test files');
    expect(steps.find((s) => s.id === 'app-install')!.detail).toBe('verify/install app-debug.apk');
  });

  it('adds worker-pool rows for parallel multi-project UI mode', () => {
    const android = baseConfig({ platform: 'android', apk: 'app.apk', workers: 4 });
    const ios = baseConfig({ platform: 'ios', app: 'Test.app', simulator: 'iPhone 17', workers: 4 });
    const projects: ResolvedProject[] = [
      {
        name: 'android',
        testMatch: ['tests/**/*.test.ts'],
        testIgnore: [],
        dependencies: [],
        testFiles: ['/repo/tests/home.test.ts'],
        effectiveConfig: android,
        deviceSignature: 'android|Pixel|',
      },
      {
        name: 'ios',
        testMatch: ['tests/**/*.test.ts'],
        testIgnore: [],
        dependencies: [],
        testFiles: ['/repo/tests/home.test.ts'],
        effectiveConfig: ios,
        deviceSignature: 'ios|iPhone 17|',
      },
    ];

    const steps = createUiLaunchSteps({
      config: android,
      projects,
      testFileCount: 12,
      workerCount: 4,
    });

    expect(steps[0]!.detail).toContain('android + ios');
    expect(steps.map((s) => s.id)).toContain('primary-device');
    expect(steps.map((s) => s.id)).toContain('worker-devices');
    expect(steps.map((s) => s.id)).toContain('ui-workers');
    expect(steps.find((s) => s.id === 'worker-devices')!.detail).toContain('across 2 targets');
  });

  it('uses worker-focused rows for headless parallel test mode', () => {
    const steps = createUiLaunchSteps({
      config: baseConfig({ apk: 'app-debug.apk', workers: 3 }),
      testFileCount: 8,
      workerCount: 3,
      mode: 'test',
    });

    expect(steps.map((s) => s.id)).toEqual([
      'config',
      'daemon',
      'worker-devices',
      'app-install',
      'agent',
      'app-launch',
      'ui-workers',
    ]);
    expect(steps.find((s) => s.id === 'daemon')!.label).toBe('Worker daemons');
    expect(steps.find((s) => s.id === 'ui-workers')!.label).toBe('Workers');
    expect(steps.find((s) => s.id === 'app-install')!.progress).toEqual({ done: 0, total: 3 });
    expect(steps.map((s) => s.id)).not.toContain('ui-server');
  });

  it('shows worker allocation warnings as launch plan rows', () => {
    const steps = createUiLaunchSteps({
      config: baseConfig({ apk: 'app-debug.apk', workers: 2 }),
      testFileCount: 8,
      workerCount: 2,
      mode: 'test',
      workerPlanWarning: 'requested 1 worker; running 2 because 2 device targets need one each',
    });

    const workerPlan = steps.find((s) => s.id === 'worker-plan');
    expect(steps.map((s) => s.id).slice(0, 3)).toEqual(['config', 'worker-plan', 'daemon']);
    expect(workerPlan).toMatchObject({
      label: 'Worker plan',
      state: 'warning',
      detail: 'requested 1 worker; running 2 because 2 device targets need one each',
    });
  });
});

describe('formatLaunchTable', () => {
  it('renders status, progress counts, and details in stable columns', () => {
    const steps: LaunchStep[] = [
      { id: 'config', label: 'Config', state: 'done', detail: '4 workers | 31 test files' },
      {
        id: 'ui-workers',
        label: 'UI workers',
        state: 'running',
        detail: 'Worker 2: starting Tapsmith agent',
        progress: { done: 2, total: 4 },
      },
    ];

    const table = formatLaunchTable(steps, { color: false, columns: 90 });

    expect(table).toContain('Preparing UI mode');
    expect(table).toContain('Config      ✓');
    expect(table).toContain('UI workers  2/4');
    expect(table).toContain('Worker 2: starting Tapsmith agent');
  });

  it('renders degraded worker startup as a warning instead of success', () => {
    const steps: LaunchStep[] = [
      {
        id: 'ui-workers',
        label: 'UI workers',
        state: 'warning',
        detail: '2/4 UI worker(s) ready; 2 failed',
        progress: { done: 2, total: 4 },
      },
    ];

    const table = formatLaunchTable(steps, { color: false, columns: 90 });

    expect(table).toContain('UI workers  2/4');
    expect(table).toContain('2/4 UI worker(s) ready; 2 failed');
    expect(table).not.toContain('UI workers  ✓');
  });
});

describe('UiLaunchProgress', () => {
  it('streams row updates without an initial table in non-interactive output', () => {
    const stream = new CaptureStream();
    const progress = new UiLaunchProgress(
      [
        { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
        { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
        { id: 'daemon', label: 'Daemon', state: 'pending', detail: 'start tapsmith-core' },
      ],
      { stream, forceInteractive: false, color: false, title: 'Preparing test run' },
    );

    progress.start('primary-device');
    progress.complete('primary-device', 'emulator-5554 awake and unlocked');
    progress.complete('daemon', 'connected to tapsmith-core v0.1.1');
    progress.finish();

    const output = stream.output();
    expect(output).toContain('Preparing test run\n');
    expect(output).toContain('✓     Config: 1 worker | 1 test file\n');
    expect(output).toContain('…     Primary device: select connected Android device\n');
    expect(output).toContain('✓     Primary device: emulator-5554 awake and unlocked\n');
    expect(output).toContain('✓     Daemon: connected to tapsmith-core v0.1.1\n');
    expect(output).not.toContain('STEP');
    expect(output).not.toContain('DETAILS');
  });

  it('redraws interactive tables with row clearing instead of cursor save/restore', () => {
    const stream = new CaptureStream();
    const progress = new UiLaunchProgress(
      [
        { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
        { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
      ],
      { stream, forceInteractive: true, color: false },
    );

    progress.start('primary-device', 'checking emulator-5554');

    const output = stream.output();
    expect(output).not.toContain('\x1b[s');
    expect(output).not.toContain('\x1b[u');
    expect(output).toContain('\x1b[1G');
    expect(output).toContain('\x1b[0J');
  });

  it('redraws the table around external stdout writes while active', () => {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const chunks: string[] = [];
    const captureWrite = ((
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      done?.();
      return true;
    }) as typeof process.stdout.write;

    process.stdout.write = captureWrite;
    process.stderr.write = captureWrite as typeof process.stderr.write;

    try {
      const progress = new UiLaunchProgress(
        [
          { id: 'config', label: 'Config', state: 'done', detail: '1 worker | 1 test file' },
          { id: 'primary-device', label: 'Primary device', state: 'pending', detail: 'select connected Android device' },
        ],
        { forceInteractive: true, color: false },
      );

      process.stdout.write('external log\n');
      progress.complete('primary-device', 'ready');
      progress.finish();
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    const output = chunks.join('');
    expect(output.match(/external log/g)).toHaveLength(1);
    expect(output).toContain('\x1b[0Jexternal log\nPreparing UI mode');
  });
});
