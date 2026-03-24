/**
 * Run queue and keypress mapping for watch mode.
 *
 * Extracted from watch.ts for independent unit testing.
 *
 * @see PILOT-120
 */

// ─── Keypress mapping ───

export type WatchAction = 'run-all' | 'run-failed' | 'rerun' | 'quit'

export function mapKeyToAction(key: string): WatchAction | null {
  switch (key) {
    case 'a': return 'run-all'
    case 'f': return 'run-failed'
    case '\r': // Enter
    case '\n': return 'rerun'
    case 'q':
    case '\x03': return 'quit' // Ctrl+C
    default: return null
  }
}

// ─── Run queue ───

export type RunRequest = { type: 'files'; files: string[] } | { type: 'all' }

/**
 * Manages debounce and queuing for watch mode re-runs.
 *
 * - Debounces rapid file changes, accumulating files across calls
 * - Queues runs while another is in progress
 * - 'run-all' supersedes individual pending files
 */
export class RunQueue {
  private _debounceFiles = new Set<string>()
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null
  private _pendingFiles: Set<string> | 'all' | null = null
  private _isRunning = false
  private readonly _debounceMs: number
  private readonly _onRun: (request: RunRequest) => void

  constructor(debounceMs: number, onRun: (request: RunRequest) => void) {
    this._debounceMs = debounceMs
    this._onRun = onRun
  }

  get isRunning(): boolean { return this._isRunning }

  /** Schedule specific files with debounce accumulation. */
  scheduleFiles(files: string[]): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
    }

    if (this._isRunning) {
      if (this._pendingFiles === 'all') return
      if (this._pendingFiles) {
        for (const f of files) this._pendingFiles.add(f)
      } else {
        this._pendingFiles = new Set(files)
      }
      return
    }

    for (const f of files) this._debounceFiles.add(f)

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null
      const batch = [...this._debounceFiles]
      this._debounceFiles.clear()
      this._onRun({ type: 'files', files: batch })
    }, this._debounceMs)
  }

  /** Schedule a full run (immediate, no debounce). */
  scheduleAll(): void {
    if (this._isRunning) {
      this._pendingFiles = 'all'
      return
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }
    this._onRun({ type: 'all' })
  }

  /** Schedule specific files immediately (no debounce). */
  scheduleImmediate(files: string[]): void {
    if (this._isRunning) {
      this._pendingFiles = new Set(files)
      return
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }
    this._onRun({ type: 'files', files })
  }

  /** Mark that a run has started. */
  notifyRunStarted(): void {
    this._isRunning = true
  }

  /** Mark that a run has finished and drain any queued work. */
  notifyRunFinished(): void {
    this._isRunning = false
    if (this._pendingFiles) {
      const pending = this._pendingFiles
      this._pendingFiles = null
      if (pending === 'all') {
        this._onRun({ type: 'all' })
      } else {
        this._onRun({ type: 'files', files: [...pending] })
      }
    }
  }
}
