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

// ─── Trace capture context ───

/**
 * Lightweight handle passed through ElementHandle so assertions and element
 * queries can emit trace events without a direct Device dependency.
 */
export interface TraceCapture {
  collector: TraceCollector
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
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
 * Skips frames inside the pilot SDK.
 */
export function extractSourceLocation(stack: string): SourceLocation | undefined {
  const lines = stack.split('\n');
  for (const line of lines) {
    const match = STACK_FRAME_RE.exec(line.trim());
    if (!match) continue;
    const file = match[1];
    // Skip internal frames
    if (file.includes('/pilot/src/') || file.includes('/pilot/dist/')) continue;
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
) => void

export class TraceCollector {
  readonly config: TraceConfig;
  private _events: AnyTraceEvent[] = [];
  private _actionIndex = 0;
  private _screenshots: ScreenshotCapture[] = [];
  private _hierarchies: HierarchyCapture[] = [];
  private _groupStack: string[] = [];
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

  constructor(config: TraceConfig, tempDir: string) {
    this.config = config;
    this._tempDir = tempDir;
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
        takeScreenshot().then((data) => {
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
        captureHierarchy().then((xml) => {
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
        takeScreenshot().then((data) => {
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
        captureHierarchy().then((xml) => {
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

    // Emit supplemental capture data for UI mode live streaming.
    // The action event was already emitted (for correct index ordering),
    // so we re-fire _onEvent with a lightweight update carrying the
    // after-capture buffers.
    if (this._onEvent) {
      const pending = this._pendingCaptures.get(actionIndex);
      if (pending && (pending.after || pending.hierarchyAfter)) {
        this._pendingCaptures.delete(actionIndex);
        this._onEvent(
          { type: 'capture-update', actionIndex, timestamp: Date.now() } as AnyTraceEvent,
          pending,
        );
      }
    }

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
   * Emit a fully-formed action event.
   */
  addActionEvent(event: Omit<ActionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>): void {
    const full = {
      ...event,
      type: 'action',
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as ActionTraceEvent;
    this._events.push(full);
    const pending = this._pendingCaptures.get(this._actionIndex);
    this._pendingCaptures.delete(this._actionIndex);
    this._onEvent?.(full, pending);
    this._actionIndex++;
  }

  /**
   * Emit an assertion event.
   */
  addAssertionEvent(event: Omit<AssertionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>): void {
    const full = {
      ...event,
      type: 'assertion',
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as AssertionTraceEvent;
    this._events.push(full);
    const pending = this._pendingCaptures.get(this._actionIndex);
    this._pendingCaptures.delete(this._actionIndex);
    this._onEvent?.(full, pending);
    this._actionIndex++;
  }

  // ── Groups ──

  startGroup(name: string): void {
    this._groupStack.push(name);
    const event = {
      type: 'group-start',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent;
    this._events.push(event);
    this._onEvent?.(event);
  }

  endGroup(): void {
    const name = this._groupStack.pop() ?? 'unknown';
    const event = {
      type: 'group-end',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent;
    this._events.push(event);
    this._onEvent?.(event);
  }

  // ── Console ──

  private _addConsoleEvent(level: ConsoleLevel, message: string, source: 'test' | 'device'): void {
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
