/**
 * VideoStallWatch — detects a frozen live-video tile so the UI can fall back to
 * screenshots promptly.
 *
 * The H.264 mirror pauses screenshot polling while a worker streams video, and
 * the server only resumes polling on an explicit stop or a gRPC stream error —
 * NOT when the client-side WebCodecs decoder silently stalls (a decode error
 * resets the decoder, which then can't paint again until the next config+
 * keyframe). That leaves the tile frozen on a stale frame, with input still
 * working but invisible, until the server-side stream independently cycles.
 *
 * This watch closes that gap. A stall is "still being fed by the server (input
 * flowing) but not painting (no decoder output) for longer than the threshold".
 * Keying off *input* means an intentional stop (server stops feeding) is not
 * mistaken for a stall, and a brief startup gap before the first paint doesn't
 * false-trigger. Timestamps are injected so the logic is unit-testable.
 */

/** Default no-paint-while-fed window before a tile is considered stalled (ms). */
export const VIDEO_STALL_MS = 2000;

export class VideoStallWatch {
  /** First time we saw input for a worker (cleared on remove). */
  private firstInput = new Map<number, number>();
  /** Most recent server frame received for a worker. */
  private lastInput = new Map<number, number>();
  /** Most recent decoded+painted frame for a worker. */
  private lastOutput = new Map<number, number>();
  /** Workers already reported stalled, so each stall fires once. */
  private reported = new Set<number>();

  /** A frame arrived from the server for `id` (we are being fed). */
  markInput(id: number, now: number): void {
    if (!this.firstInput.has(id)) this.firstInput.set(id, now);
    this.lastInput.set(id, now);
  }

  /** A frame was decoded and painted for `id` (the tile is live). */
  markOutput(id: number, now: number): void {
    this.lastOutput.set(id, now);
    this.reported.delete(id);
  }

  /** Forget `id` entirely (tile unregistered). */
  remove(id: number): void {
    this.firstInput.delete(id);
    this.lastInput.delete(id);
    this.lastOutput.delete(id);
    this.reported.delete(id);
  }

  /**
   * Workers currently fed (input within `stallMs`) but not painting (no output
   * for more than `stallMs`, and fed for at least `stallMs` so startup isn't
   * flagged). Each is reported once until it paints again.
   */
  collectStalled(now: number, stallMs: number = VIDEO_STALL_MS): number[] {
    const stalled: number[] = [];
    for (const [id, lastIn] of this.lastInput) {
      if (this.reported.has(id)) continue;
      if (now - lastIn > stallMs) continue; // not actively fed → server stopped
      const firstIn = this.firstInput.get(id) ?? now;
      if (now - firstIn <= stallMs) continue; // give the decoder startup time
      const outTs = this.lastOutput.get(id);
      if (outTs === undefined || now - outTs > stallMs) {
        this.reported.add(id);
        stalled.push(id);
      }
    }
    return stalled;
  }
}
