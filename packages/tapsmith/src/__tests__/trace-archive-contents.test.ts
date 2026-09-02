/**
 * What actually lands *inside* a generated trace archive.
 *
 * The rest of the trace suite covers the pieces in isolation:
 * `trace-collector.test.ts` checks the event stream, `trace-packager.test.ts`
 * checks the zip built from a hand-assembled collector. Neither drives the
 * production path — a real `Device` performing actions through `tracedAction`,
 * capturing per-action screenshots and hierarchy snapshots, with the runner
 * packaging the result — so the cross-references the trace viewer navigates by
 * were never asserted end to end:
 *
 *  - an action event claiming `hasScreenshotBefore` and the
 *    `screenshots/action-NNN-before.png` member that has to back it,
 *  - the same for `hierarchy/action-NNN-before.xml`,
 *  - `network.json` and the `network/{req,res}-N.bin` bodies its entries point
 *    at, plus the action each entry is attributed to.
 *
 * Every capture here is distinct per action (a differently-coloured PNG, a
 * different XML document), so a capture attached to the wrong action index
 * fails instead of passing on shape alone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { unzipSync } from 'fflate';

import {
  test as tapsmithTest,
  _internal,
  type RunOptions,
} from '../runner.js';
import { Device } from '../device.js';
// Tapsmith's own expect, aliased so it doesn't shadow Vitest's.
import { expect as tapsmithExpect } from '../expect.js';
import { getActiveTraceCollector } from '../trace/trace-collector.js';
import type { TapsmithConfig } from '../config.js';
import type { TapsmithGrpcClient, ActionResponse } from '../grpc-client.js';
import type {
  AnyTraceEvent,
  ActionTraceEvent,
  AssertionTraceEvent,
  NetworkEntry,
  TraceMetadata,
} from '../trace/types.js';

const { pushContext, popContext, runSuiteContext } = _internal;

// ─── Fixtures ───

/** A solid-colour PNG, built so each action's screenshot is byte-distinct. */
function solidPng(rgb: [number, number, number], size = 2): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The hierarchy the device reports for the n-th capture. */
function hierarchyXml(n: number): string {
  return `<hierarchy rotation="0"><node index="${n}" text="screen-${n}" /></hierarchy>`;
}

function successResponse(): ActionResponse {
  return { requestId: '1', success: true, errorType: '', errorMessage: '', screenshot: Buffer.alloc(0) };
}

/** Stand-in for the bidirectional route stream the route manager subscribes to. */
class FakeRouteStream extends EventEmitter {
  cancel = vi.fn();
  write(): boolean {
    return true;
  }
}

interface CaptureLog {
  /** Screenshots handed to the SDK, in capture order. */
  screenshots: Buffer[]
  /** Hierarchy documents handed to the SDK, in capture order. */
  hierarchies: string[]
}

/**
 * A gRPC client that answers every capture with fresh, distinct content and
 * records what it handed over, so the archive can be checked against the exact
 * bytes the device produced for each action.
 */
function makeCapturingClient(
  log: CaptureLog,
  overrides: Partial<Record<string, unknown>> = {},
): TapsmithGrpcClient {
  const palette: [number, number, number][] = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255],
  ];
  return {
    takeScreenshot: vi.fn(async () => {
      const png = solidPng(palette[log.screenshots.length % palette.length]);
      log.screenshots.push(png);
      return { requestId: '1', success: true, data: png, errorMessage: '' };
    }),
    getUiHierarchy: vi.fn(async () => {
      const xml = hierarchyXml(log.hierarchies.length);
      log.hierarchies.push(xml);
      return { requestId: '1', hierarchyXml: xml, errorMessage: '' };
    }),
    tapXY: vi.fn(async () => successResponse()),
    inputText: vi.fn(async () => successResponse()),
    swipe: vi.fn(async () => successResponse()),
    findElement: vi.fn(async () => ({ requestId: '1', found: false, errorMessage: '' })),
    waitForIdle: vi.fn(async () => successResponse()),
    startNetworkCapture: vi.fn(async () => ({
      requestId: '1', success: true, proxyPort: 12345, errorMessage: '',
    })),
    stopNetworkCapture: vi.fn(async () => ({
      requestId: '1', success: true, entries: [], errorMessage: '',
    })),
    // The route manager subscribes to this as soon as capture starts; without
    // it the runner logs a spurious "capture failed to start" warning and the
    // network path under test is only half-exercised.
    networkRouteStream: vi.fn(() => new FakeRouteStream()),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused mock of the RPCs these actions use
  } as any as TapsmithGrpcClient;
}

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

// ─── Archive reader ───

interface Archive {
  files: Record<string, Uint8Array>
  metadata: TraceMetadata
  events: AnyTraceEvent[]
  actions: ActionTraceEvent[]
  /**
   * Everything that occupies a slot in the shared action-index space and can
   * therefore own captures — actions and assertions alike.
   */
  steps: (ActionTraceEvent | AssertionTraceEvent)[]
  /** network.json entries, or [] when the archive has no network.json. */
  network: NetworkEntry[]
  /** Archive members under `screenshots/`, sorted. */
  screenshotPaths: string[]
  /** Archive members under `hierarchy/`, sorted. */
  hierarchyPaths: string[]
}

function readArchive(zipPath: string): Archive {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const text = (name: string) => new TextDecoder().decode(files[name]);
  const ndjson = <T>(name: string): T[] => (files[name]
    ? text(name).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)
    : []);
  const events = ndjson<AnyTraceEvent>('trace.json');
  return {
    files,
    metadata: JSON.parse(text('metadata.json')) as TraceMetadata,
    events,
    actions: events.filter((e): e is ActionTraceEvent => e.type === 'action'),
    steps: events.filter((e): e is ActionTraceEvent | AssertionTraceEvent =>
      e.type === 'action' || e.type === 'assertion'),
    network: ndjson<NetworkEntry>('network.json'),
    screenshotPaths: Object.keys(files).filter((f) => f.startsWith('screenshots/')).sort(),
    hierarchyPaths: Object.keys(files).filter((f) => f.startsWith('hierarchy/')).sort(),
  };
}

/** The action index encoded in a capture member's name. */
function capturedIndex(archivePath: string): number {
  const m = /action-(\d+)-(?:before|after)\./.exec(archivePath);
  if (!m) throw new Error(`not an action capture path: ${archivePath}`);
  return parseInt(m[1], 10);
}

const pad = (index: number) => String(index).padStart(3, '0');

/**
 * For each recorded step, what the event claims about its before-captures
 * against what the archive actually holds. Equal lists mean every claim is
 * backed and nothing is silently missing.
 */
function claimsVsBacking(archive: Archive) {
  const claimed = archive.steps.map((step) => ({
    index: step.actionIndex,
    screenshot: !!step.hasScreenshotBefore,
    hierarchy: !!step.hasHierarchyBefore,
  }));
  const backed = archive.steps.map((step) => ({
    index: step.actionIndex,
    screenshot: `screenshots/action-${pad(step.actionIndex)}-before.png` in archive.files,
    hierarchy: `hierarchy/action-${pad(step.actionIndex)}-before.xml` in archive.files,
  }));
  return { claimed, backed };
}

// ─── Tests ───

describe('generated trace archive', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-archive-contents-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeOpts(device: Device, config: Partial<TapsmithConfig>, extra: Partial<RunOptions> = {}): RunOptions {
    return {
      config: makeConfig({ rootDir: tempRoot, outputDir: 'out', ...config }),
      device,
      ...extra,
    };
  }

  /**
   * Run one test whose body performs three device actions, each preceded by a
   * screenshot + hierarchy capture, and return the packaged archive.
   */
  async function runThreeActions(
    config: Partial<TapsmithConfig>,
    clientOverrides: Partial<Record<string, unknown>> = {},
  ): Promise<{ archive: Archive; log: CaptureLog }> {
    const log: CaptureLog = { screenshots: [], hierarchies: [] };
    const device = new Device(makeCapturingClient(log, clientOverrides), { package: 'com.example.app' });

    pushContext();
    tapsmithTest('three actions', async () => {
      await device.tapXY(10, 20);
      await device.inputText('hello');
      await device.swipe('up');
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(device, config));
    expect(result.tests[0].error?.message).toBeUndefined();
    expect(result.tests[0].status).toBe('passed');
    expect(result.tests[0].tracePath).toBeTruthy();
    return { archive: readArchive(result.tests[0].tracePath!), log };
  }

  it('backs every claimed screenshot with the exact bytes captured for that action', async () => {
    const { archive, log } = await runThreeActions({
      trace: { mode: 'on', screenshots: true, snapshots: false, sources: false, network: false, deviceLogs: false },
    });

    expect(archive.actions.map((a) => a.action)).toEqual(['tapXY', 'inputText', 'swipe']);
    expect(archive.actions.map((a) => a.actionIndex)).toEqual([0, 1, 2]);

    // Each action claims a before-screenshot, and the member backing it holds
    // the screenshot the device returned for *that* action — not a neighbour's.
    for (const action of archive.actions) {
      expect(action.hasScreenshotBefore).toBe(true);
      const member = `screenshots/action-${String(action.actionIndex).padStart(3, '0')}-before.png`;
      expect(archive.files[member], `${member} missing`).toBeDefined();
      expect(Buffer.from(archive.files[member])).toEqual(log.screenshots[action.actionIndex]);
    }

    // Nothing claims an after-screenshot: the viewer reads the next action's
    // before-shot as the "after" view, which is why the runner takes one
    // trailing capture past the last action to supply the terminal state.
    expect(archive.actions.every((a) => a.hasScreenshotAfter === false)).toBe(true);
    expect(archive.screenshotPaths).toEqual([
      'screenshots/action-000-before.png',
      'screenshots/action-001-before.png',
      'screenshots/action-002-before.png',
      'screenshots/action-003-before.png',
    ]);
    expect(archive.metadata.actionCount).toBe(3);
    expect(capturedIndex(archive.screenshotPaths.at(-1)!)).toBe(archive.metadata.actionCount);

    // screenshotCount is what the viewer reports; it has to match the members.
    expect(archive.metadata.screenshotCount).toBe(archive.screenshotPaths.length);

    // Every capture is a decodable PNG, distinct from every other.
    const digests = new Set<string>();
    for (const member of archive.screenshotPaths) {
      const png = Buffer.from(archive.files[member]);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.readUInt32BE(16)).toBe(2); // IHDR width
      expect(png.readUInt32BE(20)).toBe(2); // IHDR height
      digests.add(png.toString('base64'));
    }
    expect(digests.size).toBe(archive.screenshotPaths.length);
  });

  it('backs every claimed hierarchy snapshot with the XML captured for that action', async () => {
    const { archive, log } = await runThreeActions({
      trace: { mode: 'on', screenshots: false, snapshots: true, sources: false, network: false, deviceLogs: false },
    });

    for (const action of archive.actions) {
      expect(action.hasHierarchyBefore).toBe(true);
      const member = `hierarchy/action-${String(action.actionIndex).padStart(3, '0')}-before.xml`;
      expect(archive.files[member], `${member} missing`).toBeDefined();
      expect(new TextDecoder().decode(archive.files[member])).toBe(log.hierarchies[action.actionIndex]);
    }

    // One snapshot per action and no trailing capture: the runner's
    // terminal-state capture is gated on the screenshots channel, so a
    // snapshots-only trace stops at the last action.
    expect(archive.hierarchyPaths).toEqual([
      'hierarchy/action-000-before.xml',
      'hierarchy/action-001-before.xml',
      'hierarchy/action-002-before.xml',
    ]);
    expect(archive.metadata.actionCount).toBe(3);
    // No screenshots requested — the archive must not carry any.
    expect(archive.screenshotPaths).toEqual([]);
    expect(archive.metadata.screenshotCount).toBe(0);
  });

  it('leaves no capture member unclaimed and no claim unbacked', async () => {
    const { archive } = await runThreeActions({
      trace: { mode: 'on', screenshots: true, snapshots: true, sources: false, network: false, deviceLogs: false },
    });

    // The invariant the Screenshot and Hierarchy panels navigate by: capture
    // members exist for exactly the recorded actions, plus the single trailing
    // terminal-state capture at index === actionCount.
    const expectedIndices = [0, 1, 2, 3];
    expect(archive.screenshotPaths.map(capturedIndex)).toEqual(expectedIndices);
    expect(archive.hierarchyPaths.map(capturedIndex)).toEqual(expectedIndices);

    const { claimed, backed } = claimsVsBacking(archive);
    expect(backed).toEqual(claimed);

    expect(archive.metadata.traceConfig).toMatchObject({ screenshots: true, snapshots: true });
  });

  it('gives actions and assertions distinct slots in one capture namespace', async () => {
    // Assertions capture the same way actions do and draw from the same
    // action-index counter. If the two ever shared an index, one step's
    // screenshot would overwrite the other's in the archive.
    const log: CaptureLog = { screenshots: [], hierarchies: [] };
    const element = {
      elementId: 'e1', className: 'android.widget.TextView', text: 'Hi',
      contentDescription: '', resourceId: '', enabled: true, visible: true,
      clickable: false, focusable: false, scrollable: false,
      bounds: { left: 0, top: 0, right: 40, bottom: 20 },
      hint: '', checked: false, selected: false, focused: false,
      role: 'text', viewportRatio: 1,
    };
    const device = new Device(makeCapturingClient(log, {
      findElement: vi.fn(async () => ({ requestId: '1', found: true, errorMessage: '', element })),
      findElements: vi.fn(async () => ({ requestId: '1', elements: [element], errorMessage: '' })),
    }), { package: 'com.example.app' });

    pushContext();
    tapsmithTest('mixed', async () => {
      await device.tapXY(1, 2);
      await tapsmithExpect(device.getByText('Hi')).toBeVisible();
      await device.inputText('x');
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(device, {
      trace: { mode: 'on', screenshots: true, snapshots: true, sources: false, network: false, deviceLogs: false },
    }));
    // Surface the message rather than just 'failed' if the body throws.
    expect(result.tests[0].error?.message).toBeUndefined();
    expect(result.tests[0].status).toBe('passed');

    const archive = readArchive(result.tests[0].tracePath!);
    expect(archive.steps.map((s) => s.type)).toEqual(['action', 'assertion', 'action']);
    // One slot each, in execution order, no reuse.
    expect(archive.steps.map((s) => s.actionIndex)).toEqual([0, 1, 2]);

    const { claimed, backed } = claimsVsBacking(archive);
    expect(claimed.every((c) => c.screenshot && c.hierarchy)).toBe(true);
    expect(backed).toEqual(claimed);

    // The assertion's own capture is the one taken while it was in flight.
    const assertionStep = archive.steps[1];
    const member = `hierarchy/action-${pad(assertionStep.actionIndex)}-before.xml`;
    expect(new TextDecoder().decode(archive.files[member])).toBe(log.hierarchies[assertionStep.actionIndex]);
  });

  it('records no captures at all when both sub-channels are off', async () => {
    const { archive, log } = await runThreeActions({
      trace: { mode: 'on', screenshots: false, snapshots: false, sources: false, network: false, deviceLogs: false },
    });

    expect(archive.actions).toHaveLength(3);
    expect(archive.screenshotPaths).toEqual([]);
    expect(archive.hierarchyPaths).toEqual([]);
    // Captures are gated before the RPC, not just before the archive write —
    // a trace run with both sub-channels off must not pay for either call.
    expect(log.screenshots).toEqual([]);
    expect(log.hierarchies).toEqual([]);
    expect(archive.actions.every((a) => !a.hasScreenshotBefore && !a.hasHierarchyBefore)).toBe(true);
  });

  it('writes captured network entries to network.json with their bodies as separate members', async () => {
    const requestBody = Buffer.from(JSON.stringify({ q: 'tapsmith' }));
    const responseJson = JSON.stringify({ items: ['a', 'b'] });
    const gzipped = zlib.gzipSync(Buffer.from(responseJson));

    const log: CaptureLog = { screenshots: [], hierarchies: [] };

    // The runner drains capture entries while the collector is still active,
    // so the mock can time each entry against the recorded actions instead of
    // guessing at wall clock. Both entries start between action 1 and action
    // 2 — the only window that makes `actionIndex === 1` the right answer.
    const startBetweenActions = (): number => {
      const timestamps = (getActiveTraceCollector()?.events ?? [])
        .filter((e) => e.type === 'action')
        .map((e) => e.timestamp);
      expect(timestamps).toHaveLength(3);
      expect(timestamps[2]).toBeGreaterThan(timestamps[1] + 1);
      return Math.floor((timestamps[1] + timestamps[2]) / 2);
    };

    // Two entries: one full request/response pair, and one bodyless entry, so
    // "no body" must not produce an empty member or a dangling path.
    const stopNetworkCapture = vi.fn(async () => ({
      requestId: '1',
      success: true,
      errorMessage: '',
      entries: [
        {
          method: 'POST',
          url: 'https://api.example.com/search',
          statusCode: 200,
          contentType: 'application/json',
          requestSize: requestBody.length,
          responseSize: gzipped.length,
          startTimeMs: startBetweenActions(),
          durationMs: 12,
          requestHeadersJson: JSON.stringify({ 'content-type': 'application/json' }),
          responseHeadersJson: JSON.stringify({ 'content-encoding': 'gzip', 'content-type': 'application/json' }),
          requestBody,
          responseBody: gzipped,
          isHttps: true,
          routeAction: 'continued',
        },
        {
          method: 'GET',
          url: 'https://api.example.com/ping',
          statusCode: 204,
          contentType: '',
          requestSize: 0,
          responseSize: 0,
          startTimeMs: startBetweenActions(),
          durationMs: 3,
          requestHeadersJson: '{}',
          responseHeadersJson: '{}',
          requestBody: Buffer.alloc(0),
          responseBody: Buffer.alloc(0),
          isHttps: true,
          routeAction: 'passthrough',
        },
      ],
    }));

    const device = new Device(makeCapturingClient(log, { stopNetworkCapture }), { package: 'com.example.app' });

    pushContext();
    tapsmithTest('network', async () => {
      await device.tapXY(1, 2);
      // Space the actions out so their recorded timestamps are distinct and an
      // entry can fall strictly between two of them.
      await new Promise((r) => setTimeout(r, 5));
      await device.inputText('x');
      await new Promise((r) => setTimeout(r, 5));
      await device.swipe('up');
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(device, {
      trace: { mode: 'on', screenshots: false, snapshots: false, sources: false, network: true, deviceLogs: false },
    }));

    expect(result.tests[0].error?.message).toBeUndefined();
    expect(result.tests[0].status).toBe('passed');
    const archive = readArchive(result.tests[0].tracePath!);

    expect(archive.network).toHaveLength(2);
    const [search, ping] = archive.network;

    expect(search).toMatchObject({
      index: 0,
      method: 'POST',
      url: 'https://api.example.com/search',
      status: 200,
      contentType: 'application/json',
      duration: 12,
      routeAction: 'continued',
    });
    // Transient body buffers must not be serialized into the JSON — they go in
    // their own members, referenced by path.
    expect('requestBody' in search).toBe(false);
    expect('responseBody' in search).toBe(false);
    expect(search.requestBodyPath).toBe('network/req-0.bin');
    expect(search.responseBodyPath).toBe('network/res-0.bin');
    expect(Buffer.from(archive.files['network/req-0.bin'])).toEqual(requestBody);
    // Stored decoded: the wire bytes were gzipped, the archive holds the JSON
    // the Network tab renders.
    expect(new TextDecoder().decode(archive.files['network/res-0.bin'])).toBe(responseJson);

    // A bodyless entry gets no path and no member.
    expect(ping).toMatchObject({ index: 1, method: 'GET', status: 204, routeAction: 'passthrough' });
    expect(ping.requestBodyPath).toBeUndefined();
    expect(ping.responseBodyPath).toBeUndefined();
    expect(archive.files['network/req-1.bin']).toBeUndefined();
    expect(archive.files['network/res-1.bin']).toBeUndefined();

    // Each entry is attributed to the action in flight when it started, so the
    // Network tab filters correctly per step.
    const secondAction = archive.actions[1];
    expect(secondAction.action).toBe('inputText');
    expect(search.actionIndex).toBe(secondAction.actionIndex);
    expect(ping.actionIndex).toBe(secondAction.actionIndex);
  });

  it('omits network.json entirely when nothing was captured', async () => {
    const { archive } = await runThreeActions({
      trace: { mode: 'on', screenshots: false, snapshots: false, sources: false, network: true, deviceLogs: false },
    });

    expect(archive.files['network.json']).toBeUndefined();
    expect(archive.metadata.traceConfig).toMatchObject({ network: true });
  });

  it('snapshots the test source alongside the events that reference it', async () => {
    const testFile = path.join(tempRoot, 'source-under-test.ts');
    fs.writeFileSync(testFile, 'export const marker = "traced source";\n');

    const log: CaptureLog = { screenshots: [], hierarchies: [] };
    const device = new Device(makeCapturingClient(log), { package: 'com.example.app' });

    pushContext();
    tapsmithTest('sourced', async () => {
      await device.tapXY(3, 4);
    });
    const ctx = popContext();

    const result = await runSuiteContext(ctx, '', [], [], makeOpts(device, {
      trace: { mode: 'on', screenshots: false, snapshots: false, sources: true, network: false, deviceLogs: false },
    }, { testFilePath: testFile }));

    const archive = readArchive(result.tests[0].tracePath!);
    const sources = JSON.parse(new TextDecoder().decode(archive.files['sources.json'])) as Record<string, string>;
    // sources.json is keyed by forward-slash absolute path.
    expect(sources[testFile.replace(/\\/g, '/')]).toContain('traced source');
    expect(archive.metadata.testFile).toBe(testFile);
  });
});
