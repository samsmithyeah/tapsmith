import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraceCollector, extractSourceLocation } from '../trace/trace-collector.js';
import type { TraceConfig, ActionTraceEvent, AssertionTraceEvent, ConsoleTraceEvent, GroupTraceEvent } from '../trace/types.js';

describe('TraceCollector', () => {
  let tempDir: string;
  let config: TraceConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-test-'));
    config = {
      mode: 'on',
      screenshots: true,
      snapshots: true,
      sources: true,
      attachments: true, network: false,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('starts with zero events and action index', () => {
    const collector = new TraceCollector(config, tempDir);
    expect(collector.events).toHaveLength(0);
    expect(collector.currentActionIndex).toBe(0);
  });

  it('records action events with incrementing index', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 42,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.addActionEvent({
      category: 'type',
      action: 'type',
      inputValue: 'hello',
      duration: 100,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    expect(collector.events).toHaveLength(2);
    expect(collector.currentActionIndex).toBe(2);

    const ev0 = collector.events[0] as ActionTraceEvent;
    expect(ev0.type).toBe('action');
    expect(ev0.actionIndex).toBe(0);
    expect(ev0.action).toBe('tap');

    const ev1 = collector.events[1] as ActionTraceEvent;
    expect(ev1.actionIndex).toBe(1);
    expect(ev1.action).toBe('type');
    expect(ev1.inputValue).toBe('hello');
  });

  it('records assertion events', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addAssertionEvent({
      assertion: 'toBeVisible',
      selector: '{"text":"OK"}',
      passed: true,
      soft: false,
      negated: false,
      duration: 50,
      attempts: 1,
    });

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0];
    expect(ev.type).toBe('assertion');
  });

  it('records group start/end events', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.startGroup('Login flow');
    collector.endGroup();

    expect(collector.events).toHaveLength(2);
    const start = collector.events[0] as GroupTraceEvent;
    expect(start.type).toBe('group-start');
    expect(start.name).toBe('Login flow');
    const end = collector.events[1] as GroupTraceEvent;
    expect(end.type).toBe('group-end');
    expect(end.name).toBe('Login flow');
  });

  it('records error events', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addError('Something went wrong', 'Error: Something went wrong\n  at test.ts:5');

    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].type).toBe('error');
  });

  it('records logcat entries', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addLogcatEntry('info', 'App launched');

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0] as ConsoleTraceEvent;
    expect(ev.type).toBe('console');
    expect(ev.source).toBe('device');
    expect(ev.level).toBe('info');
    expect(ev.message).toBe('App launched');
  });

  it('produces valid NDJSON output', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 10,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.addActionEvent({
      category: 'type',
      action: 'type',
      duration: 20,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    const ndjson = collector.toNDJSON();
    const lines = ndjson.trim().split('\n');
    expect(lines).toHaveLength(2);

    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // ── Pending operation (timeout detection) ──

  it('failPendingOperation emits a failed action event for in-flight action', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation((error) => {
      collector.addActionEvent({
        category: 'tap',
        action: 'tap',
        selector: '{"text":"Submit"}',
        duration: 5000,
        success: false,
        error,
        hasScreenshotBefore: true,
        hasScreenshotAfter: false,
        hasHierarchyBefore: false,
        hasHierarchyAfter: false,
      });
    });

    collector.failPendingOperation('Test timed out after 10000ms');

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0] as ActionTraceEvent;
    expect(ev.type).toBe('action');
    expect(ev.action).toBe('tap');
    expect(ev.success).toBe(false);
    expect(ev.error).toBe('Test timed out after 10000ms');
    expect(ev.hasScreenshotBefore).toBe(true);
    expect(ev.hasScreenshotAfter).toBe(false);
  });

  it('failPendingOperation emits a failed assertion event for in-flight assertion', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation((error) => {
      collector.addAssertionEvent({
        assertion: 'toBeVisible',
        selector: '{"text":"OK"}',
        passed: false,
        soft: false,
        negated: false,
        duration: 5000,
        attempts: 20,
        error,
      });
    });

    collector.failPendingOperation('Test timed out after 10000ms');

    expect(collector.events).toHaveLength(1);
    const ev = collector.events[0] as AssertionTraceEvent;
    expect(ev.type).toBe('assertion');
    expect(ev.assertion).toBe('toBeVisible');
    expect(ev.passed).toBe(false);
    expect(ev.error).toBe('Test timed out after 10000ms');
  });

  it('failPendingOperation is a no-op when no pending operation', () => {
    const collector = new TraceCollector(config, tempDir);
    collector.failPendingOperation('Test timed out');
    expect(collector.events).toHaveLength(0);
  });

  it('clearPendingOperation prevents subsequent failPendingOperation from firing', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation(() => {
      collector.addActionEvent({
        category: 'tap', action: 'tap', duration: 0, success: false,
        error: 'timeout', hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
    });

    collector.clearPendingOperation();
    collector.failPendingOperation('timeout');
    expect(collector.events).toHaveLength(0);
  });

  it('failPendingOperation only fires once (idempotent)', () => {
    const collector = new TraceCollector(config, tempDir);

    collector.setPendingOperation((error) => {
      collector.addActionEvent({
        category: 'tap', action: 'tap', duration: 0, success: false,
        error, hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
      });
    });

    collector.failPendingOperation('first timeout');
    collector.failPendingOperation('second timeout');

    expect(collector.events).toHaveLength(1);
    expect((collector.events[0] as ActionTraceEvent).error).toBe('first timeout');
  });

  it('intercepts and records console output', () => {
    const collector = new TraceCollector(config, tempDir);
    const originalLog = console.log;

    collector.startConsoleCapture();
    // console.log is now intercepted — it still calls the original but also records
    console.log('test message');
    collector.stopConsoleCapture();

    // console should be restored
    expect(console.log).toBe(originalLog);

    // Check that the console output was recorded
    const consoleEvents = collector.events.filter(
      (e) => e.type === 'console',
    ) as ConsoleTraceEvent[];
    expect(consoleEvents).toHaveLength(1);
    expect(consoleEvents[0].message).toBe('test message');
    expect(consoleEvents[0].source).toBe('test');
    expect(consoleEvents[0].level).toBe('log');
  });
});

describe('extractSourceLocation', () => {
  it('extracts file, line, column from a stack trace', () => {
    const stack = `Error: test
    at Object.<anonymous> (/Users/test/project/e2e/login.test.ts:15:3)
    at Module._compile (internal/modules/cjs/loader.js:1068:30)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      file: '/Users/test/project/e2e/login.test.ts',
      line: 15,
      column: 3,
    });
  });

  it('skips internal pilot frames', () => {
    const stack = `Error: test
    at Device.tap (/Users/test/node_modules/pilot/src/device.ts:50:10)
    at Object.<anonymous> (/Users/test/project/tests/app.test.ts:20:5)
    at Module._compile (internal/modules/cjs/loader.js:1068:30)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toEqual({
      file: '/Users/test/project/tests/app.test.ts',
      line: 20,
      column: 5,
    });
  });

  it('returns undefined for stack with only internal frames', () => {
    const stack = `Error: test
    at Device.tap (/Users/test/node_modules/pilot/src/device.ts:50:10)
    at someInternalFn (node:internal/process:123:4)`;

    const loc = extractSourceLocation(stack);
    expect(loc).toBeUndefined();
  });
});
