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
import type { WorkerInfo } from '../ui-protocol.js';
import { DeviceMirror } from './DeviceMirror.js';

interface DevicePaneProps {
  canvasRef: RefObject<HTMLCanvasElement>
  connected: boolean
  workers: WorkerInfo[]
  selectedWorkerId: number
  deviceViewMode: 'all' | number
  onSelectDeviceView: (mode: 'all' | number) => void
  registerCanvas: (workerId: number, canvas: HTMLCanvasElement) => void
  unregisterCanvas: (workerId: number) => void
}

const DOT_CLASS: Record<WorkerInfo['status'], string> = {
  idle: 'idle',
  running: 'running',
  done: 'done',
  initializing: 'initializing',
  error: 'error',
};

/** Canvas ref callback for the "All" grid — registers/unregisters with multi-mirror hook. */
function WorkerCanvas({ workerId, label, connected, registerCanvas, unregisterCanvas }: {
  workerId: number
  label: string
  connected: boolean
  registerCanvas: (id: number, canvas: HTMLCanvasElement) => void
  unregisterCanvas: (id: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) {
      registerCanvas(workerId, ref.current);
    }
    return () => unregisterCanvas(workerId);
  }, [workerId, registerCanvas, unregisterCanvas]);

  return (
    <div class="device-pane-grid-item">
      <div class="device-pane-grid-label">{label}</div>
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
        <canvas ref={ref} class="dm-canvas" />
      </div>
    </div>
  );
}

export function DevicePane({
  canvasRef,
  connected,
  workers,
  selectedWorkerId: _selectedWorkerId,
  deviceViewMode,
  onSelectDeviceView,
  registerCanvas,
  unregisterCanvas,
}: DevicePaneProps) {
  const hasWorkers = workers.length > 1;

  return (
    <div class="device-pane">
      <div class="device-pane-header">
        <span class="device-pane-header-title">Live device mirror</span>
      </div>

      {hasWorkers && (
        <div class="device-pane-workers">
          <button
            class={`device-pane-worker ${deviceViewMode === 'all' ? 'active' : ''}`}
            onClick={() => onSelectDeviceView('all')}
          >
            All
          </button>
          {workers.map((w) => (
            <button
              key={w.workerId}
              class={`device-pane-worker ${deviceViewMode === w.workerId ? 'active' : ''}`}
              onClick={() => onSelectDeviceView(w.workerId)}
              title={`${w.deviceSerial} — ${w.status}`}
            >
              <span class={`rc-dot ${connected ? DOT_CLASS[w.status] : 'error'}`} />
              {w.deviceSerial}
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
                label={w.deviceSerial}
                connected={connected}
                registerCanvas={registerCanvas}
                unregisterCanvas={unregisterCanvas}
              />
            ))}
          </div>
        ) : (
          <DeviceMirror canvasRef={canvasRef} connected={connected} />
        )}
      </div>
    </div>
  );
}
