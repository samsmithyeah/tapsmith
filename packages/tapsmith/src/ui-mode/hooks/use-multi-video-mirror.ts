/**
 * use-multi-video-mirror — one WebCodecs VideoDecoder per worker, for the
 * "All" grid. Mirrors useMultiScreenMirror (screenshots) but decodes H.264.
 * Reuses hasVideoDecoder / avcCodecFromAnnexB from use-video-mirror.
 */
import { useRef, useCallback, useEffect } from 'preact/hooks';
import { hasVideoDecoder, avcCodecFromAnnexB } from './use-video-mirror.js';
import { VideoStallWatch } from './video-stall.js';

interface PerWorkerVideo {
  canvas: HTMLCanvasElement;
  decoder: VideoDecoder | null;
  configured: boolean;
  sawKey: boolean;
}

/**
 * @param onStall called with a worker id whose video froze (fed by the server
 *   but not painting). The caller stops video for that worker so the server
 *   resumes screenshot polling — a frozen tile recovers in ~2s instead of
 *   waiting for the stream to cycle.
 */
export function useMultiVideoMirror(onStall?: (workerId: number) => void) {
  const workersRef = useRef<Map<number, PerWorkerVideo>>(new Map());
  const watchRef = useRef(new VideoStallWatch());
  const onStallRef = useRef(onStall);
  onStallRef.current = onStall;

  const registerVideoCanvas = useCallback((workerId: number, canvas: HTMLCanvasElement) => {
    workersRef.current.set(workerId, { canvas, decoder: null, configured: false, sawKey: false });
  }, []);

  const unregisterVideoCanvas = useCallback((workerId: number) => {
    const entry = workersRef.current.get(workerId);
    if (entry?.decoder) { try { entry.decoder.close(); } catch { /* already closed */ } }
    workersRef.current.delete(workerId);
    watchRef.current.remove(workerId);
  }, []);

  // Stall watchdog: if a worker is still being fed H.264 but its decoder has
  // stopped painting, ask the caller to fall back to screenshots for it.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const id of watchRef.current.collectStalled(performance.now())) {
        onStallRef.current?.(id);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleVideoFrame = useCallback((workerId: number, payload: ArrayBuffer, keyframe: boolean, config: boolean) => {
    if (!hasVideoDecoder()) return;
    const entry = workersRef.current.get(workerId);
    if (!entry) return;
    watchRef.current.markInput(workerId, performance.now());
    const bytes = new Uint8Array(payload);
    const resetEntry = () => {
      try { entry.decoder?.close(); } catch { /* already closed */ }
      entry.decoder = null;
      entry.configured = false;
      entry.sawKey = false;
    };
    if (!entry.decoder) {
      entry.decoder = new VideoDecoder({
        output: (frame) => {
          const { canvas } = entry;
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          canvas.getContext('2d')?.drawImage(frame, 0, 0);
          frame.close();
          watchRef.current.markOutput(workerId, performance.now());
        },
        error: () => { resetEntry(); },
      });
    }
    const dec = entry.decoder;
    if (config && !entry.configured) {
      const codec = avcCodecFromAnnexB(bytes);
      if (!codec) return;
      dec.configure({ codec, optimizeForLatency: true } as VideoDecoderConfig);
      entry.configured = true;
    }
    if (!entry.configured) return;
    if (!entry.sawKey && !keyframe) return; // wait for the first keyframe
    if (keyframe) entry.sawKey = true;
    try {
      dec.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: performance.now() * 1000,
        data: bytes,
      }));
    } catch { resetEntry(); }
  }, []);

  useEffect(() => () => {
    for (const entry of workersRef.current.values()) {
      try { entry.decoder?.close(); } catch { /* already closed */ }
    }
  }, []);

  return { registerVideoCanvas, unregisterVideoCanvas, handleVideoFrame };
}
