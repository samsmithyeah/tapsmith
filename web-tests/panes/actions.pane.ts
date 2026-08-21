// Actions panel — the per-test action list, its Metadata tab, and the
// run-progress indicator. Shared with the standalone trace viewer
// (`src/trace-viewer/components/ActionsPanel.tsx`).

import type { Page } from "@playwright/test"

export class ActionsPane {
  constructor(private page: Page) {}

  get root() {
    return this.page.locator(".actions-panel")
  }

  /** One row per traced action or assertion. */
  get items() {
    return this.page.locator(".action-item")
  }

  item(name: string) {
    return this.items.filter({ hasText: name })
  }

  get selectedItem() {
    return this.page.locator(".action-item.selected")
  }

  /** Rows still awaiting their `lifecycle: "completed"` event. */
  get inProgressItems() {
    return this.page.locator(".action-item.in-progress")
  }

  get failedItems() {
    return this.page.locator(".action-item.failed")
  }

  // ─── Header tabs ───

  get actionsTab() {
    return this.page.locator("button.actions-header-tab", { hasText: "Actions" })
  }

  get metadataTab() {
    return this.page.locator("button.actions-header-tab", { hasText: "Metadata" })
  }

  // ─── Metadata ───

  get metadataPanel() {
    return this.page.locator(".metadata-panel")
  }

  /** The value cell next to a metadata label, e.g. "Device" or "Status". */
  metadataValue(label: string) {
    return this.page
      .locator(".metadata-grid > *")
      .filter({ hasText: new RegExp(`^${label}$`) })
      .locator("xpath=following-sibling::*[1]")
  }

  // ─── Flows ───

  async selectAction(name: string) {
    await this.item(name).first().click()
  }

  async showMetadata() {
    await this.metadataTab.click()
  }

  async showActions() {
    await this.actionsTab.click()
  }
}
