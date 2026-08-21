// Actions panel — the per-test action list. Shared with the standalone trace
// viewer (`src/trace-viewer/components/ActionsPanel.tsx`).

import type { Page } from "@playwright/test"

export class ActionsPane {
  constructor(private page: Page) {}

  get list() {
    return this.page.getByRole("listbox", { name: "Actions" })
  }

  /** One row per traced action or assertion. */
  get items() {
    return this.list.getByRole("option")
  }

  item(name: string) {
    return this.items.filter({ hasText: name })
  }

  get selectedItem() {
    return this.items.and(this.page.locator('[aria-selected="true"]'))
  }

  /** Rows still awaiting their `lifecycle: "completed"` event. */
  get inProgressItems() {
    return this.items.and(this.page.locator('[aria-busy="true"]'))
  }

  // ─── Flows ───

  async selectAction(name: string) {
    await this.item(name).first().click()
  }
}
