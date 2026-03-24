/**
 * RunControls — top bar with run/stop buttons, connection status, and worker indicators.
 */

import type { ClientMessage } from '../ui-protocol.js'

export type Theme = 'system' | 'light' | 'dark'

interface WorkerInfo {
  workerId: number
  deviceSerial: string
  status: 'idle' | 'running' | 'done' | 'initializing' | 'error'
  currentFile?: string
  currentTest?: string
  passed: number
  failed: number
  skipped: number
}

interface RunControlsProps {
  connected: boolean
  isRunning: boolean
  isWatching: boolean
  deviceSerial: string
  counts: { passed: number; failed: number; skipped: number; total: number }
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onSend: (msg: ClientMessage) => void
  /** Whether any project has dependencies (controls visibility of the deps toggle). */
  hasProjectDeps: boolean
  runDepsFirst: boolean
  onToggleRunDeps: () => void
  /** Workers in multi-worker mode. Empty array for single-worker. */
  workers: WorkerInfo[]
}

const STATUS_SYMBOLS: Record<WorkerInfo['status'], string> = {
  idle: '\u25CB',         // ○
  running: '\u25CF',      // ●
  done: '\u2713',         // ✓
  initializing: '\u25D4', // ◔
  error: '\u2717',        // ✗
}

const STATUS_CLASS: Record<WorkerInfo['status'], string> = {
  idle: '',
  running: 'worker-running',
  done: 'worker-done',
  initializing: 'worker-init',
  error: 'worker-error',
}

export function RunControls({ connected, isRunning, isWatching, deviceSerial, counts, theme, onThemeChange, onSend, hasProjectDeps, runDepsFirst, onToggleRunDeps, workers }: RunControlsProps) {
  const hasWorkers = workers.length > 1

  return (
    <div class="run-controls">
      <div class="rc-left">
        <div class="rc-logo">
          <span class="rc-logo-text">Pilot</span>
          <span class="rc-mode">UI Mode</span>
          {hasWorkers && (
            <span class="rc-worker-count">{workers.length}w</span>
          )}
        </div>
      </div>

      <div class="rc-center">
        <button
          class="rc-btn rc-run-all"
          onClick={() => onSend({ type: 'run-all' })}
          disabled={isRunning || !connected}
          title="Run all tests"
        >
          {'\u25B6'} Run All
        </button>
        {isRunning && (
          <button
            class="rc-btn rc-stop"
            onClick={() => onSend({ type: 'stop-run' })}
            title="Stop current run"
          >
            {'\u25A0'} Stop
          </button>
        )}
        <button
          class={`rc-btn rc-watch-all ${isWatching ? 'active' : ''}`}
          onClick={() => onSend({ type: 'toggle-watch', filePath: 'all' })}
          disabled={!connected}
          title={isWatching ? 'Disable watch mode' : 'Watch all files for changes'}
        >
          {'\u25C9'} Watch{isWatching ? ' On' : ''}
        </button>
        {hasProjectDeps && (
          <button
            class={`rc-btn rc-deps-toggle ${runDepsFirst ? 'active' : ''}`}
            onClick={onToggleRunDeps}
            title={runDepsFirst
              ? 'Dependencies run automatically before tests — click to disable'
              : 'Run dependency projects before tests — click to enable'}
          >
            {'\u26D3'} Deps{runDepsFirst ? ' On' : ''}
          </button>
        )}

        {/* Worker status indicators */}
        {hasWorkers && (
          <div class="rc-workers">
            {workers.map((w) => (
              <span
                key={w.workerId}
                class={`rc-worker-pill ${STATUS_CLASS[w.status]}`}
                title={`Worker ${w.workerId} (${w.deviceSerial})\nStatus: ${w.status}${w.currentFile ? `\nFile: ${w.currentFile}` : ''}${w.currentTest ? `\nTest: ${w.currentTest}` : ''}\n${w.passed}P ${w.failed}F ${w.skipped}S`}
              >
                <span class={`rc-worker-dot ${STATUS_CLASS[w.status]}`}>
                  {STATUS_SYMBOLS[w.status]}
                </span>
                <span class="rc-worker-id">W{w.workerId}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div class="rc-right">
        {counts.total > 0 && (
          <div class="rc-counts">
            {counts.passed > 0 && <span class="rc-count passed">{counts.passed} passed</span>}
            {counts.failed > 0 && <span class="rc-count failed">{counts.failed} failed</span>}
            {counts.skipped > 0 && <span class="rc-count skipped">{counts.skipped} skipped</span>}
          </div>
        )}
        <select
          class="rc-theme-select"
          value={theme}
          onChange={(e) => onThemeChange((e.target as HTMLSelectElement).value as Theme)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <div class={`rc-connection ${connected ? 'connected' : 'disconnected'}`}>
          <span class="rc-dot" />
          {deviceSerial || (connected ? 'Connected' : 'Disconnected')}
        </div>
      </div>
    </div>
  )
}
