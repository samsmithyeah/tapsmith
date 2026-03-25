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
            <div class="dm-overlay-text">Connecting to device...</div>
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
