/**
 * Trace-viewer-local types.
 *
 * Types that are consumed by trace-viewer components but conceptually live
 * outside the core trace data model (which is in `../trace/types.ts`).
 * Keeping them here means trace-viewer doesn't need to reach up into ui-mode
 * for types it owns the rendering of.
 */

import type { ActionCategory, SourceLocation } from '../trace/types.js';

/**
 * In-flight action/assertion currently being executed by the device.
 * Consumed by ActionsPanel to render the in-progress row with a spinner.
 *
 * Sourced from a `lifecycle: 'started'` trace-event in UI mode; the static
 * trace-viewer (.zip archives) leaves this unset.
 */
export interface ContainerSummary {
  name: string
  nodeType: 'suite' | 'file' | 'project'
  totalTests: number
  passed: number
  failed: number
  running: number
  skipped: number
  idle: number
}

export interface InFlightAction {
  actionIndex: number
  kind: 'action' | 'assertion'
  category: ActionCategory
  /** Display label, e.g. "tap" or "toBeVisible". */
  label: string
  /** Serialized selector JSON (action) or selector string (assertion). */
  selector?: string
  /** Whether the action failed — assertions only set this on the started
   * event for visual parity; for live in-flight items it's always false. */
  failed: boolean
  startedAt: number
  /** Element bounds at action start, for the screenshot overlay. */
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Tap/swipe target point, for the screenshot overlay. */
  point?: { x: number; y: number }
  /** Whether the started event carried a before-screenshot. Synthesized
   * events in main.tsx use this so api-request actions (which don't
   * capture) don't claim to have a screenshot. */
  hasScreenshotBefore: boolean
  /** Whether the started event carried a before-hierarchy snapshot. */
  hasHierarchyBefore: boolean
  /** Full user-code call stack captured at action start (top frame first).
   * Carried through so the Source tab can show the file and highlight the
   * current line while the action is still running. */
  stack?: SourceLocation[]
  /** Call-site of the action (== stack[0]); drives the Source tab highlight. */
  sourceLocation?: SourceLocation
}
