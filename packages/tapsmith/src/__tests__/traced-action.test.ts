import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TraceCollector } from '../trace/trace-collector.js';
import { tracedAction, type TraceContext } from '../trace/traced-action.js';
import { _testId } from '../selectors.js';
import type { Selector } from '../selectors.js';
import type { TraceConfig, ActionTraceEvent } from '../trace/types.js';
import type { ActionResponse, CaptureTraceStateResponse } from '../grpc-client.js';

type CaptureOpts = { screenshot?: boolean; hierarchy?: boolean; elementSelector?: Selector };

describe('tracedAction — bounds from action result', () => {
  let tempDir: string;
  let config: TraceConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-traced-action-'));
    // Screenshots/snapshots off so the capture path needs no disk/device.
    config = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: false,
      network: false,
      deviceLogs: false,
      daemonLogs: false,
      screenshotScale: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeCtx() {
    const collector = new TraceCollector(config, tempDir);
    const captureTraceState = vi.fn(
      async (_opts: CaptureOpts): Promise<CaptureTraceStateResponse> => ({
        requestId: '',
        success: true,
        errorMessage: '',
        screenshotData: Buffer.alloc(0),
        hierarchyXml: '',
        elementFound: false,
      }),
    );
    const findElement = vi.fn(async () => ({ found: false }));
    const ctx: TraceContext = {
      collector,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
      findElement,
      captureTraceState,
    };
    return { collector, ctx, captureTraceState, findElement };
  }

  const bounds = { left: 10, top: 20, right: 30, bottom: 60 };

  it('reuses the tap action bounds and skips the pre-action element lookup', async () => {
    const { collector, ctx, captureTraceState, findElement } = makeCtx();
    const fn = async (): Promise<ActionResponse> => ({
      requestId: '', success: true, errorType: '', errorMessage: '',
      screenshot: Buffer.alloc(0), bounds,
    });

    await tracedAction(ctx, 'tap', 'tap', _testId('btn'), fn, 'Tap failed');

    // No separate element lookup performed for the bounds.
    expect(findElement).not.toHaveBeenCalled();
    expect(captureTraceState).toHaveBeenCalledTimes(1);
    expect(captureTraceState.mock.calls[0][0].elementSelector).toBeUndefined();

    const event = collector.events.at(-1) as ActionTraceEvent;
    expect(event.bounds).toEqual(bounds);
    expect(event.point).toEqual({ x: 20, y: 40 });
  });

  it('still performs the pre-action lookup for non-tap categories', async () => {
    const { ctx, captureTraceState } = makeCtx();
    const fn = async (): Promise<ActionResponse> => ({
      requestId: '', success: true, errorType: '', errorMessage: '',
      screenshot: Buffer.alloc(0),
    });

    await tracedAction(ctx, 'type', 'type', _testId('field'), fn, 'Type failed');

    // The hierarchy/element batch is still asked to resolve the element.
    expect(captureTraceState).toHaveBeenCalledTimes(1);
    expect(captureTraceState.mock.calls[0][0].elementSelector).toEqual(_testId('field'));
  });
});
