/**
 * Open known-bug placeholders. Each entry stays as a `.skip` test so the
 * issue ID remains visible in test output and `grep`-able in CI; flip to
 * `test()` once the underlying behavior is implemented and the assertion
 * makes sense as a real regression check.
 *
 * Bugs that have been fixed already live in `selector-regressions.test.ts`.
 */
import { describe, expect, test } from "pilot"

describe("Known bugs (open)", () => {
  // ─── PILOT-134: cross-file isolation ───
  // Tests across different files share installed-app state in some configs.
  // Not testable in a single file — exists here as a tracker so the bug
  // doesn't disappear from the suite.
  test.skip("PILOT-134: cross-file test isolation", () => {
    // Intentional placeholder; see https://linear.app/.../PILOT-134
    expect(true).toBe(true)
  })

  // ─── PILOT-135: tap() should auto-scroll off-screen targets ───
  // Today users have to call `scrollIntoView()` explicitly; Playwright
  // auto-scrolls on actionable operations like tap.
  test.skip("PILOT-135: tap() should auto-scroll to off-screen elements", () => {
    expect(true).toBe(true)
  })

  // ─── PILOT-149: not.toBeVisible() polling ───
  // Already fixed in expect.ts (poll() supports negated mode), but the
  // tracker stays so future regressions of negated-assertion polling are
  // easy to find.
  test.skip("PILOT-149: not.toBeVisible() should poll until element disappears", () => {
    expect(true).toBe(true)
  })
})
