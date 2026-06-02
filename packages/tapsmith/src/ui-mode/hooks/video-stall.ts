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

/** A tile that painted before but hasn't repainted for this long (while still
 * fed) is frozen on a stale frame — the real stall case. */
export const VIDEO_STALL_MS = 2000;

/** A tile that has NEVER painted is still starting up; only fall back after
 * this much continuous feeding with no first frame (a genuinely broken stream).
 * Generous because multi-worker grid video can take seconds to its first frame. */
export const VIDEO_STARTUP_MS = 10_000;

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
   * Workers to fall back to screenshots for. Two cases, both requiring that the
   * server is still actively feeding the worker (input within `stallMs`):
   *   - painted before but frozen: no output for more than `stallMs`;
   *   - never painted: still being fed after more than `startupMs` (broken stream).
   * A worker that simply hasn't produced its first frame yet (within `startupMs`)
   * is NOT flagged — it's starting up. Each is reported once until it paints again.
   */
  collectStalled(
    now: number,
    stallMs: number = VIDEO_STALL_MS,
    startupMs: number = VIDEO_STARTUP_MS,
  ): number[] {
    const stalled: number[] = [];
    for (const [id, lastIn] of this.lastInput) {
      if (this.reported.has(id)) continue;
      if (now - lastIn > stallMs) continue; // not actively fed → server stopped
      const outTs = this.lastOutput.get(id);
      if (outTs === undefined) {
        // Never painted: only fall back once startup has dragged on far past a
        // normal first-frame delay, so a slow-starting tile isn't killed.
        const firstIn = this.firstInput.get(id) ?? now;
        if (now - firstIn > startupMs) {
          this.reported.add(id);
          stalled.push(id);
        }
      } else if (now - outTs > stallMs) {
        // Painted before, then froze while still fed — the real stall case.
        this.reported.add(id);
        stalled.push(id);
      }
    }
    return stalled;
  }
}
