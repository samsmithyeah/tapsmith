import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { HeadlessTestDispatcher } from '../mcp/headless-dispatcher.js';
import type { TestResultEntry, TestRunResult } from '../mcp/test-dispatcher.js';
import type { WatchRunMessage } from '../watch-run.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));

// A stop is not a failure. Killing the in-flight child leaves it exiting with
// the SIGTERM we sent (code 143), and recording that as a file-level failure
// put the user's own stop into `list_results` and `suite_status` as a red file
// whose reason was our own signal — while UI mode reported the same stop as
// interrupted. The two transports have to answer this the same way.

/** The private surface these tests drive directly. */
interface DispatcherInternals {
  _ensureInitialized: () => Promise<void>
  _runFileInChild: (
    filePath: string,
    useOptions?: unknown,
    projectName?: string,
    testFilter?: string,
  ) => Promise<{ results: unknown[]; suite: { durationMs: number } }>
  _ensureTargetForProject: (projectName?: string) => Promise<{ address: string; deviceSerial: string }>
  _testFiles: string[]
  _serializedConfig: unknown
  _scripts: { watchRunScript: string; discoverScript: string; tsxBin?: string; baseDir: string }
}

function internalsOf(dispatcher: HeadlessTestDispatcher): DispatcherInternals {
  return dispatcher as unknown as DispatcherInternals;
}

/** A dispatcher whose files exist and whose children are ours to script. */
function makeDispatcher(files: string[]): {
  dispatcher: HeadlessTestDispatcher
  internals: DispatcherInternals
} {
  const dispatcher = new HeadlessTestDispatcher();
  const internals = internalsOf(dispatcher);
  internals._ensureInitialized = async () => {};
  internals._testFiles = files;
  return { dispatcher, internals };
}

describe('headless runFiles accounting under a stop', () => {
  const FILE = '/repo/tests/slow.test.ts';

  it('reports a stopped file as interrupted, not failed', async () => {
    const { dispatcher, internals } = makeDispatcher([FILE]);
    internals._runFileInChild = async () => {
      // What stop() does: kills the child, which rejects the run.
      dispatcher.stop();
      throw new Error('Test worker exited with code 143 without sending results');
    };

    const result = await dispatcher.runFiles([FILE]);

    expect(result.status).toBe('stopped');
    expect(result.failed).toBe(0);
    expect(result.interrupted).toBe(1);
  });

  it('leaves no phantom failure behind in the session results', async () => {
    const { dispatcher, internals } = makeDispatcher([FILE]);
    internals._runFileInChild = async () => {
      dispatcher.stop();
      throw new Error('Test worker exited with code 143 without sending results');
    };

    await dispatcher.runFiles([FILE]);

    expect(dispatcher.getResults().filter((r: TestResultEntry) => r.fileLevelFailure)).toEqual([]);
    expect(dispatcher.getResults().map((r) => r.fullName)).not.toContain(
      'slow.test.ts — file failed to run',
    );
  });

  // The over-correction to guard against: a file that dies on its own is still
  // a failure, and losing that would hide every broken import.
  it('still records a genuine child failure as a file-level failure', async () => {
    const { dispatcher, internals } = makeDispatcher([FILE]);
    internals._runFileInChild = async () => {
      throw new Error("Cannot find module './missing.js'");
    };

    const result = await dispatcher.runFiles([FILE]);

    expect(result.status).toBe('failed');
    expect(result.failed).toBe(1);
    expect(result.interrupted).toBeUndefined();
    const failure = dispatcher.getResults().find((r) => r.fileLevelFailure);
    expect(failure?.fullName).toBe('slow.test.ts — file failed to run');
    expect(failure?.error).toContain('Cannot find module');
  });

  it('stops the queue rather than carrying the stop into the next file', async () => {
    const SECOND = '/repo/tests/second.test.ts';
    const { dispatcher, internals } = makeDispatcher([FILE, SECOND]);
    const started: string[] = [];
    internals._runFileInChild = async (filePath: string) => {
      started.push(filePath);
      dispatcher.stop();
      throw new Error('Test worker exited with code 143 without sending results');
    };

    const result: TestRunResult = await dispatcher.runFiles([FILE, SECOND]);

    expect(started).toEqual([FILE]);
    expect(result.interrupted).toBe(1);
    expect(result.failed).toBe(0);
  });
});

// These runs are `tapsmith_run_tests`. They share a child script with watch
// mode, and the shared defaults leaked that mode's name into their failures:
// "Watch (SIM-1): … during watch reset for x.test.ts", from a caller who never
// used watch mode.
describe('run child naming', () => {
  const FILE = '/repo/tests/a.test.ts';

  function scriptedChild(): EventEmitter & { send: ReturnType<typeof vi.fn>; kill: () => void } {
    const child = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>
      kill: () => void
    };
    child.send = vi.fn();
    child.kill = (): void => {};
    return child;
  }

  function armDispatcher(child: EventEmitter): HeadlessTestDispatcher {
    vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
    const { dispatcher, internals } = makeDispatcher([FILE]);
    internals._serializedConfig = { rootDir: '/repo' };
    internals._scripts = {
      watchRunScript: '/sdk/watch-run.js',
      discoverScript: '/sdk/discover.js',
      baseDir: '/sdk',
    };
    internals._ensureTargetForProject = async () => ({
      address: '127.0.0.1:50051',
      deviceSerial: 'SIM-1',
    });
    return dispatcher;
  }

  it('tells the child this is a run, so preflight errors do not say "watch"', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child);

    const run = internalsOf(dispatcher)._runFileInChild(FILE);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());

    const msg = child.send.mock.calls[0][0] as WatchRunMessage;
    expect(msg.label).toBe('Run');

    child.emit('exit', 0);
    await expect(run).rejects.toThrow();
  });

  it('names a dead child a test worker, not a watch worker', async () => {
    const child = scriptedChild();
    const dispatcher = armDispatcher(child);

    const run = internalsOf(dispatcher)._runFileInChild(FILE);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
    child.emit('exit', 143);

    await expect(run).rejects.toThrow(/Test worker exited with code 143/);
    await expect(run).rejects.not.toThrow(/Watch worker/);
  });
});
