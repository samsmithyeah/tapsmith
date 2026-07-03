import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runInAttemptContext,
  isCurrentAttemptClosed,
  fencedRejection,
  TestEndedError,
  isTestEndedError,
  type AttemptToken,
} from '../attempt-fence.js';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';
import { TraceCollector } from '../trace/trace-collector.js';
import type { TraceConfig } from '../trace/types.js';

describe('attempt fence primitives', () => {
  it('reads false outside any attempt context', () => {
    expect(isCurrentAttemptClosed()).toBe(false);
  });

  it('reads false inside an open attempt context', async () => {
    const token: AttemptToken = { closed: false };
    await runInAttemptContext(token, async () => {
      expect(isCurrentAttemptClosed()).toBe(false);
    });
  });

  it('propagates closure into continuations the body left pending', async () => {
    const token: AttemptToken = { closed: false };
    const observed: boolean[] = [];
    const body = runInAttemptContext(token, async () => {
      observed.push(isCurrentAttemptClosed());
      await new Promise((r) => setTimeout(r, 20));
      // Token was closed while we were "asleep" — the zombie continuation
      // still sees its own (now closed) attempt context.
      observed.push(isCurrentAttemptClosed());
    });
    token.closed = true;
    await body;
    expect(observed).toEqual([false, true]);
  });

  it('does not leak the attempt context to code outside the body', async () => {
    const token: AttemptToken = { closed: true };
    await runInAttemptContext(token, async () => {});
    expect(isCurrentAttemptClosed()).toBe(false);
  });

  it('fencedRejection rejects with a branded TestEndedError', async () => {
    await expect(fencedRejection("'tap'")).rejects.toSatisfy((err) => isTestEndedError(err));
    await expect(fencedRejection("'tap'")).rejects.toThrow(/already ended/);
  });

  it('TestEndedError is not mistaken for a recoverable infrastructure error', () => {
    expect(isRecoverableInfrastructureError(new TestEndedError("'tap'"))).toBe(false);
  });
});

describe('trace collector fencing', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function makeCollector(): TraceCollector {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-fence-test-'));
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: false,
      network: false,
      deviceLogs: false,
      daemonLogs: false,
    };
    return new TraceCollector(config, tempDir);
  }

  it('drops action/assertion/group writes from a closed attempt context', async () => {
    const collector = makeCollector();
    const token: AttemptToken = { closed: true };
    await runInAttemptContext(token, async () => {
      collector.startGroup('zombie group');
      collector.addActionEvent({
        category: 'tap', action: 'tap', duration: 1, success: true,
        hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
      collector.addAssertionEvent({
        assertion: 'toBeVisible', passed: true, duration: 1, attempts: 1,
        soft: false, negated: false,
      });
      collector.endGroup();
    });
    expect(collector.events).toHaveLength(0);
    expect(collector.currentActionIndex).toBe(0);
  });

  it('a fenced zombie cannot clobber the live attempt pending operation', async () => {
    const collector = makeCollector();
    let liveFailed = false;
    collector.setPendingOperation(() => { liveFailed = true; });

    const token: AttemptToken = { closed: true };
    await runInAttemptContext(token, async () => {
      collector.setPendingOperation(() => {});
      collector.clearPendingOperation();
    });

    // The live handler must survive the zombie's set + clear.
    collector.failPendingOperation('timeout');
    expect(liveFailed).toBe(true);
  });

  it('still records writes from an open context and from outside any context', () => {
    const collector = makeCollector();
    collector.addActionEvent({
      category: 'tap', action: 'tap', duration: 1, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
    });
    expect(collector.events).toHaveLength(1);
  });
});
