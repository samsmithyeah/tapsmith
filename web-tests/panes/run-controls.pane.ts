// Top rail — result counts, elapsed timer, connection state, MCP toggle, theme.

import type { Page } from "@playwright/test"

export class RunControlsPane {
  constructor(private page: Page) {}

  get root() {
    return this.page.locator(".rail")
  }

  // ─── Counts and timing ───

  get counts() {
    return this.page.locator(".rc-counts")
  }

  get passedCount() {
    return this.page.locator(".rc-count.passed")
  }

  get failedCount() {
    return this.page.locator(".rc-count.failed")
  }

  get skippedCount() {
    return this.page.locator(".rc-count.skipped")
  }

  /** Only rendered while a run is in flight. */
  get elapsed() {
    return this.page.locator(".rc-elapsed")
  }

  // ─── Run failed ───

  /** Only rendered once at least one test has failed. */
  get rerunFailedButton() {
    return this.page.locator("button.rc-run-failed")
  }

  // ─── Connection ───

  /** One entry per device; the text is the serial, or Connected/Disconnected. */
  get devices() {
    return this.page.locator(".rc-device")
  }

  get disconnectedIndicator() {
    return this.page.locator(".rc-device", { hasText: "Disconnected" })
  }

  // ─── MCP and theme ───

  get mcpIndicator() {
    return this.page.locator("button.rc-mcp-indicator")
  }

  get mcpDot() {
    return this.mcpIndicator.locator(".mcp-dot")
  }

  get themeSelect() {
    return this.page.locator("select.rc-theme-select")
  }

  // ─── Flows ───

  async rerunFailed() {
    await this.rerunFailedButton.click()
  }

  async toggleMcpPanel() {
    await this.mcpIndicator.click()
  }

  async chooseTheme(theme: "system" | "light" | "dark") {
    await this.themeSelect.selectOption(theme)
  }

  /**
   * Fire a bare-key shortcut: `r` run-all, `f` run-failed, `Escape` stop,
   * `w` toggle-watch (see `keyboard-shortcuts.ts`). Pressed on `body` so no
   * input holds focus — the shortcuts are deliberately suppressed while typing.
   */
  async pressShortcut(key: "r" | "f" | "w" | "Escape") {
    await this.page.locator("body").press(key)
  }
}
