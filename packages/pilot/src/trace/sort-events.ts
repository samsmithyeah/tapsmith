/**
 * Sort trace events by start time (timestamp - duration) while preserving
 * group boundaries. Actions are recorded at END time, so a long-running
 * action with an async side-effect (e.g. a network route handler firing
 * mid-tap) would otherwise appear AFTER the side-effect in insertion order.
 *
 * This reorders only within each (group-start, group-end) bracket so
 * groups stay intact.
 */

import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent } from './types.js';

function startTimeOf(e: AnyTraceEvent): number {
  if (e.type === 'action' || e.type === 'assertion') {
    return e.timestamp - ((e as ActionTraceEvent | AssertionTraceEvent).duration ?? 0);
  }
  return e.timestamp;
}

/**
 * Sort action/assertion events within each group (or at the top level)
 * by start time. Group markers, console events, errors, etc. stay in place.
 */
export function sortEventsByStartTime<T extends AnyTraceEvent>(events: T[]): T[] {
  const result: T[] = [];
  let buffer: T[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      // Stable sort preserves insertion order for ties
      buffer.sort((a, b) => startTimeOf(a) - startTimeOf(b));
      result.push(...buffer);
      buffer = [];
    }
  };

  for (const e of events) {
    if (e.type === 'action' || e.type === 'assertion') {
      buffer.push(e);
    } else {
      flush();
      result.push(e);
    }
  }
  flush();
  return result;
}
