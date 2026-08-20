import { describe, it, expect } from 'vitest';
import { HeadlessTestDispatcher } from '../mcp/headless-dispatcher.js';
import type { TestResultEntry, TestRunResult } from '../mcp/test-dispatcher.js';

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
  _testFiles: string[]
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
