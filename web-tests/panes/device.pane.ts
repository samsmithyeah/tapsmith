// Device pane — the live screen mirror and its toggles.

import type { Page } from "@playwright/test"

export class DevicePane {
  constructor(private page: Page) {}

  get root() {
    return this.page.getByRole("region", { name: "Live device mirror" })
  }

  // ─── Mirror ───

  get canvas() {
    return this.page.getByLabel("Device screen mirror", { exact: true })
  }

  /** One canvas per worker in the multi-device grid, named by worker. */
  mirrorFor(workerLabel: string) {
    return this.page.getByLabel(`Device screen mirror — ${workerLabel}`)
  }

  /** Live region shown until the first frame arrives. */
  get placeholder() {
    return this.root.getByRole("status")
  }

  // ─── Toggles ───

  get lockToggle() {
    return this.page.getByRole("button", { name: /^Interaction (locked|unlocked)/ })
  }

  get pickToggle() {
    return this.page.getByRole("button", { name: /^(Pick an element|Picking element)/ })
  }

  // ─── Worker tabs ───

  get workerTabs() {
    return this.page.getByRole("tablist", { name: "Device views" })
  }

  workerTab(label: string) {
    return this.workerTabs.getByRole("tab", { name: label })
  }

  // ─── Flows ───

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
