import { describe, expect, it } from 'vitest';
import { sortEventsByStartTime } from '../trace/sort-events.js';
import type { AnyTraceEvent } from '../trace/types.js';

function action(label: string, endTime: number, duration: number): AnyTraceEvent {
  return {
    type: 'action',
    category: 'other',
    action: label,
    actionIndex: 0,
    timestamp: endTime,
    duration,
    success: true,
    hasScreenshotBefore: false,
    hasScreenshotAfter: false,
    hasHierarchyBefore: false,
    hasHierarchyAfter: false,
  } as AnyTraceEvent;
}

function group(kind: 'start' | 'end', name: string, timestamp: number): AnyTraceEvent {
  return {
    type: kind === 'start' ? 'group-start' : 'group-end',
    name,
    actionIndex: 0,
    timestamp,
  } as AnyTraceEvent;
}

function labels(events: AnyTraceEvent[]): string[] {
  return events.map((e) => {
    if (e.type === 'action') return `action:${(e as { action: string }).action}`;
    if (e.type === 'group-start') return `start:${(e as { name: string }).name}`;
    if (e.type === 'group-end') return `end:${(e as { name: string }).name}`;
    return e.type;
  });
}

describe('sortEventsByStartTime', () => {
  it('preserves order when events are already chronological', () => {
    const events = [
      action('a', 100, 50),  // start=50
      action('b', 200, 50),  // start=150
      action('c', 300, 50),  // start=250
    ];
    expect(labels(sortEventsByStartTime(events))).toEqual([
      'action:a',
      'action:b',
      'action:c',
    ]);
  });

  it('reorders completion-order events to start-time order', () => {
    // A long-running tap (start=0, end=600) gets completed AFTER a short
    // route.abort that started mid-tap (start=100, end=110).
    // Insertion order: abort first (completed first), then tap.
    // Expected output: tap first (started first).
    const events = [
      action('route.abort', 110, 10), // start=100, ends first
      action('tap', 600, 600),         // start=0, ends later
    ];
    expect(labels(sortEventsByStartTime(events))).toEqual([
      'action:tap',
      'action:route.abort',
    ]);
  });

  it('preserves group boundaries — sorts only within groups', () => {
    const events = [
      group('start', 'beforeEach', 0),
      action('restart', 1000, 1000), // start=0
      group('end', 'beforeEach', 1000),
      group('start', 'Test', 1000),
      action('abort', 1110, 10),  // start=1100
      action('tap', 1600, 600),   // start=1000
      group('end', 'Test', 1600),
    ];
    expect(labels(sortEventsByStartTime(events))).toEqual([
      'start:beforeEach',
      'action:restart',
      'end:beforeEach',
      'start:Test',
      'action:tap',     // start=1000
      'action:abort',   // start=1100
      'end:Test',
    ]);
  });

  it('stable sort preserves insertion order for ties', () => {
    const events = [
      action('a', 100, 50), // start=50
      action('b', 100, 50), // start=50 (tie)
      action('c', 100, 50), // start=50 (tie)
    ];
    expect(labels(sortEventsByStartTime(events))).toEqual([
      'action:a',
      'action:b',
      'action:c',
    ]);
  });

  it('handles empty event list', () => {
    expect(sortEventsByStartTime([])).toEqual([]);
  });

  it('preserves non-action events in place', () => {
    const events: AnyTraceEvent[] = [
      action('a', 100, 50),
      { type: 'console', actionIndex: 0, timestamp: 150, level: 'log', message: 'hi', source: 'test' } as AnyTraceEvent,
      action('b', 200, 50),
    ];
    expect(labels(sortEventsByStartTime(events))).toEqual([
      'action:a',
      'console',
      'action:b',
    ]);
  });
});
