// Device pane — the live screen mirror, its lock/pick toggles, and worker tabs.

import type { Page } from "@playwright/test"

export class DevicePane {
  constructor(private page: Page) {}

  get root() {
    return this.page.locator(".device-col")
  }

  get title() {
    return this.page.locator(".device-head-title")
  }

  // ─── Mirror ───

  get canvas() {
    return this.page.getByLabel("Device screen mirror")
  }

  /** Shown until the first frame arrives. */
  get placeholder() {
    return this.page.locator(".dm-placeholder-text")
  }

  get placeholderHint() {
    return this.page.locator(".dm-placeholder-hint")
  }

  /** One canvas per worker in the multi-device grid. */
  get gridCanvases() {
    return this.page.locator(".device-pane-grid canvas")
  }

  // ─── Toggles ───

  get lockToggle() {
    return this.page.locator("button.mirror-lock-toggle")
  }

  get pickToggle() {
    return this.page.locator("button.mirror-pick-toggle")
  }

  // ─── Worker tabs ───

  get workerTabs() {
    return this.page.getByRole("tablist", { name: "Device views" })
  }

  workerTab(label: string) {
    return this.workerTabs.getByRole("tab", { name: label })
  }

  get allWorkersTab() {
    return this.workerTab("All")
  }

  // ─── Flows ───

  async unlockInteraction() {
    if ((await this.lockToggle.getAttribute("class"))?.includes("locked")) {
      await this.lockToggle.click()
    }
  }

  async enablePickMode() {
    await this.pickToggle.click()
  }

  async selectWorkerView(label: string) {
    await this.workerTab(label).click()
  }

  /**
   * Click the mirror at a fractional position of its box, matching how the SPA
   * normalises pointer coordinates to 0–1 before sending a mirror command.
   */
  async tapMirrorAt(fractionX: number, fractionY: number) {
    const box = await this.canvas.boundingBox()
    if (!box) throw new Error("Device mirror canvas is not visible")
    await this.page.mouse.click(
      box.x + box.width * fractionX,
      box.y + box.height * fractionY,
    )
  }
}
