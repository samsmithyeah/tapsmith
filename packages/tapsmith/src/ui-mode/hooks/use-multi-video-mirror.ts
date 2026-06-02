/**
 * use-multi-video-mirror — one WebCodecs VideoDecoder per worker, for the
 * "All" grid. Mirrors useMultiScreenMirror (screenshots) but decodes H.264.
 * Reuses hasVideoDecoder / avcCodecFromAnnexB from use-video-mirror.
 */
import { useRef, useCallback, useEffect } from 'preact/hooks';
import { hasVideoDecoder, avcCodecFromAnnexB } from './use-video-mirror.js';

interface PerWorkerVideo {
  canvas: HTMLCanvasElement;
  decoder: VideoDecoder | null;
  configured: boolean;
  sawKey: boolean;
}

export function useMultiVideoMirror() {
  const workersRef = useRef<Map<number, PerWorkerVideo>>(new Map());

  const registerVideoCanvas = useCallback((workerId: number, canvas: HTMLCanvasElement) => {
    workersRef.current.set(workerId, { canvas, decoder: null, configured: false, sawKey: false });
  }, []);

  const unregisterVideoCanvas = useCallback((workerId: number) => {
    const entry = workersRef.current.get(workerId);
    if (entry?.decoder) { try { entry.decoder.close(); } catch { /* already closed */ } }
    workersRef.current.delete(workerId);
  }, []);

  const handleVideoFrame = useCallback((workerId: number, payload: ArrayBuffer, keyframe: boolean, config: boolean) => {
    if (!hasVideoDecoder()) return;
    const entry = workersRef.current.get(workerId);
    if (!entry) return;
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
