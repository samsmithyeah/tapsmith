// Device pane — the live screen mirror.
//
// Pick mode, worker views and mirror gestures are phase-2 surfaces; their
// locators go in alongside the specs that prove them, rather than sitting here
// unverified.

import type { Page } from "@playwright/test"

export class DevicePane {
  constructor(private page: Page) {}

  get root() {
    return this.page.getByRole("region", { name: "Live device mirror" })
  }

  get canvas() {
    return this.page.getByLabel("Device screen mirror", { exact: true })
  }

  /** Why there's no picture yet — "Waiting for device" / "Starting mirror…". */
  get mirrorStatus() {
    return this.page.getByTestId("mirror-status")
  }

  get mirrorStatusHint() {
    return this.page.getByTestId("mirror-status-hint")
  }
}
