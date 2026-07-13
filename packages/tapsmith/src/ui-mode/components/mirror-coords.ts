/**
 * mirror-coords — coordinate mapping between the live device mirror's canvas
 * (CSS pixels) and the accessibility hierarchy's logical points.
 *
 * The canvas backing store always holds the last frame's native device pixels
 * (see use-screen-mirror.ts), so `canvas.width/height` are the frame dims.
 * Hierarchy bounds are logical points: device pixels ÷ dpr (iOS simulator
 * scale 2/3; Android dpr = 1, points = pixels) — the same convention as the
 * server's `normalizedToLogical`.
 */

import type { Bounds } from '../../trace-viewer/components/hierarchy-utils.js';

export interface CssRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Map a mouse position to hierarchy logical points: CSS px within the canvas
 * rect → fraction (clamped 0–1) → device pixels → ÷ dpr → logical points.
 * Returns null when the canvas has no laid-out size or no frame yet.
 */
export function mirrorPointToLogical(
  clientX: number,
  clientY: number,
  rect: CssRect,
  frameWidth: number,
  frameHeight: number,
  dpr: number,
): { x: number; y: number } | null {
  if (rect.width === 0 || rect.height === 0 || frameWidth === 0 || frameHeight === 0 || dpr === 0) {
    return null;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const nx = clamp((clientX - rect.left) / rect.width);
  const ny = clamp((clientY - rect.top) / rect.height);
  return {
    x: (nx * frameWidth) / dpr,
    y: (ny * frameHeight) / dpr,
  };
}

/**
 * Inverse of `mirrorPointToLogical` for drawing overlays: logical-point bounds
 * → device pixels (× dpr) → CSS px within the canvas box.
 */
export function logicalBoundsToMirrorCss(
  bounds: Bounds,
  canvasCssWidth: number,
  canvasCssHeight: number,
  frameWidth: number,
  frameHeight: number,
  dpr: number,
): CssRect {
  if (frameWidth === 0 || frameHeight === 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scaleX = (canvasCssWidth / frameWidth) * dpr;
  const scaleY = (canvasCssHeight / frameHeight) * dpr;
  return {
    left: bounds.left * scaleX,
    top: bounds.top * scaleY,
    width: (bounds.right - bounds.left) * scaleX,
    height: (bounds.bottom - bounds.top) * scaleY,
  };
}
