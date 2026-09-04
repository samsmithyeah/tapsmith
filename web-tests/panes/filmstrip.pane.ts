// Timeline filmstrip — one thumbnail per traced action, plus the test summary
// line above it.

import type { Page } from "@playwright/test"

export class FilmstripPane {
  constructor(private page: Page) {}

  get frames() {
    return this.page.getByTestId("film-frame")
  }

  /** Test name, breadcrumb, duration and device, as one line. */
  get summary() {
    return this.page.getByTestId("timeline-meta")
  }

  /** Offset label under each frame, e.g. "0ms", "1.2s". */
  get labels() {
    return this.page.getByTestId("film-label")
  }

  /** The numbered box a frame shows when no screenshot exists at or before its step. */
  get placeholders() {
    return this.frames.locator(".timeline-placeholder")
  }

  // ─── Multi-device lanes ───

  /** One row per device on a device-group trace; absent for a single device. */
  get lanes() {
    return this.page.getByTestId("film-lane")
  }

  get laneLabels() {
    return this.page.getByTestId("film-lane-label")
  }

  /** The frames a device's lane holds. */
  laneFrames(device: string) {
    return this.lanes.and(this.page.locator(`[data-device="${device}"]`)).getByTestId("film-frame")
  }

  // ─── Flows ───

  async selectFrame(index: number) {
    await this.frames.nth(index).click()
  }
}
