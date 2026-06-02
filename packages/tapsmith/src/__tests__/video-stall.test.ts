import { describe, it, expect } from 'vitest';
import { VideoStallWatch, VIDEO_STALL_MS, VIDEO_STARTUP_MS } from '../ui-mode/hooks/video-stall.js';

// A "stall" = a tile that WAS painting video and then froze on a stale frame
// while the server is still feeding it H.264 (input flowing, output stopped).
// A tile that simply hasn't produced its first frame yet is *starting up*, not
// stalled — it must not be killed (grid video can take a few seconds to paint
// its first frame), but a stream that never paints for a long time does fall
// back so a genuinely broken tile doesn't freeze forever.

describe('VideoStallWatch', () => {
  it('reports nothing when input and output stay in lockstep', () => {
    const w = new VideoStallWatch();
    for (let t = 0; t <= 10_000; t += 100) {
      w.markInput(1, t);
      w.markOutput(1, t);
    }
    expect(w.collectStalled(10_100, 2000)).toEqual([]);
  });

  it('does NOT flag a worker still producing its first frame (startup)', () => {
    const w = new VideoStallWatch();
    // Fed for 3s with no paint yet — multi-worker grid video can take a few
    // seconds to its first frame. Never kill a stream that's still starting.
    for (let t = 0; t <= 3000; t += 100) w.markInput(1, t);
    expect(w.collectStalled(3000, 2000)).toEqual([]);
  });

  it('falls back if a worker never paints within the long startup window', () => {
    const w = new VideoStallWatch();
    // Fed well past the startup grace with no paint → genuinely broken stream.
    for (let t = 0; t <= VIDEO_STARTUP_MS + 500; t += 250) w.markInput(1, t);
    expect(w.collectStalled(VIDEO_STARTUP_MS + 500)).toEqual([1]);
  });

  it('flags a worker that painted then froze while still being fed', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0); // painted once
    for (let t = 100; t <= 2600; t += 100) w.markInput(1, t); // fed, no more paints
    expect(w.collectStalled(2600, 2000)).toEqual([1]);
  });

  it('does NOT flag when the server stopped feeding (intentional stop)', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0);
    // No input after t=0 — server stopped; screenshots already took over.
    expect(w.collectStalled(10_000, 2000)).toEqual([]);
  });

  it('reports each stall only once until the worker paints again', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0);
    for (let t = 100; t <= 2600; t += 100) w.markInput(1, t);
    expect(w.collectStalled(2600, 2000)).toEqual([1]);
    // Still frozen, already reported — don't spam.
    w.markInput(1, 2700);
    expect(w.collectStalled(2800, 2000)).toEqual([]);
    // Paints again → recovered → eligible to be flagged on a future freeze.
    w.markOutput(1, 2900);
    for (let t = 3000; t <= 5200; t += 100) w.markInput(1, t);
    expect(w.collectStalled(5200, 2000)).toEqual([1]);
  });

  it('tracks workers independently', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0);
    w.markInput(2, 0);
    w.markOutput(2, 0);
    // Worker 1 freezes after painting; worker 2 keeps painting.
    for (let t = 100; t <= 2600; t += 100) {
      w.markInput(1, t);
      w.markInput(2, t);
      w.markOutput(2, t);
    }
    expect(w.collectStalled(2600, 2000)).toEqual([1]);
  });

  it('stops tracking a removed worker', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0);
    for (let t = 100; t <= 2600; t += 100) w.markInput(1, t);
    w.remove(1);
    expect(w.collectStalled(2600, 2000)).toEqual([]);
  });

  it('uses VIDEO_STALL_MS as the default freeze threshold', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0);
    for (let t = 100; t <= VIDEO_STALL_MS + 100; t += 100) w.markInput(1, t);
    expect(w.collectStalled(VIDEO_STALL_MS + 100)).toEqual([1]);
  });
});
