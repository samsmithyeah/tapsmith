// MCP panel — the feed of tool calls made by agents sharing this session.

import type { Page } from "@playwright/test"

export class McpPane {
  constructor(private page: Page) {}

  get root() {
    return this.page.getByRole("region", { name: "MCP activity" })
  }

  get feed() {
    return this.page.getByRole("log", { name: "MCP activity feed" })
  }

  get entries() {
    return this.page.getByTestId("mcp-entry")
  }

  /**
   * An entry by the tool name as displayed — the panel strips the `tapsmith_`
   * prefix, so this is `tap`, not `tapsmith_tap`.
   */
  entry(tool: string) {
    return this.entries.filter({ hasText: tool })
  }

  get emptyState() {
    return this.page.getByTestId("mcp-empty")
  }

  /** One pill per connected agent. */
  get agents() {
    return this.page.getByTestId("mcp-agent")
  }

  /** Only rendered once the feed has something in it. */
  get clearButton() {
    return this.page.getByRole("button", { name: "Clear", exact: true })
  }

  /** Toggle in the top rail that opens and closes this panel. */
  get toggle() {
    return this.page.locator("button.rc-mcp-indicator")
  }

  // ─── Flows ───

  async open() {
    if ((await this.root.count()) === 0) await this.toggle.click()
  }

  async clear() {
    await this.clearButton.click()
  }
}
