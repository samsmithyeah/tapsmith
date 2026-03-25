import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunQueue, mapKeyToAction, type RunRequest, type WatchAction } from '../watch-queue.js';
import type { WatchRunMessage, WatchRunChildMessage } from '../watch-run.js';

// ─── Tests for mapKeyToAction ───

describe('mapKeyToAction', () => {
  it('maps "a" to run-all', () => {
    expect(mapKeyToAction('a')).toBe('run-all');
  });

  it('maps "f" to run-failed', () => {
    expect(mapKeyToAction('f')).toBe('run-failed');
  });

  it('maps Enter to rerun', () => {
    expect(mapKeyToAction('\r')).toBe('rerun');
    expect(mapKeyToAction('\n')).toBe('rerun');
  });

  it('maps "q" and Ctrl+C to quit', () => {
    expect(mapKeyToAction('q')).toBe('quit');
    expect(mapKeyToAction('\x03')).toBe('quit');
  });

  it('returns null for unknown keys', () => {
    expect(mapKeyToAction('x')).toBeNull();
    expect(mapKeyToAction('b')).toBeNull();
    expect(mapKeyToAction(' ')).toBeNull();
  });

  it('covers all WatchAction values', () => {
    const allActions: WatchAction[] = ['run-all', 'run-failed', 'rerun', 'quit'];
    const keys = ['a', 'f', '\r', 'q'];
    const results = keys.map(mapKeyToAction);
    for (const action of allActions) {
      expect(results).toContain(action);
    }
  });
});

// ─── Tests for RunQueue ───

describe('RunQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces file scheduling with the configured delay', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleFiles(['/test/a.test.ts']);

    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ type: 'files', files: ['/test/a.test.ts'] });
  });

  it('accumulates files across rapid debounce calls', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleFiles(['/test/a.test.ts']);
    q.scheduleFiles(['/test/b.test.ts']);
    q.scheduleFiles(['/test/a.test.ts']); // duplicate

    vi.advanceTimersByTime(300);

    expect(runs).toHaveLength(1);
    expect(runs[0].type).toBe('files');
    const files = (runs[0] as { type: 'files'; files: string[] }).files;
    expect(files).toHaveLength(2);
    expect(files).toContain('/test/a.test.ts');
    expect(files).toContain('/test/b.test.ts');
  });

  it('resets debounce timer on each call', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleFiles(['/test/a.test.ts']);
    vi.advanceTimersByTime(200); // 200ms in
    q.scheduleFiles(['/test/b.test.ts']);
    vi.advanceTimersByTime(200); // 400ms total, 200ms since last call

    expect(runs).toHaveLength(0); // not yet

    vi.advanceTimersByTime(100); // 300ms since last call
    expect(runs).toHaveLength(1);
  });

  it('queues files while a run is in progress', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    // Start a run
    q.scheduleAll();
    q.notifyRunStarted();
    expect(runs).toHaveLength(1);

    // Queue files during run
    q.scheduleFiles(['/test/a.test.ts']);
    q.scheduleFiles(['/test/b.test.ts']);

    // Nothing fires yet
    vi.advanceTimersByTime(500);
    expect(runs).toHaveLength(1);

    // Finish run → queued files execute
    q.notifyRunFinished();
    expect(runs).toHaveLength(2);
    expect(runs[1].type).toBe('files');
    const files = (runs[1] as { type: 'files'; files: string[] }).files;
    expect(files).toContain('/test/a.test.ts');
    expect(files).toContain('/test/b.test.ts');
  });

  it('scheduleAll supersedes queued individual files', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleAll();
    q.notifyRunStarted();

    // Queue individual files, then run-all
    q.scheduleFiles(['/test/a.test.ts']);
    q.scheduleAll();

    // Further individual files are ignored
    q.scheduleFiles(['/test/b.test.ts']);

    q.notifyRunFinished();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({ type: 'all' });
  });

  it('scheduleAll fires immediately (no debounce)', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleAll();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ type: 'all' });
  });

  it('scheduleImmediate fires immediately (no debounce)', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleImmediate(['/test/a.test.ts']);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ type: 'files', files: ['/test/a.test.ts'] });
  });

  it('scheduleImmediate queues when running', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleAll();
    q.notifyRunStarted();

    q.scheduleImmediate(['/test/a.test.ts']);
    expect(runs).toHaveLength(1); // still only the first

    q.notifyRunFinished();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({ type: 'files', files: ['/test/a.test.ts'] });
  });

  it('scheduleAll cancels a pending debounce timer', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleFiles(['/test/a.test.ts']);
    q.scheduleAll(); // should cancel the debounce

    vi.advanceTimersByTime(500);
    // Only the scheduleAll fired, not the debounced files
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ type: 'all' });
  });

  it('notifyRunFinished with no pending is a no-op', () => {
    const runs: RunRequest[] = [];
    const q = new RunQueue(300, (req) => runs.push(req));

    q.scheduleAll();
    q.notifyRunStarted();
    q.notifyRunFinished();

    expect(runs).toHaveLength(1); // only the initial run
  });
});

// ─── Tests for IPC protocol types ───

describe('watch-run IPC protocol', () => {
  it('WatchRunMessage has the expected shape', () => {
    const msg: WatchRunMessage = {
      type: 'run',
      daemonAddress: 'localhost:50051',
      deviceSerial: 'emulator-5554',
      filePath: '/test/login.test.ts',
      config: {
        timeout: 30_000,
        retries: 0,
        screenshot: 'only-on-failure',
        rootDir: '/project',
        outputDir: 'pilot-results',
      },
    };

    expect(msg.type).toBe('run');
    expect(msg.daemonAddress).toBe('localhost:50051');
    expect(msg.deviceSerial).toBe('emulator-5554');
    expect(msg.filePath).toBe('/test/login.test.ts');
  });

  it('WatchRunChildMessage file-done has results and suite', () => {
    const msg: WatchRunChildMessage = {
      type: 'file-done',
      filePath: '/test/login.test.ts',
      results: [{
        name: 'should login',
        fullName: 'Login > should login',
        status: 'passed',
        durationMs: 1234,
        workerIndex: 0,
      }],
      suite: {
        name: '',
        tests: [{
          name: 'should login',
          fullName: 'Login > should login',
          status: 'passed',
          durationMs: 1234,
          workerIndex: 0,
        }],
        suites: [],
        durationMs: 1234,
      },
    };

    expect(msg.type).toBe('file-done');
    expect(msg.results).toHaveLength(1);
    expect(msg.results[0].status).toBe('passed');
  });

  it('WatchRunChildMessage error has message and stack', () => {
    const msg: WatchRunChildMessage = {
      type: 'error',
      error: { message: 'daemon not reachable', stack: 'Error: ...' },
    };

    expect(msg.type).toBe('error');
    expect(msg.error.message).toBe('daemon not reachable');
  });
});
