// Builders for `trace-event` messages.
//
// The SPA renders an action row as soon as it sees `lifecycle: "started"` and
// finalises it on `"completed"`, so both halves matter — a started-only event is
// what an in-flight action looks like.

import type { TraceEventMessage } from "../../protocol.js"

export interface ActionOptions {
  testFullName: string
  actionIndex: number
  action: string
  selector?: string
  duration?: number
  success?: boolean
  error?: string
  projectName?: string
  screenshotBefore?: string
  screenshotAfter?: string
}

/** The `started` half — an action the device has begun but not finished. */
export function actionStarted(o: ActionOptions): TraceEventMessage {
  return {
    type: "trace-event",
    testFullName: o.testFullName,
    projectName: o.projectName,
    lifecycle: "started",
    event: {
      type: "action",
      category: "tap",
      action: o.action,
      selector: o.selector,
      actionIndex: o.actionIndex,
      timestamp: 1_700_000_000_000 + o.actionIndex * 100,
      duration: 0,
      success: true,
      hasScreenshotBefore: o.screenshotBefore != null,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    },
    screenshotBefore: o.screenshotBefore,
  }
}

/** The `completed` half. */
export function actionCompleted(o: ActionOptions): TraceEventMessage {
  return {
    type: "trace-event",
    testFullName: o.testFullName,
    projectName: o.projectName,
    lifecycle: "completed",
    event: {
      type: "action",
      category: "tap",
      action: o.action,
      selector: o.selector,
      actionIndex: o.actionIndex,
      timestamp: 1_700_000_000_000 + o.actionIndex * 100 + 50,
      duration: o.duration ?? 42,
      success: o.success ?? true,
      error: o.error,
      hasScreenshotBefore: o.screenshotBefore != null,
      hasScreenshotAfter: o.screenshotAfter != null,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    },
    screenshotBefore: o.screenshotBefore,
    screenshotAfter: o.screenshotAfter,
  }
}

/** Both halves, as a completed action arrives in practice. */
export function action(o: ActionOptions): TraceEventMessage[] {
  return [actionStarted(o), actionCompleted(o)]
}

/**
 * A lifecycle group boundary ("App reset", "beforeEach Hooks", "Test", …).
 * The runner emits these as ordinary completed trace events around the
 * actions they contain; the panel renders each non-empty group as a section
 * header.
 */
export function group(o: {
  testFullName: string
  type: "group-start" | "group-end"
  name: string
  actionIndex: number
  projectName?: string
}): TraceEventMessage {
  return {
    type: "trace-event",
    testFullName: o.testFullName,
    projectName: o.projectName,
    event: {
      type: o.type,
      name: o.name,
      actionIndex: o.actionIndex,
      timestamp: 1_700_000_000_000 + o.actionIndex * 100,
    },
  }
}
