// The Console tab lives in `trace-viewer/components/DetailTabs.tsx` and is
// shared with the standalone viewer, but the two apps load **separate,
// hand-duplicated** stylesheets. A rule added to `trace-viewer.css.ts` alone
// leaves the element unstyled here, and the trace-viewer project stays green —
// which is exactly how the timestamp column and its sortable headers shipped
// as native UA buttons in UI mode. These specs pin the UI-mode half.

import { test, expect } from "../fixtures.js"
import { GESTURES_FILE, idleSeed, singleFileTree } from "../messages/scenarios.js"
import { action, consoleEntry } from "../messages/trace.js"

const DOUBLE_TAP = "Gestures screen > double tap registers double tap gesture"
const TEST_NAME = "double tap registers double tap gesture"

test.describe("Console tab in UI mode", () => {
  test.beforeEach(async ({ ui, explorer }) => {
    ui.seed(idleSeed(singleFileTree()))
    await ui.open()
    await expect(explorer.nodes.first()).toBeVisible()

    ui.send({ type: "run-start", fileCount: 1 })
    ui.send({ type: "test-start", fullName: DOUBLE_TAP, filePath: GESTURES_FILE })
    for (const m of action({ testFullName: DOUBLE_TAP, actionIndex: 0, action: "tap" })) ui.send(m)
    // Offsets of deliberately different printed width: an unstyled time column
    // has no fixed width, so the columns after it drift row by row.
    ui.send(consoleEntry({ testFullName: DOUBLE_TAP, level: "info", message: "app started", offsetMs: 881 }))
    ui.send(consoleEntry({ testFullName: DOUBLE_TAP, level: "warn", message: "slow frame", offsetMs: 62_050 }))
    ui.send(consoleEntry({ testFullName: DOUBLE_TAP, level: "error", message: "network unreachable", offsetMs: 123_456 }))
    ui.send({ type: "test-status", fullName: DOUBLE_TAP, filePath: GESTURES_FILE, status: "passed", duration: 130_000 })
    ui.send({ type: "run-end", status: "passed", duration: 130_000, passed: 1, failed: 0, skipped: 0 })

    await explorer.expandAll()
    await explorer.clickNode(TEST_NAME)
  })

  test("timestamps offset from the first entry, since a live session has no test start time", async ({ detailTabs }) => {
    await detailTabs.select("Console")
    // `ui-mode/main.tsx` builds its metadata with `startTime: 0`, so ConsoleTab
    // takes its fallback base — the earliest entry, not the test start.
    await expect(detailTabs.consoleTimestamps).toHaveText(["+0.000s", "+61.169s", "+122.575s"])
  })

  test("the column headers are styled, not native buttons", async ({ detailTabs }) => {
    await detailTabs.select("Console")
    const header = detailTabs.consoleColumnHeader("Time")
    await expect(header).toBeVisible()
    // `all: unset` is what makes these read as headings rather than controls.
    expect(await header.evaluate((el) => getComputedStyle(el).appearance)).toBe("none")
    expect(await header.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("none")
    expect(await header.evaluate((el) => getComputedStyle(el).textTransform)).toBe("uppercase")
    expect(await header.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Mono")
  })

  test("the columns line up across rows of differing timestamp width", async ({ detailTabs, page }) => {
    await detailTabs.select("Console")
    await expect(detailTabs.consoleEntries).toHaveCount(3)
    const lefts = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-testid="log-entry"]')
      return Array.from(rows).map((r) =>
        Array.from(r.querySelectorAll("span")).map((c) => Math.round(c.getBoundingClientRect().left)),
      )
    })
    expect(lefts).toHaveLength(3)
    expect(lefts[1]).toEqual(lefts[0])
    expect(lefts[2]).toEqual(lefts[0])
  })

  test("sorting works here too", async ({ detailTabs }) => {
    await detailTabs.select("Console")
    await detailTabs.consoleColumnHeader("Level").click()
    await expect(detailTabs.consoleEntries).toHaveText([
      /network unreachable/, /slow frame/, /app started/,
    ])
  })
})
