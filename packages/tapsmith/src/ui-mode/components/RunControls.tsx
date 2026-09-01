/**
 * RunControls — top bar with run/stop buttons, connection status, and one
 * device chip per worker. The chip carries the device's readiness: whether
 * the app has already been prepared for the next run, is being prepared, or
 * has gone stale — and a menu to drive that by hand.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { RefreshCw } from 'lucide-preact';
import type { ClientMessage, WorkerInfo, WorkerReadiness } from '../ui-protocol.js';
import { agentsLabel, agentsTooltip, type McpAgent } from '../mcp-agents.js';
import brandMark from '../../assets/mark.png';
import wordmarkLight from '../../assets/wordmark-light.png';
import wordmarkDark from '../../assets/wordmark-dark.png';

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
  mcpClients?: McpAgent[]
  mcpPanelOpen?: boolean
  onToggleMcpPanel?: () => void
  /** Background device preparation between runs (persisted preference). */
  prepareBetweenRuns?: boolean
  onTogglePrepareBetweenRuns?: () => void
}

const ICON_SIZE = 14;

const DOT_CLASS: Record<WorkerInfo['status'], string> = {
  idle: 'idle',
  running: 'running',
  done: 'done',
  initializing: 'initializing',
  error: 'error',
};

function policyLabel(p: { mode: string; appState?: string }): string {
  if (p.appState) return `restore ${p.appState.split('/').pop()}`;
  if (p.appState === '') return 'clear';
  return p.mode;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Short word shown next to the device name. */
function readinessWord(r: WorkerReadiness | undefined, status: WorkerInfo['status']): string | undefined {
  if (status === 'running') return 'running';
  if (status === 'initializing') return 'starting…';
  if (status === 'error') return 'error';
  if (!r) return undefined;
  switch (r.state) {
    case 'ready': return 'ready';
    case 'preparing': return 'preparing…';
    case 'stale': return 'stale';
    case 'error': return 'prepare failed';
    case 'unprepared': return r.reason === 'speculation-off' ? undefined : 'idle';
    case 'initializing': return 'starting…';
    case 'running': return 'running';
    case 'retired': return 'stopped';
  }
}

function readinessDotClass(r: WorkerReadiness | undefined, status: WorkerInfo['status']): string {
  if (status === 'running' || status === 'initializing' || status === 'error') return DOT_CLASS[status];
  if (!r) return DOT_CLASS[status];
  switch (r.state) {
    case 'ready': return 'ready';
    case 'preparing': return 'preparing';
    case 'stale': return 'stale';
    case 'error': return 'error';
    case 'unprepared': return 'unprepared';
    default: return DOT_CLASS[status];
  }
}

const STALE_REASON: Record<string, string> = {
  'mcp-tool': 'an MCP agent interacted with the device',
  'mirror-gesture': 'the device was interacted with from the mirror',
  'target-changed': 'the next test needs a different starting state',
  'validation-failed': 'the prepared state could not be verified',
  'run-stopped': 'the run was stopped',
  'run-failed': 'tests failed — the app is held for inspection',
  manual: 'preparation was cancelled',
};

function readinessLines(r: WorkerReadiness | undefined, now: number): string[] {
  if (!r) return [];
  switch (r.state) {
    case 'ready': {
      const lines = [`Prepared for: ${policyLabel(r.policy)}${r.forFile ? ` (${r.forFile.split('/').pop()})` : ''}`];
      lines.push(r.durationMs > 0 ? `Prepared ${ago(now - r.preparedAt)}, took ${secs(r.durationMs)}` : `Ready since startup (${ago(now - r.preparedAt)})`);
      return lines;
    }
    case 'preparing':
      return [`Preparing: ${r.detail ?? policyLabel(r.policy)}${r.forFile ? ` for ${r.forFile.split('/').pop()}` : ''}…`];
    case 'stale':
      return [`Stale: ${STALE_REASON[r.reason] ?? r.reason} (${ago(now - r.since)})`];
    case 'error':
      return [`Preparation failed (${r.attempts}×): ${r.message}`];
    case 'unprepared':
      return [r.reason === 'speculation-off'
        ? 'Not prepared — preparation between runs is off'
        : r.reason === 'no-candidate' ? 'Nothing to prepare for yet' : 'Waiting to prepare the device…'];
    default:
      return [];
  }
}

function workerTooltip(w: WorkerInfo, now: number): string {
  const lines = [`${w.displayName} — ${w.deviceSerial}`, `Status: ${w.status}`];
  lines.push(...readinessLines(w.readiness, now));
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

interface WorkerDeviceProps {
  w: WorkerInfo
  onSend: (msg: ClientMessage) => void
  prepareBetweenRuns?: boolean
  onTogglePrepareBetweenRuns?: () => void
}

function WorkerDevice({ w, onSend, prepareBetweenRuns, onTogglePrepareBetweenRuns }: WorkerDeviceProps) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Tooltip ages ("12s ago") only need to be roughly right; re-render on open.
  const now = Date.now();

  const idle = w.status === 'idle';
  const canRespawn = w.status === 'error' || idle;
  const preparing = w.readiness?.state === 'preparing';
  const canPrepareNow = idle && !preparing;

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault();
    setMenu({ workerId: w.workerId, x: e.clientX, y: e.clientY });
  }, [w.workerId]);

  const act = useCallback((msg: ClientMessage) => {
    onSend(msg);
    setMenu(null);
  }, [onSend]);
  const handleRespawn = useCallback(() => act({ type: 'respawn-worker', workerId: w.workerId }), [w.workerId, act]);

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

  const word = readinessWord(w.readiness, w.status);
  const readinessState = w.readiness?.state ?? 'none';

  return (
    <span
      class="rc-device rc-device-actionable"
      title={workerTooltip(w, now)}
      onContextMenu={handleContextMenu}
      data-testid="worker-chip"
      data-worker-id={w.workerId}
      data-readiness={readinessState}
    >
      <span class={`rc-dot ${readinessDotClass(w.readiness, w.status)}`} />
      {w.displayName}
      {word && <span class="rc-readiness" data-testid="worker-readiness">{word}</span>}
      {menu && (
        <div ref={menuRef} class="rc-context-menu" role="menu" aria-label={`Worker ${w.workerId} actions`} style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
          {canPrepareNow && (
            <button class="rc-context-item" role="menuitem" onClick={() => act({ type: 'prepare-now', workerId: w.workerId })}>
              {'\u25B7'} Prepare device now
            </button>
          )}
          {preparing && (
            <button class="rc-context-item" role="menuitem" onClick={() => act({ type: 'cancel-prepare', workerId: w.workerId })}>
              {'\u25A1'} Cancel preparation
            </button>
          )}
          {onTogglePrepareBetweenRuns && (
            <button class="rc-context-item" role="menuitemcheckbox" aria-checked={!!prepareBetweenRuns} onClick={() => { onTogglePrepareBetweenRuns(); setMenu(null); }}>
              {prepareBetweenRuns ? '\u2611' : '\u2610'} Prepare device between runs
            </button>
          )}
          {idle && (
            <button class="rc-context-item" role="menuitem" onClick={() => act({ type: 'recycle-worker', workerId: w.workerId })}>
              {'\u21BA'} Recycle worker (fresh code)
            </button>
          )}
          {canRespawn && (
            <button class="rc-context-item" role="menuitem" onClick={handleRespawn}>
              {'\u21BB'} Respawn worker {w.workerId}
            </button>
          )}
        </div>
      )}
    </span>
  );
}

// ─── RunControls ───

export function RunControls({ connected, isRunning, deviceSerial, counts, theme, onThemeChange, onSend, workers, runElapsed, mcpClientName, mcpClients, mcpPanelOpen, onToggleMcpPanel, prepareBetweenRuns, onTogglePrepareBetweenRuns }: RunControlsProps) {
  // Prefer the full agent list; fall back to the single-name field for back-compat.
  const mcpAgents: McpAgent[] = mcpClients && mcpClients.length > 0
    ? mcpClients
    : mcpClientName
      ? [{ name: mcpClientName, version: '' }]
      : [];
  const mcpConnected = mcpAgents.length > 0;
  const mcpLabel = agentsLabel(mcpAgents);
  // Every session has at least one worker (a single device is one worker), so
  // the chip — and its readiness — always comes from the workers list.
  const hasWorkers = workers.length >= 1;

  return (
    <div class="rail">
      <div class="rail-brand">
        <div class="rail-brand-lockup">
          <img class="rail-mark" src={brandMark} alt="" />
          <div class="rail-brand-text">
            <img class="rail-wordmark rail-wordmark-light" src={wordmarkLight} alt="Tapsmith" />
            <img class="rail-wordmark rail-wordmark-dark" src={wordmarkDark} alt="Tapsmith" />
            <span class="rail-brand-sub">UI Mode</span>
          </div>
        </div>
      </div>

      <div class="rail-right">
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
          <span class="rc-elapsed mono" role="timer" aria-label="Elapsed run time">{formatElapsed(runElapsed)}</span>
        )}
        {counts.total > 0 && (
          <div class="rc-counts">
            {counts.passed > 0 && <span class="rc-count passed" data-testid="count-passed">{counts.passed} passed</span>}
            {counts.failed > 0 && <span class="rc-count failed" data-testid="count-failed">{counts.failed} failed</span>}
            {counts.skipped > 0 && <span class="rc-count skipped" data-testid="count-skipped">{counts.skipped} skipped</span>}
          </div>
        )}
        <span class="rc-divider" />
        <div class="rc-connection" role="status" aria-label="Device connection">
          {!connected
            ? (
              <span class="rc-device">
                <span class="rc-dot error" />
                Disconnected
              </span>
            )
            : hasWorkers
              ? workers.map((w) => (
                <WorkerDevice key={w.workerId} w={w} onSend={onSend} prepareBetweenRuns={prepareBetweenRuns} onTogglePrepareBetweenRuns={onTogglePrepareBetweenRuns} />
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
          aria-label={mcpPanelOpen ? 'Hide device activity' : 'Show device activity'}
          aria-expanded={mcpPanelOpen}
          title={mcpConnected ? `MCP agents:\n${agentsTooltip(mcpAgents)}\n(click to toggle the device activity panel)` : 'MCP: listening (click to toggle the device activity panel)'}
        >
          <span class={`mcp-dot ${mcpConnected ? 'connected' : 'listening'}`} />
          MCP
          {mcpConnected && <span class="rc-mcp-client">{mcpLabel}</span>}
        </button>
        <span class="rc-divider" />
        <select
          class="rc-theme-select"
          aria-label="Theme"
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
