/**
 * TraceCollector — accumulates trace events during a test execution.
 *
 * Constructed by the runner at test start, attached to the device, and
 * finalized at test end. Holds an in-memory buffer of events and
 * references to captured screenshots/hierarchy snapshots.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  ActionTraceEvent,
  AssertionTraceEvent,
  GroupTraceEvent,
  ConsoleTraceEvent,
  AnyTraceEvent,
  ConsoleLevel,
  SourceLocation,
  TraceConfig,
} from './types.js'

/** Module-level count of active console interceptors to prevent racing. */
let _activeConsoleInterceptors = 0

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

const STACK_FRAME_RE = /at\s+(?:.+\s+)?\(?(.+):(\d+):(\d+)\)?$/

/**
 * Extract the caller's source location from a stack trace.
 * Skips frames inside the pilot SDK.
 */
export function extractSourceLocation(stack: string): SourceLocation | undefined {
  const lines = stack.split('\n')
  for (const line of lines) {
    const match = STACK_FRAME_RE.exec(line.trim())
    if (!match) continue
    const file = match[1]
    // Skip internal frames
    if (file.includes('/pilot/src/') || file.includes('/pilot/dist/')) continue
    if (file.includes('node_modules')) continue
    if (file.startsWith('node:') || file.startsWith('internal/')) continue
    return {
      file,
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
    }
  }
  return undefined
}

// ─── TraceCollector ───

export class TraceCollector {
  readonly config: TraceConfig
  private _events: AnyTraceEvent[] = []
  private _actionIndex = 0
  private _screenshots: ScreenshotCapture[] = []
  private _hierarchies: HierarchyCapture[] = []
  private _groupStack: string[] = []
  private _tempDir: string
  private _originalConsole: {
    log: typeof console.log
    warn: typeof console.warn
    error: typeof console.error
    info: typeof console.info
    debug: typeof console.debug
  }
  private _consoleIntercepted = false

  constructor(config: TraceConfig, tempDir: string) {
    this.config = config
    this._tempDir = tempDir
    this._originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    }

    // Ensure temp directories exist
    fs.mkdirSync(path.join(tempDir, 'screenshots'), { recursive: true })
  }

  // ── Properties ──

  get events(): readonly AnyTraceEvent[] {
    return this._events
  }

  get screenshots(): readonly ScreenshotCapture[] {
    return this._screenshots
  }

  get hierarchies(): readonly HierarchyCapture[] {
    return this._hierarchies
  }

  get currentActionIndex(): number {
    return this._actionIndex
  }

  // ── Console interception ──

  startConsoleCapture(): void {
    if (this._consoleIntercepted) return
    this._consoleIntercepted = true
    _activeConsoleInterceptors++

    // Only patch if we're the first interceptor
    if (_activeConsoleInterceptors > 1) return

    const capture = (level: ConsoleLevel) => {
      return (...args: unknown[]) => {
        this._originalConsole[level](...args)
        const message = args.map((a) =>
          typeof a === 'string' ? a : JSON.stringify(a),
        ).join(' ')
        this._addConsoleEvent(level, message, 'test')
      }
    }

    console.log = capture('log')
    console.warn = capture('warn')
    console.error = capture('error')
    console.info = capture('info')
    console.debug = capture('debug')
  }

  stopConsoleCapture(): void {
    if (!this._consoleIntercepted) return
    this._consoleIntercepted = false
    _activeConsoleInterceptors--

    // Only restore if we're the last interceptor
    if (_activeConsoleInterceptors > 0) return

    console.log = this._originalConsole.log
    console.warn = this._originalConsole.warn
    console.error = this._originalConsole.error
    console.info = this._originalConsole.info
    console.debug = this._originalConsole.debug
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
    const actionIndex = this._actionIndex
    const captures: Partial<CaptureBeforeAfter> = {}

    const tasks: Promise<void>[] = []

    if (this.config.screenshots) {
      tasks.push(
        takeScreenshot().then((data) => {
          if (data) {
            const filename = `action-${String(actionIndex).padStart(3, '0')}-before.png`
            const diskPath = path.join(this._tempDir, 'screenshots', filename)
            fs.writeFileSync(diskPath, data)
            const capture: ScreenshotCapture = {
              archivePath: `screenshots/${filename}`,
              diskPath,
            }
            this._screenshots.push(capture)
            captures.screenshotBefore = capture
          }
        }).catch(() => { /* best-effort */ }),
      )
    }

    if (this.config.snapshots) {
      tasks.push(
        captureHierarchy().then((xml) => {
          if (xml) {
            captures.hierarchyBefore = {
              archivePath: `hierarchy/action-${String(actionIndex).padStart(3, '0')}-before.xml`,
              xml,
            }
            this._hierarchies.push(captures.hierarchyBefore!)
          }
        }).catch(() => { /* best-effort */ }),
      )
    }

    await Promise.all(tasks)
    return { actionIndex, captures }
  }

  /**
   * Record an after-action capture.
   */
  async captureAfterAction(
    actionIndex: number,
    takeScreenshot: () => Promise<Buffer | undefined>,
    captureHierarchy: () => Promise<string | undefined>,
  ): Promise<Partial<CaptureBeforeAfter>> {
    const captures: Partial<CaptureBeforeAfter> = {}
    const tasks: Promise<void>[] = []

    if (this.config.screenshots) {
      tasks.push(
        takeScreenshot().then((data) => {
          if (data) {
            const filename = `action-${String(actionIndex).padStart(3, '0')}-after.png`
            const diskPath = path.join(this._tempDir, 'screenshots', filename)
            fs.writeFileSync(diskPath, data)
            const capture: ScreenshotCapture = {
              archivePath: `screenshots/${filename}`,
              diskPath,
            }
            this._screenshots.push(capture)
            captures.screenshotAfter = capture
          }
        }).catch(() => { /* best-effort */ }),
      )
    }

    if (this.config.snapshots) {
      tasks.push(
        captureHierarchy().then((xml) => {
          if (xml) {
            captures.hierarchyAfter = {
              archivePath: `hierarchy/action-${String(actionIndex).padStart(3, '0')}-after.xml`,
              xml,
            }
            this._hierarchies.push(captures.hierarchyAfter!)
          }
        }).catch(() => { /* best-effort */ }),
      )
    }

    await Promise.all(tasks)
    return captures
  }

  /**
   * Emit a fully-formed action event.
   */
  addActionEvent(event: Omit<ActionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>): void {
    this._events.push({
      ...event,
      type: 'action',
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as ActionTraceEvent)
    this._actionIndex++
  }

  /**
   * Emit an assertion event.
   */
  addAssertionEvent(event: Omit<AssertionTraceEvent, 'type' | 'actionIndex' | 'timestamp'>): void {
    this._events.push({
      ...event,
      type: 'assertion',
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as AssertionTraceEvent)
    this._actionIndex++
  }

  // ── Groups ──

  startGroup(name: string): void {
    this._groupStack.push(name)
    this._events.push({
      type: 'group-start',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent)
  }

  endGroup(): void {
    const name = this._groupStack.pop() ?? 'unknown'
    this._events.push({
      type: 'group-end',
      name,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as GroupTraceEvent)
  }

  // ── Console ──

  private _addConsoleEvent(level: ConsoleLevel, message: string, source: 'test' | 'device'): void {
    this._events.push({
      type: 'console',
      level,
      message,
      source,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    } as ConsoleTraceEvent)
  }

  addLogcatEntry(level: ConsoleLevel, message: string): void {
    this._addConsoleEvent(level, message, 'device')
  }

  // ── Error ──

  addError(message: string, stack?: string): void {
    this._events.push({
      type: 'error',
      message,
      stack,
      actionIndex: this._actionIndex,
      timestamp: Date.now(),
    })
  }

  // ── Finalization ──

  /**
   * Get all events as NDJSON string.
   */
  toNDJSON(): string {
    return this._events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  }

  /**
   * Clean up temporary files.
   */
  cleanup(): void {
    this.stopConsoleCapture()
    // Remove temp directory and its contents
    try {
      fs.rmSync(this._tempDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
