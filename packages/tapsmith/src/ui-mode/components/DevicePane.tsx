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
import { Lock, LockOpen } from 'lucide-preact';
import type { WorkerInfo, ClientMessage, DevicePlatform } from '../ui-protocol.js';
import { inferDevicePlatform, inferDeviceFormFactor } from '../ui-protocol.js';
import { DeviceMirror } from './DeviceMirror.js';
import { DeviceFrame } from './DeviceFrame.js';
import { useDeviceInteraction } from '../hooks/use-device-interaction.js';

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

  // The "All" grid renders screenshots for every tile (multi-tile H.264 can't
  // sustain decode under contention — live video is reserved for the focused
  // single-device view). Register this tile's canvas with the screenshot mirror.
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
}: DevicePaneProps) {
  const hasWorkers = workers.length > 1;
  const selectedWorker = workers.find((worker) => worker.workerId === selectedWorkerId);
  const mirrorPlatform = selectedWorker
    ? (selectedWorker.platform ?? inferDevicePlatform(selectedWorker.displayName, selectedWorker.deviceSerial) ?? platform)
    : platform;
  const mirrorFormFactor = inferDeviceFormFactor({
    hints: selectedWorker ? [selectedWorker.displayName, selectedWorker.deviceSerial] : [],
  });

  return (
    <div class="device-col">
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
      </div>

      {hasWorkers && (
        <div class="worker-tabs">
          <button
            class={`worker-tab ${deviceViewMode === 'all' ? 'active' : ''}`}
            onClick={() => onSelectDeviceView('all')}
          >
            All
          </button>
          {workers.map((w) => (
            <button
              key={w.workerId}
              class={`worker-tab ${deviceViewMode === w.workerId ? 'active' : ''}`}
              onClick={() => onSelectDeviceView(w.workerId)}
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
          />
        )}
      </div>
    </div>
  );
}
