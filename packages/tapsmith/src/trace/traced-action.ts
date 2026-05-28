/**
 * Shared trace-recording wrapper for actions on Device and ElementHandle.
 *
 * Both classes need identical before/after screenshot + hierarchy capture,
 * element bounds lookup, and event emission logic. This module extracts that
 * common flow so neither class duplicates it.
 */

import type { TraceCollector } from './trace-collector.js';
import { extractSourceLocation } from './trace-collector.js';
import type { ActionCategory } from './types.js';
import type { ActionResponse, ElementInfo, CaptureTraceStateResponse } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import { selectorToProto } from '../selectors.js';

// ─── Trace context ───

export interface TraceContext {
  collector: TraceCollector
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
  findElement?: (selector: Selector, timeoutMs: number) => Promise<{ found: boolean; element?: ElementInfo }>
  captureTraceState?: (options: {
    screenshot?: boolean;
    hierarchy?: boolean;
    elementSelector?: Selector;
  }) => Promise<CaptureTraceStateResponse | undefined>
}

// ─── Shared helper ───

export async function tracedAction(
  ctx: TraceContext | undefined,
  action: string,
  category: ActionCategory,
  selector: Selector | undefined,
  fn: () => Promise<ActionResponse>,
  fallbackMsg: string,
  extra?: { inputValue?: string },
): Promise<void> {
  // No trace context — just run the action directly
  if (!ctx) {
    const res = await fn();
    if (!res.success) {
      throw new Error(res.errorMessage || fallbackMsg);
    }
    return;
  }

  const sourceLocation = extractSourceLocation(new Error().stack ?? '');
  const selectorStr = selector ? JSON.stringify(selectorToProto(selector)) : undefined;
  const log: string[] = [];

  let bounds: { left: number; top: number; right: number; bottom: number } | undefined;
  let point: { x: number; y: number } | undefined;

  log.push('Capturing before screenshot + hierarchy');

  // When the batched captureTraceState is available (iOS), use a single
  // round-trip for screenshot + hierarchy + element bounds instead of 3
  // separate gRPC calls that each trigger their own app.snapshot() IPC.
  let beforeCaptures: { screenshotBefore?: unknown; hierarchyBefore?: unknown } = {};
  let batchSuccess = false;

  if (ctx.captureTraceState) {
    const batchStart = Date.now();
    try {
      const batchResult = await ctx.captureTraceState({
        screenshot: ctx.collector.config.screenshots,
        hierarchy: ctx.collector.config.snapshots,
        elementSelector: selector,
      });
      if (batchResult?.success) {
        batchSuccess = true;
        const screenshotData = batchResult.screenshotData?.length
          ? batchResult.screenshotData : undefined;
        const hierarchyXml = batchResult.hierarchyXml || undefined;

        const { captures } = await ctx.collector.captureBeforeAction(
          () => Promise.resolve(screenshotData as Buffer | undefined),
          () => Promise.resolve(hierarchyXml),
        );
        beforeCaptures = captures;

        if (batchResult.elementFound && batchResult.element?.bounds) {
          bounds = batchResult.element.bounds;
          log.push(`Element found at [${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}] (${Date.now() - batchStart}ms)`);
          if (category === 'tap') {
            point = {
              x: (bounds.left + bounds.right) / 2,
              y: (bounds.top + bounds.bottom) / 2,
            };
            log.push(`Tap target: (${point.x}, ${point.y})`);
          }
        } else if (selector) {
          log.push(`Element lookup returned no match (${Date.now() - batchStart}ms)`);
        }
      } else {
        log.push(`Batch trace state capture failed: ${batchResult?.errorMessage ?? 'no response'}`);
      }
    } catch (err) {
      log.push(`Batch trace state capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!batchSuccess) {
    // Individual parallel calls (Android, or iOS fallback on batch failure)
    const boundsPromise = (selector && ctx.findElement)
      ? (async () => {
          const lookupStart = Date.now();
          try {
            const res = await ctx.findElement!(selector, 100);
            if (res.found && res.element?.bounds) {
              bounds = res.element.bounds;
              log.push(`Element found at [${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}] (${Date.now() - lookupStart}ms)`);
              if (category === 'tap') {
                point = {
                  x: (bounds.left + bounds.right) / 2,
                  y: (bounds.top + bounds.bottom) / 2,
                };
                log.push(`Tap target: (${point.x}, ${point.y})`);
              }
            } else {
              log.push(`Element lookup returned no match (${Date.now() - lookupStart}ms)`);
            }
          } catch {
            log.push(`Element lookup failed (${Date.now() - lookupStart}ms)`);
          }
        })()
      : Promise.resolve();

    const [, { captures }] = await Promise.all([
      boundsPromise,
      ctx.collector.captureBeforeAction(ctx.takeScreenshot, ctx.captureHierarchy),
    ]);
    beforeCaptures = captures;
  }

  // Stream a "started" lifecycle signal so UI mode can render an in-flight
  // row with a spinner immediately. The matching addActionEvent below will
  // emit at the same actionIndex with lifecycle='completed'.
  ctx.collector._emitActionStarted({
    category, action, selector: selectorStr, inputValue: extra?.inputValue,
    bounds, point, sourceLocation, log: [...log],
    hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
    hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
  });

  const start = Date.now();
  let success = true;
  let error: string | undefined;
  let errorStack: string | undefined;
  let caughtErr: unknown;

  // Local flag set by the fail handler — immune to interleaving from other actions
  let failedByTimeout = false;

  // Register pending operation so the runner can emit a failed event on timeout
  ctx.collector.setPendingOperation((timeoutError: string) => {
    failedByTimeout = true;
    ctx.collector.addActionEvent({
      category, action, selector: selectorStr, inputValue: extra?.inputValue,
      duration: Date.now() - start, success: false, error: timeoutError,
      bounds, point, log: [...log, `Timed out: ${timeoutError}`],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      sourceLocation,
    });
  });

  try {
    const res = await fn();
    if (!res.success) {
      success = false;
      error = res.errorMessage || fallbackMsg;
      throw new Error(error);
    }
  } catch (err) {
    success = false;
    if (err instanceof Error) { error = err.message; errorStack = err.stack; }
    else { error = String(err); }
    log.push(`Action failed: ${error} (${Date.now() - start}ms)`);
    caughtErr = err;
  }

  ctx.collector.clearPendingOperation();

  // If the runner's timeout already emitted a failed event, skip the normal emit
  if (failedByTimeout) {
    if (caughtErr !== undefined) {
      throw caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));
    }
    return;
  }

  if (success) {
    log.push(`Action completed successfully (${Date.now() - start}ms)`);
  }

  // Snapshot action duration before the async capture so it reflects the
  // actual action time, not action + screenshot overhead.
  const duration = Date.now() - start;

  // Emit event immediately so _actionIndex increments before the runner
  // emits group-end boundaries.  No after-capture — the trace viewer uses
  // the next action's before-screenshot as the "after" view (like Playwright).
  // This halves the screenshot overhead and avoids fire-and-forget reliability issues.
  ctx.collector.addActionEvent({
    category, action, selector: selectorStr, inputValue: extra?.inputValue,
    duration, success, error, errorStack,
    bounds, point, log,
    hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
    hasScreenshotAfter: false,
    hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
    hasHierarchyAfter: false,
    sourceLocation,
  });

  if (caughtErr !== undefined) {
    throw caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));
  }
}
