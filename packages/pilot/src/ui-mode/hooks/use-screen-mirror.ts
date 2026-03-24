/**
 * Screen mirror hook for UI mode.
 *
 * Receives binary WebSocket frames containing PNG screenshots and renders
 * them onto a canvas element using createImageBitmap for smooth performance.
 */

import { useRef, useCallback, useEffect } from 'preact/hooks'
import { decodeScreenFrameHeader } from '../ui-protocol.js'

export interface ScreenMirrorState {
  width: number
  height: number
  lastSeq: number
}

export function useScreenMirror() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<ScreenMirrorState>({ width: 0, height: 0, lastSeq: 0 })
  const pendingFrameRef = useRef<number | null>(null)

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const { seq, width, height, pngOffset } = decodeScreenFrameHeader(data)

    // Skip out-of-order frames
    if (seq < stateRef.current.lastSeq) return
    stateRef.current.lastSeq = seq
    stateRef.current.width = width
    stateRef.current.height = height

    // Extract PNG data
    const pngData = data.slice(pngOffset)
    const blob = new Blob([pngData], { type: 'image/png' })

    // Cancel any pending render
    if (pendingFrameRef.current !== null) {
      cancelAnimationFrame(pendingFrameRef.current)
    }

    // Render on next animation frame for smooth display
    createImageBitmap(blob).then((bitmap) => {
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = null
        const canvas = canvasRef.current
        if (!canvas) return

        // Resize canvas if dimensions changed
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width
          canvas.height = bitmap.height
        }

        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0)
        }
        bitmap.close()
      })
    }).catch(() => {
      // Ignore corrupt frames
    })
  }, [])

  useEffect(() => {
    return () => {
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current)
      }
    }
  }, [])

  return {
    canvasRef,
    handleBinaryFrame,
    getScreenSize: () => stateRef.current,
  }
}
