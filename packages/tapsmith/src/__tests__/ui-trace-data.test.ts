import { describe, expect, it } from 'vitest';
import { emptyTraceData, findNearestHierarchy, reconcileTraceWallDuration } from '../ui-mode/hooks/use-trace-data.js';
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

describe('findNearestHierarchy', () => {
  const hierarchyMap = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('returns the nearest preceding snapshot and says which step it came from', () => {
    const hierarchies = hierarchyMap({
      'hierarchy/action-000-after.xml': '<node text="step0" />',
    });

    expect(findNearestHierarchy(hierarchies, 3, 'before')).toEqual({
      xml: '<node text="step0" />',
      sourceActionIndex: 0,
    });
  });

  it('prefers the after-snapshot over the before-snapshot at the same step', () => {
    const hierarchies = hierarchyMap({
      'hierarchy/action-001-before.xml': '<node text="before" />',
      'hierarchy/action-001-after.xml': '<node text="after" />',
    });

    expect(findNearestHierarchy(hierarchies, 2, 'before')).toEqual({
      xml: '<node text="after" />',
      sourceActionIndex: 1,
    });
  });

  it('falls back to the before-snapshot when a step has no after-snapshot', () => {
    const hierarchies = hierarchyMap({
      'hierarchy/action-001-before.xml': '<node text="before" />',
    });

    expect(findNearestHierarchy(hierarchies, 2, 'before')).toEqual({
      xml: '<node text="before" />',
      sourceActionIndex: 1,
    });
  });

  it('the before display never borrows forwards', () => {
    const hierarchies = hierarchyMap({
      'hierarchy/action-002-after.xml': '<node text="later" />',
    });

    expect(findNearestHierarchy(hierarchies, 1, 'before')).toBeUndefined();
  });

  it("the after display borrows the next step's before-snapshot, which depicts the same moment", () => {
    const hierarchies = hierarchyMap({
      'hierarchy/action-000-after.xml': '<node text="step0" />',
      'hierarchy/action-002-before.xml': '<node text="step2" />',
    });

    expect(findNearestHierarchy(hierarchies, 1, 'after')).toEqual({
      xml: '<node text="step2" />',
      sourceActionIndex: 2,
    });
  });

  it('the after display falls back to preceding steps when the next step captured nothing', () => {
    const hierarchies = hierarchyMap({
      'hierarchy/action-000-after.xml': '<node text="step0" />',
    });

    expect(findNearestHierarchy(hierarchies, 1, 'after')).toEqual({
      xml: '<node text="step0" />',
      sourceActionIndex: 0,
    });
  });

  it('returns undefined for the first action and for an empty map', () => {
    expect(findNearestHierarchy(hierarchyMap({}), 5, 'before')).toBeUndefined();
    expect(findNearestHierarchy(hierarchyMap({ 'hierarchy/action-000-after.xml': '<node />' }), 0, 'before')).toBeUndefined();
  });
});
