// Top rail — result counts, elapsed timer, connection state.

import type { Page } from "@playwright/test"

export class RunControlsPane {
  constructor(private page: Page) {}

  // ─── Counts ───
  //
  // Each count renders its own sentence ("1 passed"), so the visible text is
  // both the clearest locator and what the user actually reads.

  get passedCount() {
    return this.page.getByText(/^\d+ passed$/)
  }

  get failedCount() {
    return this.page.getByText(/^\d+ failed$/)
  }

  get skippedCount() {
    return this.page.getByText(/^\d+ skipped$/)
  }

  /** Only rendered while a run is in flight. */
  get elapsed() {
    return this.page.getByRole("timer", { name: "Elapsed run time" })
  }

  // ─── Run failed ───

  /** Only rendered once at least one test has failed. */
  get rerunFailedButton() {
    return this.page.getByRole("button", { name: /Rerun Failed/ })
  }

  // ─── Connection ───

  /** Live region holding the device serial, or Connected/Disconnected. */
  get connection() {
    return this.page.getByRole("status", { name: "Device connection" })
  }

  get disconnectedIndicator() {
    return this.connection.getByText("Disconnected")
  }

  // ─── Notifications ───
  //
  // The banner sits in the app chrome just below this rail. Deliberately located
  // by role and text rather than by an aria-label: naming a live region would
  // make assistive tech announce the label instead of the message.

  /** Server errors — an assertive live region. */
  get errorBanner() {
    return this.page.getByRole("alert")
  }

  /** Run notices such as "Run stopped" — a polite live region. */
  notification(text: string | RegExp) {
    return this.page.getByRole("status").filter({ hasText: text })
  }

  // ─── Flows ───

  async rerunFailed() {
    await this.rerunFailedButton.click()
  }

  /**
   * Fire a bare-key shortcut: `r` run-all, `f` run-failed, `Escape` stop,
   * `w` toggle-watch (see `keyboard-shortcuts.ts`). Pressed on `body` so no
   * input holds focus — the shortcuts are deliberately suppressed while typing.
   */
  async pressShortcut(key: string) {
    await this.page.locator("body").press(key)
  }
}
