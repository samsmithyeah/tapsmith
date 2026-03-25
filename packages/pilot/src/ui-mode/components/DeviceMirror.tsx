/**
 * DeviceMirror — canvas-based live device screen mirror.
 *
 * Renders PNG screenshots received via WebSocket binary frames onto a
 * <canvas> element.
 */

import type { RefObject } from 'preact';

interface DeviceMirrorProps {
  canvasRef: RefObject<HTMLCanvasElement>
  connected: boolean
}

export function DeviceMirror({ canvasRef, connected }: DeviceMirrorProps) {
  return (
    <div class="device-mirror">
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
              <div class="dm-placeholder-hint">Connect a device or start a test run</div>
              <div class="dm-placeholder-dots">
                <span class="dm-dot" />
                <span class="dm-dot" />
                <span class="dm-dot" />
              </div>
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          class="dm-canvas"
        />
      </div>
    </div>
  );
}
