// Test Explorer pane — the tree, its toolbar, and its filters.
//
// Follows the screen-object guidelines in docs/writing-tests.md: getters (never
// constructor assignments) so each access yields a fresh lazy locator,
// multi-step flows as methods, and no assertions — specs decide what to assert.

import type { Locator, Page } from "@playwright/test"

type NodeStatus = "idle" | "running" | "passed" | "failed" | "skipped"

export class TestExplorerPane {
  constructor(private page: Page) {}

  // ─── Container ───

  get root() {
    return this.page.locator(".test-explorer")
  }

  get tree() {
    return this.page.getByRole("tree", { name: "Tests" })
  }

  get emptyState() {
    return this.page.locator(".te-empty")
  }

  // ─── Search and status filters ───

  get searchInput() {
    return this.page.locator("input.te-search")
  }

  /** One of the All / Pass / Fail / Skip filter buttons. */
  statusFilter(label: "All" | "Pass" | "Fail" | "Skip") {
    return this.page.locator(".te-status-filters button", {
      has: this.page.locator(`text="${label}"`),
    })
  }

  /** The count badge inside a status filter, e.g. "3" on Pass. */
  statusFilterCount(label: "All" | "Pass" | "Fail" | "Skip") {
    return this.statusFilter(label).locator(".te-count")
  }

  // ─── Toolbar ───

  get runAllButton() {
    return this.page.getByTitle("Run all tests")
  }

  get stopButton() {
    return this.page.getByTitle("Stop current run")
  }

  /** The stop button once a stop is in flight — its title changes. */
  get stoppingButton() {
    return this.page.getByTitle("Stopping…")
  }

  get watchAllButton() {
    return this.page.getByTitle("Watch all files for changes")
  }

  get disableWatchButton() {
    return this.page.getByTitle("Disable watch mode")
  }

  get expandAllButton() {
    return this.page.getByTitle("Expand all")
  }

  get collapseAllButton() {
    return this.page.getByTitle("Collapse all")
  }

  // ─── Tree nodes ───

  /** Every rendered tree row, in document order. */
  get nodes() {
    return this.page.getByRole("treeitem")
  }

  /**
   * A tree row by its visible name — its last path segment, or `[name]` for a
   * project. `exact` because "smoke" must not also match "smoke test".
   */
  node(name: string): Locator {
    return this.page.getByRole("treeitem", { name, exact: true })
  }

  /** Rows of one kind — handy for asserting structure. */
  nodesOfType(type: "project" | "file" | "suite" | "test") {
    return this.page.locator(`.te-node[data-type="${type}"]`)
  }

  /** Rows currently showing a given status. */
  nodesWithStatus(status: NodeStatus) {
    return this.page.locator(`.te-node[data-status="${status}"]`)
  }

  /** Rows of one kind showing a given status — e.g. only the leaf tests. */
  nodesOfTypeWithStatus(type: "project" | "file" | "suite" | "test", status: NodeStatus) {
    return this.page.locator(`.te-node[data-type="${type}"][data-status="${status}"]`)
  }

  // Each row holds exactly one run and one watch button, so a name prefix is
  // unambiguous once scoped to the row — and it keeps these from restating how
  // the label is derived.

  runButtonFor(name: string) {
    return this.node(name).getByRole("button", { name: /^Run / })
  }

  watchButtonFor(name: string) {
    return this.node(name).getByRole("button", { name: /^Watch / })
  }

  durationFor(name: string) {
    return this.node(name).locator(".te-duration")
  }

  // ─── Flows ───

  /** Click a row, which both selects it and toggles it if it has children. */
  async clickNode(name: string) {
    await this.node(name).click()
  }

  /** Hover the row (its actions only appear on hover) and hit its play button. */
  async runNode(name: string) {
    await this.node(name).hover()
    await this.runButtonFor(name).click()
  }

  async toggleWatchOn(name: string) {
    await this.node(name).hover()
    await this.watchButtonFor(name).click()
  }

  async filterByName(text: string) {
    await this.searchInput.fill(text)
  }

  async clearNameFilter() {
    await this.searchInput.fill("")
  }

  async filterByStatus(label: "All" | "Pass" | "Fail" | "Skip") {
    await this.statusFilter(label).click()
  }

  async expandAll() {
    await this.expandAllButton.click()
  }

  async collapseAll() {
    await this.collapseAllButton.click()
  }

  /** Expand every ancestor needed to reveal a descendant row. */
  async reveal(...names: string[]) {
    for (const name of names) {
      const node = this.node(name)
      if ((await node.getAttribute("aria-expanded")) === "false") {
        await node.click()
      }
    }
  }
}
