/**
 * DevicePane — dedicated device mirror pane with multi-worker support.
 *
 * Single-worker: shows DeviceMirror directly.
 * Multi-worker: worker tabs (All + per-worker) with status dots.
 *   - Per-worker tab: single DeviceMirror for the selected worker.
 *   - "All" tab: vertical grid of all worker devices.
 */

import type { RefObject } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { Lock, LockOpen, Focus } from 'lucide-preact';
import type { WorkerInfo, ClientMessage, DevicePlatform } from '../ui-protocol.js';
import { inferDevicePlatform, inferDeviceFormFactor } from '../ui-protocol.js';
import type { Bounds } from '../../trace-viewer/components/hierarchy-utils.js';
import { DeviceMirror } from './DeviceMirror.js';
import { DeviceFrame } from './DeviceFrame.js';
import { useDeviceInteraction } from '../hooks/use-device-interaction.js';
import { nextTabIndex, focusSibling } from '../tabstrip.js';

interface DevicePaneProps {
  canvasRef: RefObject<HTMLCanvasElement>
  connected: boolean
  workers: WorkerInfo[]
  selectedWorkerId: number
  deviceViewMode: 'all' | number
  onSelectDeviceView: (mode: 'all' | number) => void
  registerCanvas: (workerId: number, canvas: HTMLCanvasElement) => void
  unregisterCanvas: (workerId: number) => void
  /** Single-view mirror is starting and hasn't painted its first frame yet. */
  mirrorLoading: boolean
  platform?: 'android' | 'ios'
  interactive: boolean
  locked: boolean
  force: boolean
  onToggleLock: () => void
  send: (msg: ClientMessage) => void
  /** Element pick mode on the live mirror (single-mirror view only). */
  pickMode: boolean
  onTogglePick: () => void
  pickAvailable: boolean
  pickDpr: number
  pickHoverBounds: Bounds | null
  pickMatchBounds: Bounds[]
  onPickPoint: (point: { x: number; y: number }) => void
  onPickHover: (point: { x: number; y: number } | null) => void
}

const DOT_CLASS: Record<WorkerInfo['status'], string> = {
  idle: 'idle',
  running: 'running',
  done: 'done',
  initializing: 'initializing',
  error: 'error',
};

/** Canvas ref callback for the "All" grid — registers/unregisters with multi-mirror hook. */
function WorkerCanvas({ workerId, label, deviceSerial, connected, registerCanvas, unregisterCanvas, platform, interactive, force, send }: {
  workerId: number
  label: string
  deviceSerial: string
  connected: boolean
  registerCanvas: (id: number, canvas: HTMLCanvasElement) => void
  unregisterCanvas: (id: number) => void
  platform?: DevicePlatform
  interactive: boolean
  force: boolean
  send: (msg: ClientMessage) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const framePlatform = platform ?? inferDevicePlatform(label, deviceSerial);
  const frameFormFactor = inferDeviceFormFactor({ hints: [label, deviceSerial] });
  const interaction = useDeviceInteraction({ send, enabled: interactive, force, workerId });

  // Register this tile's canvas with the screenshot mirror.
  useEffect(() => {
    if (ref.current) {
      registerCanvas(workerId, ref.current);
    }
    return () => unregisterCanvas(workerId);
  }, [workerId, registerCanvas, unregisterCanvas]);

  return (
    <div class="device-body-item">
      <div class="device-body-label">{label}</div>
      <div class="dm-viewport">
        {!connected && (
          <div class="dm-overlay">
            <div class="dm-placeholder">
              <svg class="dm-phone-icon" viewBox="0 0 56 96" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="52" height="92" rx="8" stroke="currentColor" stroke-width="2.5" />
                <rect x="8" y="14" width="40" height="64" rx="2" fill="currentColor" opacity="0.08" />
                <rect x="22" y="84" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.3" />
                <circle cx="28" cy="8" r="2" fill="currentColor" opacity="0.2" />
              </svg>
              <div class="dm-placeholder-text">Waiting for device</div>
              <div class="dm-placeholder-dots">
                <span class="dm-dot" />
                <span class="dm-dot" />
                <span class="dm-dot" />
              </div>
            </div>
          </div>
        )}
        <DeviceFrame platform={framePlatform} formFactor={frameFormFactor}>
          <canvas
            ref={ref}
            aria-label={`Device screen mirror — ${label}`}
            class={`dm-canvas ${interactive ? 'interactive' : 'locked'}`}
            tabIndex={interactive ? 0 : -1}
            onPointerDown={interactive ? interaction.onPointerDown : undefined}
            onPointerMove={interactive ? interaction.onPointerMove : undefined}
            onPointerUp={interactive ? interaction.onPointerUp : undefined}
            onPointerCancel={interactive ? interaction.onPointerCancel : undefined}
            onKeyDown={interactive ? interaction.onKeyDown : undefined}
          />
        </DeviceFrame>
      </div>
    </div>
  );
}

export function DevicePane({
  canvasRef,
  connected,
  workers,
  selectedWorkerId,
  deviceViewMode,
  onSelectDeviceView,
  registerCanvas,
  unregisterCanvas,
  mirrorLoading,
  platform,
  interactive,
  locked,
  force,
  onToggleLock,
  send,
  pickMode,
  onTogglePick,
  pickAvailable,
  pickDpr,
  pickHoverBounds,
  pickMatchBounds,
  onPickPoint,
  onPickHover,
}: DevicePaneProps) {
  const hasWorkers = workers.length > 1;
  const selectedWorker = workers.find((worker) => worker.workerId === selectedWorkerId);
  const mirrorPlatform = selectedWorker
    ? (selectedWorker.platform ?? inferDevicePlatform(selectedWorker.displayName, selectedWorker.deviceSerial) ?? platform)
    : platform;
  const mirrorFormFactor = inferDeviceFormFactor({
    hints: selectedWorker ? [selectedWorker.displayName, selectedWorker.deviceSerial] : [],
  });

  // Left/Right move between the All tab and the per-device tabs; Home/End jump
  // to the ends. Additive: these are real buttons and stay individually
  // tabbable (see tabstrip.ts).
  const deviceViews: Array<'all' | number> = ['all', ...workers.map((w) => w.workerId)];
  const handleWorkerTabKey = (e: KeyboardEvent, index: number) => {
    const next = nextTabIndex(e.key, index, deviceViews.length);
    if (next === null) return;
    e.preventDefault();
    onSelectDeviceView(deviceViews[next]);
    focusSibling(e, next);
  };

  return (
    <div class="device-col" role="region" aria-label="Live device mirror">
      <div class="device-head">
        <span class="device-head-title">Live device mirror</span>
        <span class="device-head-meta">
          <span class="dot running" />
        </span>
        {/* Always-visible lock toggle. Off (interactive) by default; auto-locks
            while a run is active, but the user can lock/unlock at any time. An
            explicit lock sticks past the run; an unlock-override is per-run. */}
        <button
          type="button"
          class={`mirror-lock-toggle ${locked ? 'locked' : 'unlocked'}`}
          onClick={onToggleLock}
          aria-label={locked ? 'Interaction locked — click to unlock' : 'Interaction unlocked — click to lock'}
          title={locked ? 'Interaction locked — click to unlock' : 'Interaction unlocked — click to lock'}
        >
          {locked ? <Lock size={15} aria-hidden="true" /> : <LockOpen size={15} aria-hidden="true" />}
        </button>
        {/* Element picker for the live mirror — click an element to get a
            locator in the Locator tab. Single-mirror view only. */}
        <button
          type="button"
          class={`mirror-pick-toggle ${pickMode ? 'active' : ''}`}
          onClick={onTogglePick}
          disabled={!pickAvailable}
          aria-label={pickMode ? 'Picking element — click to cancel' : 'Pick an element to get a locator'}
          title={!pickAvailable && deviceViewMode === 'all' && workers.length > 1
            ? 'Select a device tab to pick'
            : pickMode ? 'Picking element — click to cancel' : 'Pick an element to get a locator'}
        >
          <Focus size={15} aria-hidden="true" />
        </button>
      </div>

      {hasWorkers && (
        <div class="worker-tabs" role="tablist" aria-label="Device views">
          <button
            class={`worker-tab ${deviceViewMode === 'all' ? 'active' : ''}`}
            role="tab"
            aria-selected={deviceViewMode === 'all'}
            onClick={() => onSelectDeviceView('all')}
            onKeyDown={(e) => handleWorkerTabKey(e, 0)}
          >
            All
          </button>
          {workers.map((w, i) => (
            <button
              key={w.workerId}
              class={`worker-tab ${deviceViewMode === w.workerId ? 'active' : ''}`}
              role="tab"
              aria-selected={deviceViewMode === w.workerId}
              onClick={() => onSelectDeviceView(w.workerId)}
              onKeyDown={(e) => handleWorkerTabKey(e, i + 1)}
              title={`${w.displayName} (${w.deviceSerial}) — ${w.status}`}
            >
              <span class={`dot ${connected ? DOT_CLASS[w.status] : 'error'}`} />
              {w.displayName}
            </button>
          ))}
        </div>
      )}

      <div class="device-pane-body">
        {deviceViewMode === 'all' && hasWorkers ? (
          <div class="device-pane-grid">
            {workers.map((w) => (
              <WorkerCanvas
                key={w.workerId}
                workerId={w.workerId}
                label={w.displayName}
                deviceSerial={w.deviceSerial}
                connected={connected}
                registerCanvas={registerCanvas}
                unregisterCanvas={unregisterCanvas}
                platform={w.platform}
                interactive={interactive}
                force={force}
                send={send}
              />
            ))}
          </div>
        ) : (
          <DeviceMirror
            canvasRef={canvasRef}
            connected={connected}
            loading={mirrorLoading}
            platform={mirrorPlatform}
            formFactor={mirrorFormFactor}
            interactive={interactive}
            force={force}
            workerId={typeof deviceViewMode === 'number' ? deviceViewMode : selectedWorkerId}
            send={send}
            pickMode={pickMode}
            pickDpr={pickDpr}
            pickHoverBounds={pickHoverBounds}
            pickMatchBounds={pickMatchBounds}
            onPickPoint={onPickPoint}
            onPickHover={onPickHover}
          />
        )}
      </div>
    </div>
  );
}
