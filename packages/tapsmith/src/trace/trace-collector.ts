/**
 * TraceCollector — accumulates trace events during a test execution.
 *
 * Constructed by the runner at test start, attached to the device, and
 * finalized at test end. Holds an in-memory buffer of events and
 * references to captured screenshots/hierarchy snapshots.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ActionTraceEvent,
  AssertionTraceEvent,
  GroupTraceEvent,
  ConsoleTraceEvent,
  AnyTraceEvent,
  ConsoleLevel,
  SourceLocation,
  TraceConfig,
} from './types.js';

/** Module-level count of active console interceptors to prevent racing. */
let _activeConsoleInterceptors = 0;

// ─── Global collector accessor ───

let _activeCollector: TraceCollector | null = null;
const TRACE_CAPTURE_TIMEOUT_MS = 5_000;

/** Get the currently active trace collector (set by the runner during test execution). */
export function getActiveTraceCollector(): TraceCollector | null {
  return _activeCollector;
}

/** @internal — Set the active collector. Called by the runner. */
export function setActiveTraceCollector(collector: TraceCollector | null): void {
  _activeCollector = collector;
}

/**
 * @internal — Run a callback with the given collector as active, guaranteed to
 * be cleared on completion (even if the callback throws).
 */
export async function withActiveTraceCollector<T>(
  collector: TraceCollector,
  fn: () => Promise<T>,
): Promise<T> {
  setActiveTraceCollector(collector);
  try {
    return await fn();
  } finally {
    setActiveTraceCollector(null);
  }
}

async function captureWithTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), TRACE_CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Trace capture context ───

/**
 * Lightweight handle passed through ElementHandle so assertions and element
 * queries can emit trace events without a direct Device dependency.
 */
export interface TraceCapture {
  collector: TraceCollector
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
  captureTraceState?: (options: {
    screenshot?: boolean;
    hierarchy?: boolean;
    elementSelector?: import('../selectors.js').Selector;
  }) => Promise<import('../grpc-client.js').CaptureTraceStateResponse | undefined>
}

// ─── Types ───

export interface ScreenshotCapture {
  /** Relative path within the archive screenshots/ dir. */
  archivePath: string
  /** Absolute path to the temporary file on disk. */
  diskPath: string
}

export interface HierarchyCapture {
  /** Relative path within the archive hierarchy/ dir. */
  archivePath: string
  /** The XML content. */
  xml: string
}

export interface CaptureBeforeAfter {
  screenshotBefore?: ScreenshotCapture
  screenshotAfter?: ScreenshotCapture
  hierarchyBefore?: HierarchyCapture
  hierarchyAfter?: HierarchyCapture
}

// ─── Source location extraction ───

const STACK_FRAME_RE = /at\s+(?:.+\s+)?\(?(.+):(\d+):(\d+)\)?$/;

/**
 * Extract the caller's source location from a stack trace.
 * Skips frames inside the tapsmith SDK.
 */
export function extractSourceLocation(stack: string): SourceLocation | undefined {
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = STACK_FRAME_RE.exec(line.trim());
    if (!match) continue;
    const file = match[1];
    // Skip internal frames
    if (file.includes('/tapsmith/src/') || file.includes('/tapsmith/dist/')) continue;
    if (file.includes('node_modules')) continue;
    if (file.startsWith('node:') || file.startsWith('internal/')) continue;
    return {
      file,
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
    };
  }
  return undefined;
}

// ─── TraceCollector ───

/** Callback for live trace event streaming (UI mode). */
export type TraceEventCallback = (
  event: AnyTraceEvent,
  screenshots?: {
    before?: Buffer
    after?: Buffer
    hierarchyBefore?: string
    hierarchyAfter?: string
  },
  /**
   * Lifecycle stage of the event. Omitted for events that don't have a
   * lifecycle (groups, console, error). For action/assertion events:
   *   - 'started' fires immediately after the before-capture so UI mode can
   *     render an in-progress row with a spinner; the event has placeholder
   *     duration/success/passed and is NOT pushed to the persistent _events.
   *   - 'completed' (or omitted) is the existing behavior.
   */
  lifecycle?: 'started' | 'completed',
) => void

export class TraceCollector {
  readonly config: TraceConfig;
  private _events: AnyTraceEvent[] = [];
  private _actionIndex = 0;
  private _timelineOrigin: number;
  private _lastTimelineTimestamp: number;
  private _lastTimedEvent: ActionTraceEvent | AssertionTraceEvent | null = null;
  private _screenshots: ScreenshotCapture[] = [];
  private _hierarchies: HierarchyCapture[] = [];
  private _groupStack: string[] = [];
  /**
   * Pending group-start events that haven't been emitted yet — held back
   * until a child event arrives so we can drop empty groups silently.
   * Each entry is the group event waiting to be flushed.
   */
  private _pendingGroupStarts: GroupTraceEvent[] = [];
  private _tempDir: string;
  private _onEvent?: TraceEventCallback;
  /** Buffered screenshot/hierarchy data for the current action, forwarded via _onEvent. */
  private _pendingCaptures = new Map<number, {
    before?: Buffer
    after?: Buffer
    hierarchyBefore?: string
    hierarchyAfter?: string
  }>();
  private _originalConsole: {
    log: typeof console.log
    warn: typeof console.warn
    error: typeof console.error
    info: typeof console.info
    debug: typeof console.debug
  };
  private _consoleIntercepted = false;
  /** Handler to emit a failed event for the in-flight action/assertion on timeout. */
  private _pendingOperationHandler: ((error: string) => void) | null = null;
  /** Pending after-action capture promises that must complete before trace packaging. */
  private _pendingAfterCaptures: Promise<void>[] = [];

  constructor(config: TraceConfig, tempDir: string, timelineOrigin = Date.now()) {
    this.config = config;
    this._tempDir = tempDir;
    this._timelineOrigin = timelineOrigin;
    this._lastTimelineTimestamp = timelineOrigin;
    this._originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };

    // Ensure temp directories exist
    fs.mkdirSync(path.join(tempDir, 'screenshots'), { recursive: true });
  }

  // ── Properties ──

  get events(): readonly AnyTraceEvent[] {
    return this._events;
  }

  get screenshots(): readonly ScreenshotCapture[] {
    return this._screenshots;
  }

  get hierarchies(): readonly HierarchyCapture[] {
    return this._hierarchies;
  }

  get currentActionIndex(): number {
    return this._actionIndex;
  }

  // ── Event callback (UI mode live streaming) ──

  /**
   * Set a callback that is invoked for every trace event as it is emitted.
   * Used by UI mode to stream events in real-time via IPC.
   */
  setEventCallback(cb: TraceEventCallback): void {
    this._onEvent = cb;
  }

  /** Get the current event callback (for transferring between collectors). */
  getEventCallback(): TraceEventCallback | undefined {
    return this._onEvent;
  }

  /** @internal — Set the starting action index (used to offset for beforeAll events). */
  setActionIndexOffset(offset: number): void {
    this._actionIndex = offset;
  }

  /**
   * @internal — Set the timestamp that action wall durations should account
   * from. This should be called before the first action/assertion is emitted.
   */
  setTimelineOrigin(timestamp: number): void {
    this._timelineOrigin = timestamp;
    this._lastTimelineTimestamp = timestamp;
  }

  /** @internal — Get the temp directory path (for reading saved screenshots). */
  get tempDir(): string {
    return this._tempDir;
  }

  // ── Console interception ──

  startConsoleCapture(): void {
    if (this._consoleIntercepted) return;
    this._consoleIntercepted = true;
    _activeConsoleInterceptors++;

    // Only patch if we're the first interceptor
    if (_activeConsoleInterceptors > 1) return;

    const capture = (level: ConsoleLevel) => {
      return (...args: unknown[]) => {
        this._originalConsole[level](...args);
        const message = args.map((a) =>
          typeof a === 'string' ? a : JSON.stringify(a),
        ).join(' ');
        this._addConsoleEvent(level, message, 'test');
      };
    };

    console.log = capture('log');
    console.warn = capture('warn');
    console.error = capture('error');
    console.info = capture('info');
    console.debug = capture('debug');
  }

  stopConsoleCapture(): void {
    if (!this._consoleIntercepted) return;
    this._consoleIntercepted = false;
    _activeConsoleInterceptors--;

    // Only restore if we're the last interceptor
    if (_activeConsoleInterceptors > 0) return;

    console.log = this._originalConsole.log;
    console.warn = this._originalConsole.warn;
    console.error = this._originalConsole.error;
    console.info = this._originalConsole.info;
    console.debug = this._originalConsole.debug;
  }

  // ── Pending operation (timeout detection) ──

  /**
   * Register a fail handler for the currently in-flight action or assertion.
   * Called by tracedAction / wrapAssertionWithTrace before executing the user's fn().
   */
  setPendingOperation(failHandler: (error: string) => void): void {
    this._pendingOperationHandler = failHandler;
  }

  /**
   * Clear the pending operation after it completes normally.
   */
  clearPendingOperation(): void {
    this._pendingOperationHandler = null;
  }

  /**
   * Emit a failed event for the currently in-flight action/assertion.
   * Called by the runner when a test times out, so the stuck action appears in the trace.
   */
  failPendingOperation(error: string): void {
    if (!this._pendingOperationHandler) return;
    const handler = this._pendingOperationHandler;
    this._pendingOperationHandler = null;
    handler(error);
  }

  // ── Action recording ──

  /**
   * Record a before-action capture (screenshot + hierarchy).
   * Returns the action index for this action.
   */
  async captureBeforeAction(
    takeScreenshot: () => Promise<Buffer | undefined>,
    captureHierarchy: () => Promise<string | undefined>,
  ): Promise<{ actionIndex: number; captures: Partial<CaptureBeforeAfter> }> {
    const actionIndex = this._actionIndex;
    const captures: Partial<CaptureBeforeAfter> = {};

    const tasks: Promise<void>[] = [];

    if (this.config.screenshots) {
      tasks.push(
        captureWithTimeout(takeScreenshot()).then((data) => {
          if (data) {
            const filename = `action-${String(actionIndex).padStart(3, '0')}-before.png`;
            const diskPath = path.join(this._tempDir, 'screenshots', filename);
            fs.writeFileSync(diskPath, data);
            const capture: ScreenshotCapture = {
              archivePath: `screenshots/${filename}`,
              diskPath,
            };
            this._screenshots.push(capture);
            captures.screenshotBefore = capture;
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.before = data;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    if (this.config.snapshots) {
      tasks.push(
        captureWithTimeout(captureHierarchy()).then((xml) => {
          if (xml) {
            captures.hierarchyBefore = {
              archivePath: `hierarchy/action-${String(actionIndex).padStart(3, '0')}-before.xml`,
              xml,
            };
            this._hierarchies.push(captures.hierarchyBefore!);
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.hierarchyBefore = xml;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    await Promise.all(tasks);
    return { actionIndex, captures };
  }

  /**
   * Record an after-action capture.
   */
  async captureAfterAction(
    actionIndex: number,
    takeScreenshot: () => Promise<Buffer | undefined>,
    captureHierarchy: () => Promise<string | undefined>,
  ): Promise<Partial<CaptureBeforeAfter>> {
    const captures: Partial<CaptureBeforeAfter> = {};
    const tasks: Promise<void>[] = [];

    if (this.config.screenshots) {
      tasks.push(
        captureWithTimeout(takeScreenshot()).then((data) => {
          if (data) {
            const filename = `action-${String(actionIndex).padStart(3, '0')}-after.png`;
            const diskPath = path.join(this._tempDir, 'screenshots', filename);
            fs.writeFileSync(diskPath, data);
            const capture: ScreenshotCapture = {
              archivePath: `screenshots/${filename}`,
              diskPath,
            };
            this._screenshots.push(capture);
            captures.screenshotAfter = capture;
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.after = data;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    if (this.config.snapshots) {
      tasks.push(
        captureWithTimeout(captureHierarchy()).then((xml) => {
          if (xml) {
            captures.hierarchyAfter = {
              archivePath: `hierarchy/action-${String(actionIndex).padStart(3, '0')}-after.xml`,
              xml,
            };
            this._hierarchies.push(captures.hierarchyAfter!);
            // Buffer for live streaming
            if (this._onEvent) {
              const pending = this._pendingCaptures.get(actionIndex) ?? {};
              pending.hierarchyAfter = xml;
              this._pendingCaptures.set(actionIndex, pending);
            }
          }
        }).catch(() => { /* best-effort */ }),
      );
    }

    await Promise.all(tasks);
    return captures;
  }

  /**
   * Track a pending after-action capture promise. These are awaited before
   * the trace is packaged to ensure all screenshots/hierarchies are written.
   */
  trackPendingCapture(promise: Promise<void>): void {
    this._pendingAfterCaptures.push(promise);
  }

  /**
   * Wait for all pending after-action captures to complete.
   * Called before packaging the trace to ensure all data is flushed.
   */
  async flushPendingCaptures(): Promise<void> {
    await Promise.allSettled(this._pendingAfterCaptures);
    this._pendingAfterCaptures = [];
  }

  /**
   * Flush buffered screenshot/hierarchy data for a given action index via
   * the live event callback.  Used to stream the final end-of-test screenshot
   * to UI mode without emitting a visible action event.
   */
  emitPendingCaptures(actionIndex: number): void {
    if (!this._onEvent) return;
    const pending = this._pendingCaptures.get(actionIndex);
    if (pending) {
      this._pendingCaptures.delete(actionIndex);
      // Emit as an action event with the screenshot data so the frontend
      // stores it in the screenshots map at the correct key.
      this._onEvent(
        {
          type: 'action',
          actionIndex,
          timestamp: Date.now(),
          category: 'other',
          action: '__final_screenshot',
          duration: 0,
          success: true,
          log: [],
          hasScreenshotBefore: !!pending.before,
          hasScreenshotAfter: false,
          hasHierarchyBefore: !!pending.hierarchyBefore,
          hasHierarchyAfter: false,
        } as ActionTraceEvent,
        pending,
      );
    }
  }

  /**
   * Emit a fully-formed action event.
   */
  addActionEvent(event: Omit<ActionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>): void {
    this._flushPendingGroups();
    const now = Date.now();
    const full = {
      ...event,
      type: 'action',
      actionIndex: this._actionIndex,
      timestamp: now,
    } as ActionTraceEvent;
    this._applyTimelineTiming(full, now);
    this._events.push(full);
    const pending = this._pendingCaptures.get(this._actionIndex);
    this._pendingCaptures.delete(this._actionIndex);
    this._onEvent?.(full, pending, 'completed');
    this._actionIndex++;
  }

  /**
   * Emit an assertion event.
   */
  addAssertionEvent(event: Omit<AssertionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>): void {
    this._flushPendingGroups();
    const now = Date.now();
    const full = {
      ...event,
      type: 'assertion',
      actionIndex: this._actionIndex,
      timestamp: now,
    } as AssertionTraceEvent;
    this._applyTimelineTiming(full, now);
    this._events.push(full);
    const pending = this._pendingCaptures.get(this._actionIndex);
    this._pendingCaptures.delete(this._actionIndex);
    this._onEvent?.(full, pending, 'completed');
    this._actionIndex++;
  }

  private _applyTimelineTiming(
    event: ActionTraceEvent | AssertionTraceEvent,
    completedAt: number,
  ): void {
    const ownDuration = Math.max(0, event.duration ?? 0);
    const startedAt = event.startTime ?? Math.max(this._timelineOrigin, completedAt - ownDuration);
    const previousBoundary = this._lastTimelineTimestamp;

    event.startTime = startedAt;
    event.endTime = event.endTime ?? completedAt;
    event.gapBefore = Math.max(0, startedAt - previousBoundary);
    event.wallDuration = Math.max(0, completedAt - previousBoundary);

    this._lastTimelineTimestamp = Math.max(previousBoundary, completedAt);
    this._lastTimedEvent = event;
  }

  /**
   * @internal — Allocate any remaining trace time after the last action to
   * that final action. This keeps visible wall durations consistent with the
   * metadata's test duration while preserving each action's raw `duration`.
   */
  finalizeTimeline(endTime: number): void {
    if (!this._lastTimedEvent) return;
    const trailing = Math.max(0, endTime - this._lastTimelineTimestamp);
    if (trailing === 0) return;
    this._lastTimedEvent.wallDuration = (
      this._lastTimedEvent.wallDuration ?? this._lastTimedEvent.duration
    ) + trailing;
    this._lastTimedEvent.trailingTime = (this._lastTimedEvent.trailingTime ?? 0) + trailing;
    this._lastTimelineTimestamp = endTime;
  }

  /**
   * Emit a "started" lifecycle signal for the in-flight action so UI mode
   * can render an in-progress row with a spinner. Streams via _onEvent only —
   * does NOT push to _events (saved trace archives carry only completed
   * events) and does NOT increment _actionIndex (the matching addActionEvent
   * will own the index).
   *
   * Caller passes the partial set of fields known at action start; the
   * collector fills in type/actionIndex/timestamp and the placeholder
   * `duration`/`success` fields needed to satisfy the ActionTraceEvent shape.
   */
  _emitActionStarted(
    partial: Omit<
      ActionTraceEvent,
      'type' | 'actionIndex' | 'timestamp' | 'duration' | 'success'
        | 'hasScreenshotAfter' | 'hasHierarchyAfter'
    > & {
      hasScreenshotAfter?: boolean
      hasHierarchyAfter?: boolean
    },
  ): void {
    if (!this._onEvent) return;
    // Flush any pending group-starts so UI mode renders the group header
    // (e.g. "beforeEach Hooks") immediately when the first action in the
    // group goes in-flight, rather than only after it completes. Once
    // streamed, the group is no longer eligible for the empty-group drop
    // optimization — but if a started signal fires, content is incoming.
    this._flushPendingGroups();
    const full = {
      ...partial,
      type: 'action',
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
      duration: 0,
      success: true,
      hasScreenshotAfter: partial.hasScreenshotAfter ?? false,
      hasHierarchyAfter: partial.hasHierarchyAfter ?? false,
    } as ActionTraceEvent;
    const pending = this._pendingCaptures.get(this._actionIndex);
    this._onEvent(full, pending, 'started');
  }

  /**
   * Emit a "started" lifecycle signal for an in-flight assertion. See
   * _emitActionStarted for semantics — this is the assertion variant.
   */
  _emitAssertionStarted(
    partial: Omit<
      AssertionTraceEvent,
      'type' | 'actionIndex' | 'timestamp' | 'duration' | 'attempts' | 'passed'
    >,
  ): void {
    if (!this._onEvent) return;
    this._flushPendingGroups();
    const full = {
      ...partial,
      type: 'assertion',
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
      duration: 0,
      attempts: 0,
      passed: true,
    } as AssertionTraceEvent;
    const pending = this._pendingCaptures.get(this._actionIndex);
    this._onEvent(full, pending, 'started');
  }

  // ── Groups ──

  startGroup(name: string): void {
    this._groupStack.push(name);
    // Defer emission — only flush when a child event arrives. Empty
    // groups are dropped silently in endGroup() so the trace viewer
    // doesn't render hollow section headers.
    const event = {
      type: 'group-start',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent;
    this._pendingGroupStarts.push(event);
  }

  endGroup(): void {
    const name = this._groupStack.pop() ?? 'unknown';
    // If the matching group-start is still pending, the group had no
    // children — drop both events.
    const pending = this._pendingGroupStarts[this._pendingGroupStarts.length - 1];
    if (pending && pending.name === name) {
      this._pendingGroupStarts.pop();
      return;
    }
    const event = {
      type: 'group-end',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent;
    this._events.push(event);
    this._onEvent?.(event);
  }

  /**
   * Flush any deferred group-start events. Called immediately before
   * emitting any child event so the start ordering is preserved.
   */
  private _flushPendingGroups(): void {
    if (this._pendingGroupStarts.length === 0) return;
    for (const event of this._pendingGroupStarts) {
      this._events.push(event);
      this._onEvent?.(event);
    }
    this._pendingGroupStarts.length = 0;
  }

  // ── Console ──

  private _addConsoleEvent(level: ConsoleLevel, message: string, source: 'test' | 'device'): void {
    this._flushPendingGroups();
    const event = {
      type: 'console',
      level,
      message,
      source,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as ConsoleTraceEvent;
    this._events.push(event);
    this._onEvent?.(event);
  }

  addLogcatEntry(level: ConsoleLevel, message: string): void {
    this._addConsoleEvent(level, message, 'device');
  }

  // ── Error ──

  addError(message: string, stack?: string): void {
    this._flushPendingGroups();
    const event = {
      type: 'error' as const,
      message,
      stack,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    };
    this._events.push(event);
    this._onEvent?.(event as AnyTraceEvent);
  }

  // ── Finalization ──

  /**
   * Get all events as NDJSON string.
   */
  toNDJSON(): string {
    return this._events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  /**
   * Clean up temporary files.
   */
  cleanup(): void {
    this.stopConsoleCapture();
    this._pendingCaptures.clear();
    this._pendingOperationHandler = null;
    // Remove temp directory and its contents
    try {
      fs.rmSync(this._tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
