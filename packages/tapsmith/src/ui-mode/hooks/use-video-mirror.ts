/**
 * use-video-mirror — decode an H.264 (Annex-B) stream to the device-mirror
 * canvas via WebCodecs VideoDecoder. The caller falls back to screenshot
 * polling when VideoDecoder is unavailable or the decoder errors.
 */
import { useRef, useCallback, useEffect } from 'preact/hooks';

/** True when the browser can decode H.264 video frames. */
export function hasVideoDecoder(): boolean {
  return typeof window !== 'undefined' && 'VideoDecoder' in window;
}

/** Build an `avc1.PPCCLL` codec string from the SPS in an Annex-B buffer. */
export function avcCodecFromAnnexB(data: Uint8Array): string | undefined {
  let i = 0;
  while (i + 4 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const nalStart = i + 3;
      const nalType = data[nalStart] & 0x1f;
      if (nalType === 7 && nalStart + 3 < data.length) {
        const profile = data[nalStart + 1];
        const constraints = data[nalStart + 2];
        const level = data[nalStart + 3];
        const hex = (n: number) => n.toString(16).padStart(2, '0');
        return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
      }
      i = nalStart;
    } else {
      i++;
    }
  }
  return undefined;
}

export function useVideoMirror() {
  const decoderRef = useRef<VideoDecoder | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The codec string the decoder is currently configured with (null = not yet
  // configured). Tracked so we reconfigure if it changes mid-stream.
  const configuredCodecRef = useRef<string | null>(null);
  const sawKeyRef = useRef(false);

  const reset = useCallback(() => {
    try { decoderRef.current?.close(); } catch { /* already closed */ }
    decoderRef.current = null;
    configuredCodecRef.current = null;
    sawKeyRef.current = false;
  }, []);

  // Close the decoder on unmount — hardware decoder sessions are a limited
  // OS/browser resource and would otherwise leak.
  useEffect(() => reset, [reset]);

  const handleVideoFrame = useCallback((payload: ArrayBuffer, keyframe: boolean, config: boolean) => {
    if (!hasVideoDecoder()) return;
    const bytes = new Uint8Array(payload);
    if (!decoderRef.current) {
      decoderRef.current = new VideoDecoder({
        output: (frame) => {
          const canvas = canvasRef.current;
          if (canvas) {
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
            }
            canvas.getContext('2d')?.drawImage(frame, 0, 0);
          }
          frame.close();
        },
        error: () => { reset(); },
      });
    }
    const dec = decoderRef.current;
    if (config) {
      const codec = avcCodecFromAnnexB(bytes);
      // (Re)configure on the first config NAL and whenever the codec changes
      // mid-stream — e.g. device rotation / resolution change emits a new SPS;
      // ignoring it would leave the decoder mis-configured and corrupt output.
      if (codec && codec !== configuredCodecRef.current) {
        dec.configure({ codec, optimizeForLatency: true } as VideoDecoderConfig);
        configuredCodecRef.current = codec;
      }
    }
    if (configuredCodecRef.current === null) return;
    if (!sawKeyRef.current && !keyframe) return; // wait for the first keyframe
    if (keyframe) sawKeyRef.current = true;
    try {
      dec.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: performance.now() * 1000,
        data: bytes,
      }));
    } catch { reset(); }
  }, [reset]);

  return { canvasRef, handleVideoFrame, reset, hasVideoDecoder };
}
