import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { TraceCollector } from '../trace/trace-collector.js';
import { appendEventsToTrace, packageTrace, readTraceActionCount } from '../trace/trace-packager.js';
import type { TraceConfig, TraceDeviceInfo } from '../trace/types.js';

function makeConfig(overrides: Partial<TraceConfig> = {}): TraceConfig {
  return {
    mode: 'on',
    screenshots: false,
    snapshots: false,
    sources: false,
    attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    ...overrides,
  };
}

function makeActionEvent(overrides: Record<string, unknown> = {}) {
  return {
    category: 'tap' as const,
    action: 'tap',
    duration: 10,
    success: true,
    hasScreenshotBefore: false,
    hasScreenshotAfter: false,
    hasHierarchyBefore: false,
    hasHierarchyAfter: false,
    ...overrides,
  };
}

describe('trace packager', () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-output-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('creates a valid zip with trace.json and metadata.json', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };

    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      selector: '{"text":"Hello"}',
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
      inputValue: 'world',
      duration: 100,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'my test',
      testStatus: 'passed',
      testDuration: 500,
      startTime: 1000,
      endTime: 1500,
      device: { serial: 'emulator-5554', isEmulator: true },
      tapsmithVersion: '0.1.0',
      outputDir,
    });

    expect(fs.existsSync(zipPath)).toBe(true);
    expect(zipPath.endsWith('.zip')).toBe(true);

    // Verify zip contents
    const zipData = new Uint8Array(fs.readFileSync(zipPath));
    const files = unzipSync(zipData);

    // metadata.json
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.version).toBe(1);
    expect(metadata.testName).toBe('my test');
    expect(metadata.testStatus).toBe('passed');
    expect(metadata.tapsmithVersion).toBe('0.1.0');
    expect(metadata.actionCount).toBe(2);
    expect(metadata.device.serial).toBe('emulator-5554');

    // trace.json (NDJSON)
    const traceLines = strFromU8(files['trace.json']).trim().split('\n');
    expect(traceLines).toHaveLength(2);
    const event0 = JSON.parse(traceLines[0]);
    expect(event0.type).toBe('action');
    expect(event0.action).toBe('tap');
    expect(event0.actionIndex).toBe(0);
    const event1 = JSON.parse(traceLines[1]);
    expect(event1.action).toBe('type');
    expect(event1.actionIndex).toBe(1);
  });

  it('includes source files when configured', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: true,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };

    // Create a fake source file
    const sourceFile = path.join(tempDir, 'test.ts');
    fs.writeFileSync(sourceFile, 'test("hello", () => {})');

    const collector = new TraceCollector(config, tempDir);

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'source test',
      testStatus: 'passed',
      testDuration: 100,
      startTime: 1000,
      endTime: 1100,
      device: { serial: 'test', isEmulator: false },
      tapsmithVersion: '0.1.0',
      outputDir,
      sourceFiles: [sourceFile],
    });

    const zipData = new Uint8Array(fs.readFileSync(zipPath));
    const files = unzipSync(zipData);
    expect(files['sources.json']).toBeDefined();
    const sources = JSON.parse(strFromU8(files['sources.json']));
    // sources.json keys are forward-slash normalized by packageTrace.
    expect(sources[sourceFile.replace(/\\/g, '/')]).toBe('test("hello", () => {})');
  });

  it('records failed test metadata', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };

    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 50,
      success: false,
      error: 'Element not found',
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'failing test',
      testStatus: 'failed',
      testDuration: 200,
      startTime: 1000,
      endTime: 1200,
      device: { serial: 'test', isEmulator: false },
      tapsmithVersion: '0.1.0',
      error: 'Element not found',
      outputDir,
    });

    const zipData = new Uint8Array(fs.readFileSync(zipPath));
    const files = unzipSync(zipData);
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.testStatus).toBe('failed');
    expect(metadata.error).toBe('Element not found');
  });
});

describe('packageTrace sources.json', () => {
  it('writes referenced source files keyed by absolute path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-'));
    try {
      const srcFile = path.join(tmp, 'helper.ts');
      fs.writeFileSync(srcFile, 'export const x = 1\n');

      const device: TraceDeviceInfo = { serial: 'test', isEmulator: false };
      const c = new TraceCollector(
        { mode: 'on', screenshots: false, snapshots: false, sources: true, attachments: false, network: false, deviceLogs: false, daemonLogs: false },
        tmp,
      );
      c.addActionEvent({
        category: 'tap', action: 'tap', duration: 1, success: true,
        hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
        sourceLocation: { file: srcFile, line: 1 }, stack: [{ file: srcFile, line: 1 }],
      });

      const zipPath = packageTrace(c, {
        testFile: srcFile, testName: 't', testStatus: 'passed', testDuration: 1,
        startTime: 1, endTime: 2, device,
        tapsmithVersion: '0.0.0', outputDir: tmp, sourceFiles: [srcFile],
      });

      const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      const sources = JSON.parse(new TextDecoder().decode(files['sources.json']));
      // sources.json keys are forward-slash normalized by packageTrace.
      expect(sources[srcFile.replace(/\\/g, '/')]).toBe('export const x = 1\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('packageTrace screenshot cleanup', () => {
  it('deletes owned screenshots but preserves external (replayed hook) screenshots', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-ext-'));
    try {
      const collector = new TraceCollector(makeConfig({ screenshots: true }), tmp);

      // Owned capture: written into this collector's temp dir.
      const { actionIndex } = await collector.captureBeforeAction(
        async () => Buffer.from('own-png'),
        async () => undefined,
      );
      collector.addActionEvent(makeActionEvent({ hasScreenshotBefore: true }), actionIndex);
      const ownedPath = collector.screenshots[0].diskPath;

      // External capture: a beforeAll screenshot replayed into this collector,
      // still needed by later tests' replays after this trace packages.
      const externalPath = path.join(tmp, 'ba-action-000-before.png');
      fs.writeFileSync(externalPath, Buffer.from('hook-png'));
      collector.ingestReplayedEvent(
        {
          type: 'action', actionIndex: 5, timestamp: 1000,
          ...makeActionEvent({ hasScreenshotBefore: true }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial trace event literal
        } as any,
        { screenshotBefore: externalPath },
      );

      const zipPath = packageTrace(collector, {
        testFile: 't.ts', testName: 't', testStatus: 'passed', testDuration: 1,
        startTime: 1, endTime: 2, device: { serial: 'test', isEmulator: false },
        tapsmithVersion: '0.0.0', outputDir: tmp,
      });

      const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      expect(files['screenshots/action-000-before.png']).toBeDefined();
      expect(files['screenshots/action-005-before.png']).toBeDefined();
      expect(fs.existsSync(ownedPath)).toBe(false);
      expect(fs.existsSync(externalPath)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('appendEventsToTrace', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-append-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function packageBaseTrace(): string {
    const collector = new TraceCollector(makeConfig(), path.join(tmp, 'base'));
    collector.addActionEvent(makeActionEvent());
    collector.addActionEvent(makeActionEvent({ action: 'type' }));
    return packageTrace(collector, {
      testFile: 't.ts', testName: 'last test', testStatus: 'passed', testDuration: 100,
      startTime: 1000, endTime: 1100, device: { serial: 'test', isEmulator: false },
      tapsmithVersion: '0.0.0', outputDir: tmp,
    });
  }

  it('reads the action count from a packaged trace', () => {
    const zipPath = packageBaseTrace();
    expect(readTraceActionCount(zipPath)).toBe(2);
  });

  it('appends hook events, screenshots, and hierarchies to an existing archive', async () => {
    const zipPath = packageBaseTrace();

    // The hook collector records with its own zero-based indices (like the
    // runner's afterAll collector); the offset is applied at append time.
    const hookCollector = new TraceCollector(
      makeConfig({ screenshots: true, snapshots: true }),
      path.join(tmp, 'hook'),
    );
    hookCollector.startGroup('afterAll Hooks');
    // A capture reserves the action's index; the emit hands it back so the
    // event lands where the screenshot was written.
    const { actionIndex } = await hookCollector.captureBeforeAction(
      async () => Buffer.from('after-all-png'),
      async () => '<hierarchy/>',
    );
    hookCollector.addActionEvent(makeActionEvent({
      action: 'openDeepLink', hasScreenshotBefore: true, hasHierarchyBefore: true,
    }), actionIndex);
    hookCollector.endGroup();

    appendEventsToTrace(zipPath, hookCollector, Date.now(), readTraceActionCount(zipPath) + 1);

    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const events = strFromU8(files['trace.json']).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string; name?: string; action?: string; actionIndex?: number });

    // Original events are preserved, hook events appended after them.
    expect(events[0].action).toBe('tap');
    expect(events[1].action).toBe('type');
    expect(events.some((e) => e.type === 'group-start' && e.name === 'afterAll Hooks')).toBe(true);
    const hookAction = events.find((e) => e.action === 'openDeepLink');
    expect(hookAction?.actionIndex).toBe(3);

    // Captures land at the offset archive paths.
    expect(files['screenshots/action-003-before.png']).toBeDefined();
    expect(files['hierarchy/action-003-before.xml']).toBeDefined();

    // Metadata reflects the appended events.
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.actionCount).toBe(4);
    expect(metadata.screenshotCount).toBe(1);
    expect(metadata.testName).toBe('last test');
  });

  it('sanitizes malformed metadata fields instead of serializing NaN', () => {
    const zipPath = packageBaseTrace();
    // Corrupt the archive's metadata the way an older/foreign trace might
    // look: numeric fields missing or carrying the wrong type.
    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    metadata.actionCount = 'two';
    delete metadata.endTime;
    delete metadata.screenshotCount;
    files['metadata.json'] = new TextEncoder().encode(JSON.stringify(metadata));
    fs.writeFileSync(zipPath, zipSync(files));

    const hookCollector = new TraceCollector(makeConfig(), path.join(tmp, 'hook'));
    hookCollector.startGroup('afterAll Hooks');
    hookCollector.addActionEvent(makeActionEvent());
    hookCollector.endGroup();
    appendEventsToTrace(zipPath, hookCollector, 5000, 3);

    const amended = JSON.parse(
      strFromU8(unzipSync(new Uint8Array(fs.readFileSync(zipPath)))['metadata.json']),
    );
    expect(amended.actionCount).toBe(4); // 3 offset + 1 hook action, not NaN/null
    expect(amended.endTime).toBe(5000);
    expect(amended.screenshotCount).toBe(0);
  });

  it('does not bump actionCount when the hook collector has events but no actions', () => {
    const zipPath = packageBaseTrace();

    // Console entries record events without advancing the action index —
    // actionCount must not absorb the offset's +1 slack in that case.
    const hookCollector = new TraceCollector(makeConfig(), path.join(tmp, 'hook'));
    hookCollector.addLogcatEntry('log', 'teardown message');
    appendEventsToTrace(zipPath, hookCollector, Date.now(), readTraceActionCount(zipPath) + 1);

    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.actionCount).toBe(2);
    const events = strFromU8(files['trace.json']).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((e) => e.type === 'console')).toHaveLength(1);
  });

  it('leaves the archive untouched when the hook collector recorded nothing', () => {
    const zipPath = packageBaseTrace();
    const before = fs.readFileSync(zipPath);

    const hookCollector = new TraceCollector(makeConfig(), path.join(tmp, 'hook'));
    appendEventsToTrace(zipPath, hookCollector, Date.now());

    expect(fs.readFileSync(zipPath).equals(before)).toBe(true);
  });
});
