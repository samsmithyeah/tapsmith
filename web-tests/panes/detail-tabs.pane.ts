// Detail tabs — the bottom pane's Call / Log / Console / Source / Hierarchy /
// Locator / Network / Errors strip, plus the simple tab bodies. Network,
// Hierarchy and Locator are big enough to have panes of their own.
//
// Rendered by `src/trace-viewer/components/DetailTabs.tsx`, which UI mode
// imports, so this pane serves both apps.

import type { Page } from "@playwright/test"

export type DetailTab =
  | "Call"
  | "Log"
  | "Console"
  | "Source"
  | "Hierarchy"
  | "Locator"
  | "Network"
  | "Errors"

export class DetailTabsPane {
  constructor(private page: Page) {}

  get tabList() {
    return this.page.getByRole("tablist", { name: "Trace details" })
  }

  /** Matched on the leading label — Network and Errors carry a count too. */
  tab(name: DetailTab) {
    return this.tabList.getByRole("tab", { name: new RegExp(`^${name}\\b`) })
  }

  async select(name: DetailTab) {
    await this.tab(name).click()
  }

  /** Shown by whichever tab has nothing to display. */
  get noContent() {
    return this.page.getByTestId("no-content")
  }

  // ─── Call ───
  //
  // A CSS grid of alternating label/value cells rather than rows, so assertions
  // read the grid's contents rather than addressing individual pairs.

  get callGrid() {
    return this.page.getByTestId("call-grid")
  }

  // ─── Console ───

  get consoleSearch() {
    return this.page.getByRole("textbox", { name: "Filter console output" })
  }

  get consoleOutput() {
    return this.page.getByRole("log", { name: "Console output" })
  }

  get consoleEntries() {
    return this.page.getByTestId("log-entry")
  }

  // ─── Source ───

  get sourceFilename() {
    return this.page.getByTestId("source-filename")
  }

  get sourceLines() {
    return this.page.getByTestId("source-line")
  }

  // ─── Errors ───

  get errorEntries() {
    return this.page.getByTestId("error-entry")
  }
}
