import { describe, it, expect } from 'vitest';
import { VideoStallWatch, VIDEO_STALL_MS } from '../ui-mode/hooks/video-stall.js';

// A "stall" = the server is still feeding H.264 frames to a worker (input
// flowing) but the WebCodecs decoder has stopped painting (no output) for
// longer than the threshold. Detecting it lets the UI fall back to screenshots
// instead of sitting on a frozen frame.

describe('VideoStallWatch', () => {
  it('reports nothing when input and output stay in lockstep', () => {
    const w = new VideoStallWatch();
    for (let t = 0; t <= 10_000; t += 100) {
      w.markInput(1, t);
      w.markOutput(1, t);
    }
    expect(w.collectStalled(10_100, 2000)).toEqual([]);
  });

  it('does not flag during startup before the threshold elapses', () => {
    const w = new VideoStallWatch();
    // Fed since t=0 but no paint yet; only 500ms in — give the decoder time.
    w.markInput(1, 0);
    w.markInput(1, 500);
    expect(w.collectStalled(500, 2000)).toEqual([]);
  });

  it('flags a worker fed continuously but never painting', () => {
    const w = new VideoStallWatch();
    // Input keeps arriving, output never happens (decoder wedged on startup).
    for (let t = 0; t <= 2500; t += 100) w.markInput(1, t);
    expect(w.collectStalled(2500, 2000)).toEqual([1]);
  });

  it('flags a worker that painted then froze while still being fed', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0); // painted once
    // Keep feeding, but no more paints.
    for (let t = 100; t <= 2600; t += 100) w.markInput(1, t);
    expect(w.collectStalled(2600, 2000)).toEqual([1]);
  });

  it('does NOT flag when the server stopped feeding (intentional stop)', () => {
    const w = new VideoStallWatch();
    w.markInput(1, 0);
    w.markOutput(1, 0);
    // No more input after t=0 (server stopped). Far past the threshold, but
    // since we aren't being fed, this isn't a stall — screenshots already took
    // over server-side.
    expect(w.collectStalled(10_000, 2000)).toEqual([]);
  });

  it('reports each stall only once until the worker paints again', () => {
    const w = new VideoStallWatch();
    for (let t = 0; t <= 2500; t += 100) w.markInput(1, t);
    expect(w.collectStalled(2500, 2000)).toEqual([1]);
    // Still stalled, but already reported — don't spam.
    w.markInput(1, 2600);
    expect(w.collectStalled(2700, 2000)).toEqual([]);
    // It paints again → recovered → eligible to be flagged on a future stall.
    w.markOutput(1, 2800);
    for (let t = 2900; t <= 5200; t += 100) w.markInput(1, t);
    expect(w.collectStalled(5200, 2000)).toEqual([1]);
  });

  it('tracks workers independently', () => {
    const w = new VideoStallWatch();
    // Worker 1 stalls; worker 2 is healthy.
    for (let t = 0; t <= 2500; t += 100) {
      w.markInput(1, t);
      w.markInput(2, t);
      w.markOutput(2, t);
    }
    expect(w.collectStalled(2500, 2000)).toEqual([1]);
  });

  it('stops tracking a removed worker', () => {
    const w = new VideoStallWatch();
    for (let t = 0; t <= 2500; t += 100) w.markInput(1, t);
    w.remove(1);
    expect(w.collectStalled(2500, 2000)).toEqual([]);
  });

  it('uses VIDEO_STALL_MS as the default threshold', () => {
    const w = new VideoStallWatch();
    for (let t = 0; t <= VIDEO_STALL_MS + 100; t += 100) w.markInput(1, t);
    expect(w.collectStalled(VIDEO_STALL_MS + 100)).toEqual([1]);
  });
});
