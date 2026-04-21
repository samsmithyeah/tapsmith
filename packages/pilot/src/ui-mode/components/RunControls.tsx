/**
 * RunControls — top bar with run/stop buttons, connection status, and worker indicators.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { RefreshCw } from 'lucide-preact';
import type { ClientMessage, WorkerInfo } from '../ui-protocol.js';

export type Theme = 'system' | 'light' | 'dark'

interface RunControlsProps {
  connected: boolean
  isRunning: boolean
  deviceSerial: string
  counts: { passed: number; failed: number; skipped: number; total: number }
  theme: Theme
  onThemeChange: (theme: Theme) => void
  onSend: (msg: ClientMessage) => void
  /** Workers in multi-worker mode. Empty array for single-worker. */
  workers: WorkerInfo[]
  /** Elapsed run time in ms. */
  runElapsed: number
  mcpClientName?: string
  mcpPanelOpen?: boolean
  onToggleMcpPanel?: () => void
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
  const lines = [`${w.displayName} — ${w.deviceSerial}`, `Status: ${w.status}`];
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
      {w.displayName}
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

export function RunControls({ connected, isRunning, deviceSerial, counts, theme, onThemeChange, onSend, workers, runElapsed, mcpClientName, mcpPanelOpen, onToggleMcpPanel }: RunControlsProps) {
  const hasWorkers = workers.length > 1;

  return (
    <div class="run-controls">
      <div class="rc-left">
        <div class="rc-logo">
          <span class="rc-logo-text">Pilot</span>
          <span class="rc-mode">UI Mode</span>
        </div>
      </div>

      <div class="rc-center">
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
        <button
          class={`rc-mcp-indicator ${mcpPanelOpen ? 'active' : ''}`}
          onClick={onToggleMcpPanel}
          title={mcpClientName ? `MCP: ${mcpClientName} (click to toggle panel)` : 'MCP: listening (click to toggle panel)'}
        >
          <span class={`rc-dot ${mcpClientName ? 'done' : 'idle'}`} />
          MCP
          {mcpClientName && <span class="rc-mcp-client">{mcpClientName}</span>}
        </button>
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
