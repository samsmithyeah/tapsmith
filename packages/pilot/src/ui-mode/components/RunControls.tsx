/**
 * RunControls — top bar with run/stop buttons and connection status.
 */

import type { ClientMessage } from '../ui-protocol.js'

interface RunControlsProps {
  connected: boolean
  isRunning: boolean
  deviceSerial: string
  counts: { passed: number; failed: number; skipped: number; total: number }
  onSend: (msg: ClientMessage) => void
}

export function RunControls({ connected, isRunning, deviceSerial, counts, onSend }: RunControlsProps) {
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
          class="rc-btn rc-watch-all"
          onClick={() => onSend({ type: 'toggle-watch', filePath: 'all' })}
          disabled={!connected}
          title="Toggle watch mode for all files"
        >
          {'\u25C9'} Watch
        </button>
      </div>

      <div class="rc-right">
        {counts.total > 0 && (
          <div class="rc-counts">
            {counts.passed > 0 && <span class="rc-count passed">{counts.passed} passed</span>}
            {counts.failed > 0 && <span class="rc-count failed">{counts.failed} failed</span>}
            {counts.skipped > 0 && <span class="rc-count skipped">{counts.skipped} skipped</span>}
          </div>
        )}
        <div class={`rc-connection ${connected ? 'connected' : 'disconnected'}`}>
          <span class="rc-dot" />
          {deviceSerial || (connected ? 'Connected' : 'Disconnected')}
        </div>
      </div>
    </div>
  )
}
