/**
 * RunControls — top bar with run/stop buttons, connection status, and worker indicators.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Eye, Link, Play, RefreshCw, Square } from 'lucide-preact';
import type { ClientMessage } from '../ui-protocol.js';

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
  isStopping: boolean
  isWatching: boolean
  deviceSerial: string
  counts: { passed: number; failed: number; skipped: number; total: number }
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onSend: (msg: ClientMessage) => void
  onStop: () => void
  /** Whether any project has dependencies (controls visibility of the deps toggle). */
  hasProjectDeps: boolean
  runDepsFirst: boolean
  onToggleRunDeps: () => void
  /** Workers in multi-worker mode. Empty array for single-worker. */
  workers: WorkerInfo[]
  /** Elapsed run time in ms. */
  runElapsed: number
}

const ICON_SIZE = 14;

const DOT_CLASS: Record<WorkerInfo['status'], string> = {
  idle: 'idle',
  running: 'running',
  done: 'done',
  initializing: 'initializing',
  error: 'error',
};

function workerTooltip(w: WorkerInfo): string {
  const lines = [`W${w.workerId} — ${w.deviceSerial}`, `Status: ${w.status}`];
  if (w.currentFile) lines.push(`File: ${w.currentFile}`);
  if (w.currentTest) lines.push(`Test: ${w.currentTest}`);
  lines.push(`${w.passed}P ${w.failed}F ${w.skipped}S`);
  return lines.join('\n');
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '0.0s';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

// ─── Worker context menu ───

interface ContextMenuState {
  workerId: number;
  x: number;
  y: number;
}

function WorkerDevice({ w, onSend }: { w: WorkerInfo; onSend: (msg: ClientMessage) => void }) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const canRespawn = w.status === 'error' || w.status === 'idle';

  const handleContextMenu = useCallback((e: MouseEvent) => {
    if (!canRespawn) return;
    e.preventDefault();
    setMenu({ workerId: w.workerId, x: e.clientX, y: e.clientY });
  }, [w.workerId, canRespawn]);

  const handleRespawn = useCallback(() => {
    onSend({ type: 'respawn-worker', workerId: w.workerId });
    setMenu(null);
  }, [w.workerId, onSend]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!menu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menu]);

  return (
    <span
      class={`rc-device ${canRespawn ? 'rc-device-actionable' : ''}`}
      title={workerTooltip(w)}
      onContextMenu={handleContextMenu}
    >
      <span class={`rc-dot ${DOT_CLASS[w.status]}`} />
      {w.deviceSerial}
      {menu && (
        <div ref={menuRef} class="rc-context-menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          <button class="rc-context-item" onClick={handleRespawn}>
            {'\u21BB'} Respawn worker {w.workerId}
          </button>
        </div>
      )}
    </span>
  );
}

// ─── RunControls ───

export function RunControls({ connected, isRunning, isStopping, isWatching, deviceSerial, counts, theme, onThemeChange, onSend, onStop, hasProjectDeps, runDepsFirst, onToggleRunDeps, workers, runElapsed }: RunControlsProps) {
  const hasWorkers = workers.length > 1;

  // Delay showing "Stopping…" text so quick stops don't flicker
  const [showStoppingText, setShowStoppingText] = useState(false);
  useEffect(() => {
    if (!isStopping) {
      setShowStoppingText(false);
      return;
    }
    const timer = setTimeout(() => setShowStoppingText(true), 200);
    return () => clearTimeout(timer);
  }, [isStopping]);

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
          title="Run all tests (r)"
        >
          <Play size={ICON_SIZE} /> Run All <span class="rc-kbd">R</span>
        </button>
        {counts.failed > 0 && (
          <button
            class="rc-btn rc-run-failed"
            onClick={() => onSend({ type: 'run-failed' })}
            disabled={isRunning || !connected}
            title="Re-run failed tests (f)"
          >
            <RefreshCw size={ICON_SIZE} /> Rerun Failed <span class="rc-kbd">F</span>
          </button>
        )}
        {isRunning && (
          <button
            class="rc-btn rc-stop"
            onClick={onStop}
            disabled={isStopping}
            title="Stop current run (Esc)"
          >
            <Square size={ICON_SIZE} /> {showStoppingText ? 'Stopping\u2026' : 'Stop'} <span class="rc-kbd">Esc</span>
          </button>
        )}
        <button
          class={`rc-btn rc-toggle ${isWatching ? 'active' : ''}`}
          onClick={() => onSend({ type: 'toggle-watch', filePath: 'all' })}
          disabled={!connected}
          title={isWatching ? 'Disable watch mode (w)' : 'Watch all files for changes (w)'}
        >
          <Eye size={ICON_SIZE} /> Watch <span class="rc-kbd">W</span>
        </button>
        {hasProjectDeps && (
          <button
            class={`rc-btn rc-toggle ${runDepsFirst ? 'active' : ''}`}
            onClick={onToggleRunDeps}
            title={runDepsFirst
              ? 'Dependencies run automatically before tests — click to disable'
              : 'Run dependency projects before tests — click to enable'}
          >
            <Link size={ICON_SIZE} /> Run deps
          </button>
        )}
      </div>

      <div class="rc-right">
        {isRunning && (
          <span class="rc-elapsed">{formatElapsed(runElapsed)}</span>
        )}
        {counts.total > 0 && (
          <div class="rc-counts">
            {counts.passed > 0 && <span class="rc-count passed">{counts.passed} passed</span>}
            {counts.failed > 0 && <span class="rc-count failed">{counts.failed} failed</span>}
            {counts.skipped > 0 && <span class="rc-count skipped">{counts.skipped} skipped</span>}
          </div>
        )}
        <span class="rc-divider" />
        <div class="rc-connection">
          {!connected
            ? (
              <span class="rc-device">
                <span class="rc-dot error" />
                Disconnected
              </span>
            )
            : hasWorkers
              ? workers.map((w) => (
                <WorkerDevice key={w.workerId} w={w} onSend={onSend} />
              ))
              : (
                <span class="rc-device" title={deviceSerial}>
                  <span class="rc-dot done" />
                  {deviceSerial || 'Connected'}
                </span>
              )}
        </div>
        <span class="rc-divider" />
        <select
          class="rc-theme-select"
          value={theme}
          onChange={(e) => onThemeChange((e.target as HTMLSelectElement).value as Theme)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </div>
  );
}
