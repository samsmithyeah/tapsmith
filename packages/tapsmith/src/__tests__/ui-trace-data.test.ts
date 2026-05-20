import { describe, expect, it } from 'vitest';
import { emptyTraceData, reconcileTraceWallDuration } from '../ui-mode/hooks/use-trace-data.js';
import type { ActionTraceEvent } from '../trace/types.js';

function action(actionIndex: number, duration: number, wallDuration = duration): ActionTraceEvent {
  return {
    type: 'action',
    actionIndex,
    timestamp: 1000 + actionIndex,
    category: 'tap',
    action: 'tap',
    duration,
    wallDuration,
    success: true,
    hasScreenshotBefore: false,
    hasScreenshotAfter: false,
    hasHierarchyBefore: false,
    hasHierarchyAfter: false,
  };
}

describe('reconcileTraceWallDuration', () => {
  it('allocates missing test duration to the final streamed action', () => {
    const first = action(0, 50, 100);
    const last = action(1, 25, 200);
    const trace = emptyTraceData('test.ts');
    trace.events = [first, last];
    trace.actionEvents = [first, last];

    const reconciled = reconcileTraceWallDuration(trace, 500);

    expect(reconciled).not.toBe(trace);
    expect(reconciled.actionEvents[0]).toBe(first);
    expect(reconciled.actionEvents[1].duration).toBe(25);
    expect(reconciled.actionEvents[1].wallDuration).toBe(400);
    expect(reconciled.actionEvents[1].trailingTime).toBe(200);
    expect(reconciled.events[1]).toBe(reconciled.actionEvents[1]);
  });

  it('does not rewrite trace data when wall durations already reconcile', () => {
    const only = action(0, 50, 500);
    const trace = emptyTraceData('test.ts');
    trace.events = [only];
    trace.actionEvents = [only];

    expect(reconcileTraceWallDuration(trace, 500)).toBe(trace);
  });
});
