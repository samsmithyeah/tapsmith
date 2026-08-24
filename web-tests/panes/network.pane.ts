// Network tab — the request list and its detail pane.
//
// The list is a real <table>, so rows and cells are addressable by their native
// roles with no extra hooks.

import type { Page } from "@playwright/test"

export type NetworkDetailTab = "Headers" | "Payload" | "Response" | "Timing"

export class NetworkPane {
  constructor(private page: Page) {}

  get table() {
    return this.page.getByRole("table")
  }

  get search() {
    return this.page.getByRole("textbox", { name: "Filter network requests" })
  }

  /** Data rows only — `tbody` excludes the header row. */
  get rows() {
    return this.table.locator("tbody").getByRole("row")
  }

  /** A row by the request name shown in its first cell. */
  row(name: string) {
    return this.rows.filter({ hasText: name })
  }

  /** A filter pill; whether it is on is reported by `aria-pressed`. */
  pill(label: string) {
    return this.page.getByRole("button", { name: label, exact: true })
  }

  get columnHeaders() {
    return this.table.getByRole("columnheader")
  }

  // ─── Detail pane ───

  detailTab(name: NetworkDetailTab) {
    return this.page.getByRole("button", { name, exact: true })
  }

  get detailBody() {
    return this.page.getByTestId("net-detail-body")
  }

  get detailClose() {
    return this.page.getByRole("button", { name: "Close", exact: true })
  }

  // ─── Flows ───

  async selectRow(name: string) {
    await this.row(name).click()
  }

  async openDetailTab(name: NetworkDetailTab) {
    await this.detailTab(name).click()
  }

  async filter(text: string) {
    await this.search.fill(text)
  }
}
