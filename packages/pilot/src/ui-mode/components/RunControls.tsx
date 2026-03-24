/**
 * RunControls — top bar with run/stop buttons and connection status.
 */

import type { ClientMessage } from '../ui-protocol.js'

export type Theme = 'system' | 'light' | 'dark'

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
}

export function RunControls({ connected, isRunning, isWatching, deviceSerial, counts, theme, onThemeChange, onSend, hasProjectDeps, runDepsFirst, onToggleRunDeps }: RunControlsProps) {
  return (
    <div class="run-controls">
      <div class="rc-left">
        <div class="rc-logo">
          <span class="rc-logo-text">Pilot</span>
          <span class="rc-mode">UI Mode</span>
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
