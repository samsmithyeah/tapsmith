/**
 * DeviceMirror — canvas-based live device screen mirror.
 *
 * Renders PNG screenshots received via WebSocket binary frames onto a
 * <canvas> element. Supports interactive tap mode where clicks on the
 * canvas are translated to device coordinates and sent to the server.
 */

import { useState, useCallback } from 'preact/hooks'
import type { RefObject } from 'preact'
import type { ClientMessage } from '../ui-protocol.js'

interface DeviceMirrorProps {
  canvasRef: RefObject<HTMLCanvasElement>
  connected: boolean
  onSend: (msg: ClientMessage) => void
}

export function DeviceMirror({ canvasRef, connected, onSend }: DeviceMirrorProps) {
  const [tapMode, setTapMode] = useState(false)

  const handleCanvasClick = useCallback((e: MouseEvent) => {
    if (!tapMode) return
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    // Normalize coordinates to 0-1 range based on displayed size
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    onSend({ type: 'tap-coordinates', x, y })
  }, [tapMode, canvasRef, onSend])

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
          class={`dm-canvas ${tapMode ? 'tap-mode' : ''}`}
          onClick={handleCanvasClick}
        />
      </div>
      <div class="dm-controls">
        <button
          class={`dm-btn ${tapMode ? 'active' : ''}`}
          onClick={() => setTapMode(!tapMode)}
          title={tapMode ? 'Disable tap mode' : 'Enable tap mode — click on screen to tap device'}
        >
          {'\u25C9'} Tap
        </button>
        <button
          class="dm-btn"
          onClick={() => onSend({ type: 'request-hierarchy' })}
          title="Inspect UI hierarchy"
        >
          {'\u2B1A'} Inspect
        </button>
      </div>
    </div>
  )
}
