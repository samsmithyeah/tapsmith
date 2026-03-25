/**
 * Screen mirror hooks for UI mode.
 *
 * `useScreenMirror` — single canvas, renders frames for one worker (ignores workerId).
 * `useMultiScreenMirror` — routes frames by workerId to registered canvases.
 */

import { useRef, useCallback, useEffect } from 'preact/hooks';
import { decodeScreenFrameHeader } from '../ui-protocol.js';

// ─── Single-canvas hook (used for per-worker view) ───

export interface ScreenMirrorState {
  width: number
  height: number
  lastSeq: number
}

export function useScreenMirror() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ScreenMirrorState>({ width: 0, height: 0, lastSeq: 0 });
  const pendingFrameRef = useRef<number | null>(null);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const { seq, width, height, pngOffset } = decodeScreenFrameHeader(data);

    // Skip out-of-order frames
    if (seq < stateRef.current.lastSeq) return;
    stateRef.current.lastSeq = seq;
    stateRef.current.width = width;
    stateRef.current.height = height;

    // Extract PNG data
    const pngData = data.slice(pngOffset);
    const blob = new Blob([pngData], { type: 'image/png' });

    // Cancel any pending render
    if (pendingFrameRef.current !== null) {
      cancelAnimationFrame(pendingFrameRef.current);
    }

    // Render on next animation frame for smooth display
    createImageBitmap(blob).then((bitmap) => {
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = null;
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Resize canvas if dimensions changed
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      });
    }).catch(() => {
      // Ignore corrupt frames
    });
  }, []);

  useEffect(() => {
    return () => {
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current);
      }
    };
  }, []);

  return {
    canvasRef,
    handleBinaryFrame,
    getScreenSize: () => stateRef.current,
  };
}

// ─── Multi-canvas hook (used for "All" grid view) ───

interface PerWorkerState {
  canvas: HTMLCanvasElement
  lastSeq: number
  pendingFrame: number | null
}

export function useMultiScreenMirror() {
  const workersRef = useRef<Map<number, PerWorkerState>>(new Map());

  const registerCanvas = useCallback((workerId: number, canvas: HTMLCanvasElement) => {
    workersRef.current.set(workerId, { canvas, lastSeq: 0, pendingFrame: null });
  }, []);

  const unregisterCanvas = useCallback((workerId: number) => {
    const entry = workersRef.current.get(workerId);
    if (entry?.pendingFrame != null) {
      cancelAnimationFrame(entry.pendingFrame);
    }
    workersRef.current.delete(workerId);
  }, []);

  const handleBinaryFrame = useCallback((data: ArrayBuffer) => {
    const { seq, workerId, pngOffset } = decodeScreenFrameHeader(data);

    const entry = workersRef.current.get(workerId);
    if (!entry) return;

    // Skip out-of-order frames for this worker
    if (seq < entry.lastSeq) return;
    entry.lastSeq = seq;

    const pngData = data.slice(pngOffset);
    const blob = new Blob([pngData], { type: 'image/png' });

    if (entry.pendingFrame !== null) {
      cancelAnimationFrame(entry.pendingFrame);
    }

    createImageBitmap(blob).then((bitmap) => {
      entry.pendingFrame = requestAnimationFrame(() => {
        entry.pendingFrame = null;
        const { canvas } = entry;

        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      });
    }).catch(() => {
      // Ignore corrupt frames
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const entry of workersRef.current.values()) {
        if (entry.pendingFrame !== null) {
          cancelAnimationFrame(entry.pendingFrame);
        }
      }
    };
  }, []);

  return {
    registerCanvas,
    unregisterCanvas,
    handleBinaryFrame,
  };
}
