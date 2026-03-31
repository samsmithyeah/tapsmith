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
import type { ActionResponse, ElementInfo } from '../grpc-client.js';
import type { Selector } from '../selectors.js';
import { selectorToProto } from '../selectors.js';

// ─── Trace context ───

export interface TraceContext {
  collector: TraceCollector
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
  findElement?: (selector: Selector, timeoutMs: number) => Promise<{ found: boolean; element?: ElementInfo }>
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

  // Run element bounds lookup and before-captures in parallel — both are
  // best-effort and independent.  Short timeout on bounds since the element
  // should already exist (we're about to act on it).
  let bounds: { left: number; top: number; right: number; bottom: number } | undefined;
  let point: { x: number; y: number } | undefined;

  log.push('Capturing before screenshot + hierarchy');

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

  const [, { actionIndex, captures: beforeCaptures }] = await Promise.all([
    boundsPromise,
    ctx.collector.captureBeforeAction(ctx.takeScreenshot, ctx.captureHierarchy),
  ]);

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

  // Fire-and-forget the after-action capture so the test can proceed
  // immediately. This avoids consuming the visibility window of transient
  // UI elements (toasts, animations) with screenshot overhead.
  // The collector tracks pending captures and awaits them before packaging.
  const afterCapturePromise = ctx.collector.captureAfterAction(
    actionIndex, ctx.takeScreenshot, ctx.captureHierarchy,
  ).then((afterCaptures) => {
    ctx.collector.addActionEvent({
      category, action, selector: selectorStr, inputValue: extra?.inputValue,
      duration, success, error, errorStack,
      bounds, point, log,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: !!afterCaptures.screenshotAfter,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: !!afterCaptures.hierarchyAfter,
      sourceLocation,
    });
  }).catch(() => {
    // Best-effort: emit event without after-captures
    ctx.collector.addActionEvent({
      category, action, selector: selectorStr, inputValue: extra?.inputValue,
      duration, success, error, errorStack,
      bounds, point, log: [...log, 'After-action capture failed'],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      sourceLocation,
    });
  });
  ctx.collector.trackPendingCapture(afterCapturePromise);

  if (caughtErr !== undefined) {
    throw caughtErr instanceof Error ? caughtErr : new Error(String(caughtErr));
  }
}
