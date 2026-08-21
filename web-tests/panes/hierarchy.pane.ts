// Hierarchy tab — the captured view tree and its property sheet.

import type { Page } from "@playwright/test"

export class HierarchyPane {
  constructor(private page: Page) {}

  get tree() {
    return this.page.getByRole("tree", { name: "View hierarchy" })
  }

  get search() {
    return this.page.getByRole("textbox", { name: "Search hierarchy" })
  }

  get rows() {
    return this.page.getByTestId("hierarchy-row")
  }

  /**
   * A row by the text it shows. Note what that is: the row's own label is the
   * XML element name, which for a UIAutomator capture is `node` for every
   * element — the identifying information is in the inline attributes it prints
   * alongside (`text=`, `id=`, `desc=`), so match on those.
   */
  row(text: string) {
    return this.rows.filter({ hasText: text })
  }

  get selectedRow() {
    return this.rows.and(this.page.locator('[aria-selected="true"]'))
  }

  /** Rows highlighted by the search box — matches are marked, not filtered. */
  get searchMatches() {
    return this.rows.and(this.page.locator(".ht-search-match"))
  }

  /** Property sheet for the selected node. */
  get properties() {
    return this.page.getByTestId("hierarchy-properties")
  }

  // ─── Flows ───

  async selectRow(name: string) {
    await this.row(name).first().click()
  }

  async searchFor(text: string) {
    await this.search.fill(text)
  }
}
