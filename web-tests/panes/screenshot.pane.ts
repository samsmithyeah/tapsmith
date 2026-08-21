// Screenshot panel — the captured screen for the selected action, and its
// before/action/after stages.

import type { Page } from "@playwright/test"

export type ScreenshotStage = "Action" | "Before" | "After"

export class ScreenshotPane {
  constructor(private page: Page) {}

  /** The screenshot itself; its alt text names the stage being shown. */
  get image() {
    return this.page.getByRole("img", { name: /^Screenshot / })
  }

  get emptyState() {
    return this.page.getByTestId("screenshot-empty")
  }

  get stages() {
    return this.page.getByRole("tablist", { name: "Screenshot stage" })
  }

  stage(name: ScreenshotStage) {
    return this.stages.getByRole("tab", { name, exact: true })
  }

  /** The test name shown in the panel header. */
  get title() {
    return this.page.getByTestId("viewer-title")
  }

  // ─── Flows ───

  async selectStage(name: ScreenshotStage) {
    await this.stage(name).click()
  }
}
