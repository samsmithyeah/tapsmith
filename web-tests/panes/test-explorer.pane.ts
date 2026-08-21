// Test Explorer pane — the tree, its toolbar, and its filters.
//
// Follows the screen-object guidelines in docs/writing-tests.md: getters (never
// constructor assignments) so each access yields a fresh lazy locator,
// multi-step flows as methods, and no assertions — specs decide what to assert.
//
// Locators are role- and text-based. Where a surface had no accessible name, the
// fix was to give it the ARIA it should already have had rather than to reach for
// a CSS class from `styles/ui-mode.css.ts` — those are styling hooks and only
// incidentally stable. `getByTestId` is the deliberate fallback for the few bits
// carrying no semantics at all.

import type { Locator, Page } from "@playwright/test"

type NodeStatus = "idle" | "running" | "passed" | "failed" | "skipped"
type NodeType = "project" | "file" | "suite" | "test"
type StatusFilter = "All" | "Pass" | "Fail" | "Skip"

export class TestExplorerPane {
  constructor(private page: Page) {}

  // ─── Search and status filters ───

  get searchInput() {
    return this.page.getByRole("textbox", { name: "Filter tests" })
  }

  get statusFilters() {
    return this.page.getByRole("tablist", { name: "Filter by status" })
  }

  /**
   * One of the All / Pass / Fail / Skip filters. Its accessible name carries the
   * count too ("Pass 1"), so it's matched on the leading label.
   */
  statusFilter(label: StatusFilter) {
    return this.statusFilters.getByRole("tab", { name: new RegExp(`^${label}\\b`) })
  }

  // ─── Toolbar ───

  get runAllButton() {
    return this.page.getByRole("button", { name: "Run all tests" })
  }

  get stopButton() {
    return this.page.getByRole("button", { name: "Stop current run" })
  }

  get watchAllButton() {
    return this.page.getByRole("button", { name: "Watch all files for changes" })
  }

  get expandAllButton() {
    return this.page.getByRole("button", { name: "Expand all" })
  }

  get collapseAllButton() {
    return this.page.getByRole("button", { name: "Collapse all" })
  }

  // ─── Tree ───

  get tree() {
    return this.page.getByRole("tree", { name: "Tests" })
  }

  get emptyState() {
    return this.page.getByText("No tests found")
  }

  /** Every rendered tree row, in document order. */
  get nodes() {
    return this.page.getByRole("treeitem")
  }

  /**
   * A tree row by its visible name — its last path segment, or `[name]` for a
   * project. Exact, so "smoke" doesn't also match "smoke test".
   */
  node(name: string): Locator {
    return this.page.getByRole("treeitem", { name, exact: true })
  }

  // `data-type` and `data-status` have no ARIA equivalent — there is no role or
  // state for "this test failed" — and they are pre-existing product
  // attributes rather than styling hooks. Refining the role keeps the accessible
  // locator primary.

  nodesOfType(type: NodeType) {
    return this.nodes.and(this.page.locator(`[data-type="${type}"]`))
  }

  nodesOfTypeWithStatus(type: NodeType, status: NodeStatus) {
    return this.nodes.and(this.page.locator(`[data-type="${type}"][data-status="${status}"]`))
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

  /** A formatted duration is a bare number with no role of its own. */
  durationFor(name: string) {
    return this.node(name).getByTestId("node-duration")
  }

  /** The "depends on" badge on a project row, named by its tooltip. */
  dependenciesFor(name: string) {
    return this.node(name).getByTitle(/^Depends on:/)
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

  async filterByStatus(label: StatusFilter) {
    await this.statusFilter(label).click()
  }

  async expandAll() {
    await this.expandAllButton.click()
  }

  async collapseAll() {
    await this.collapseAllButton.click()
  }
}
