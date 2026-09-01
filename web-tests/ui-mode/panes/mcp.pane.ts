// Device activity panel — one feed of everything done to a device outside a
// traced test: MCP tool calls from agents sharing the session, background
// preparation, worker recycles, mirror gestures.

import type { Page } from "@playwright/test"

export class McpPane {
  constructor(private page: Page) {}

  get root() {
    return this.page.getByRole("region", { name: "Device activity" })
  }

  get feed() {
    return this.page.getByRole("log", { name: "Device activity feed" })
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

  /** Non-MCP entries: background preparation, recycles, mirror bursts. */
  get activityEntries() {
    return this.page.getByTestId("activity-entry")
  }

  activityOfKind(kind: "prepare" | "validate" | "recycle" | "mirror" | "respawn") {
    return this.activityEntries.and(this.page.locator(`[data-kind="${kind}"]`))
  }

  get emptyState() {
    return this.page.getByTestId("mcp-empty")
  }

  /** The connect-your-agent hint, pinned above the feed while no agent is attached. */
  get setupHint() {
    return this.page.getByTestId("mcp-setup-hint")
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
    return this.page.getByRole("button", { name: /device activity$/ })
  }

  // ─── Flows ───

  async open() {
    if ((await this.root.count()) === 0) await this.toggle.click()
  }

  async clear() {
    await this.clearButton.click()
  }
}
