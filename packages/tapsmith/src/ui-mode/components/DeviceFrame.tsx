/**
 * DeviceFrame — wraps a device mirror canvas in a bezel.
 *
 * Renders a photographic frame image (from bezel.fit, see assets/bezels) when
 * one fits the device, with the canvas positioned over the frame's screen
 * window. Falls back to the CSS bezel (`.dm-skin-*`) for tablets, unknown
 * platforms, or if the frame image fails to load.
 */

import type { ComponentChildren } from 'preact';
import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import type { DevicePlatform, DeviceFormFactor } from '../ui-protocol.js';
import { selectDeviceFrame, screenWindowStyle, screenMaskStyle } from '../assets/bezels/frames.js';

interface DeviceFrameProps {
  platform?: DevicePlatform
  formFactor?: DeviceFormFactor
  /** When true (single mirror), the frame is sized to fit the container's height
   * as well as its width — measured in JS since the container's CSS height is
   * not reliably "definite" enough for container queries. Grid tiles omit this
   * and fill their width (their height is content-driven). */
  heightBound?: boolean
  /** The mirror canvas (with its ref + event handlers) to place inside the frame. */
  children: ComponentChildren
}

export function DeviceFrame({ platform, formFactor, heightBound, children }: DeviceFrameProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  // Re-attempt the photographic frame when the device changes — a past load
  // failure (or a different platform/form factor) shouldn't stick forever.
  useLayoutEffect(() => {
    setImgFailed(false);
  }, [platform, formFactor]);

  const frame = imgFailed ? undefined : selectDeviceFrame({ platform, formFactor });
  const frameAspect = frame?.frameAspect;

  // Cap the frame width by (container height × aspect) so the whole device fits
  // vertically. clientHeight reflects the real rendered height regardless of CSS
  // definiteness, so this works where container-query height does not.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!heightBound || !frameAspect || !parent) return;
    const measure = () => {
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w > 0 && h > 0) setWidth(Math.min(w, h * frameAspect));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [heightBound, frameAspect]);

  if (frame) {
    const style: Record<string, string> = { '--dm-fa': String(frame.frameAspect) };
    if (heightBound && width) style.width = `${width.toFixed(2)}px`;
    return (
      <div ref={ref} class="dm-frame dm-frame-img" style={style}>
        <div class="dm-frame-screen" style={screenMaskStyle(frame)}>
          <div class="dm-frame-screen-rect" style={screenWindowStyle(frame)}>
            {children}
          </div>
        </div>
        <img
          class="dm-frame-png"
          src={frame.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={() => setImgFailed(true)}
        />
      </div>
    );
  }

  const classes = ['dm-frame'];
  if (platform) classes.push(`dm-skin-${platform}`, `dm-skin-${formFactor ?? 'phone'}`);
  return <div class={classes.join(' ')}>{children}</div>;
}
