import { describe, it, expect } from 'vitest';
import { classifyGesture, normalizePoint, TAP_MOVE_THRESHOLD, LONG_PRESS_MS } from '../ui-mode/hooks/use-device-interaction.js';

describe('classifyGesture', () => {
  it('small move + short hold = tap', () => {
    expect(classifyGesture({ dx: 2, dy: 2, durationMs: 100 })).toBe('tap');
  });
  it('small move + long hold = long-press', () => {
    expect(classifyGesture({ dx: 1, dy: 1, durationMs: LONG_PRESS_MS + 50 })).toBe('long-press');
  });
  it('large move = swipe regardless of duration', () => {
    expect(classifyGesture({ dx: TAP_MOVE_THRESHOLD + 5, dy: 0, durationMs: 50 })).toBe('swipe');
    expect(classifyGesture({ dx: 0, dy: TAP_MOVE_THRESHOLD + 5, durationMs: 2000 })).toBe('swipe');
  });
});

describe('normalizePoint', () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 } as DOMRect;
  it('maps cursor inside rect to 0–1', () => {
    expect(normalizePoint(200, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
  });
  it('clamps outside-rect cursors to [0,1]', () => {
    expect(normalizePoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizePoint(1000, 1000, rect)).toEqual({ x: 1, y: 1 });
  });
});
