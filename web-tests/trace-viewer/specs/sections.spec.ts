// Section headers in the action list: lifecycle groups (BEFORE ALL, BEFORE
// EACH, TEST BODY, …) and the runner's APP RESET fixture section. Groups are
// flat headers, so the runner emits the reset as a sibling section *before*
// the hooks group; the panel hides sections that have nothing to show.

import { test, expect } from "../fixtures.js"
import { actionEvent, assertionEvent } from "../trace-builder.js"
import type { GroupTraceEvent } from "../../trace-types.js"

const BASE = 1_700_000_000_000
const group = (type: "group-start" | "group-end", name: string, at: number): GroupTraceEvent =>
  ({ type, name, actionIndex: 0, timestamp: BASE + at })

/** A per-file trace as the runner records it: reset → beforeAll hook → test. */
const FILE_TRACE = {
  events: [
    group("group-start", "App reset", 0),
    actionEvent({ actionIndex: 0, action: "resetApp" }),
    group("group-end", "App reset", 10),
    group("group-start", "beforeAll Hooks", 20),
    actionEvent({ actionIndex: 1, action: "openDeepLink" }),
    assertionEvent({ actionIndex: 2, assertion: "toBeVisible" }),
    group("group-end", "beforeAll Hooks", 30),
    group("group-start", "beforeEach Hooks", 40),
    group("group-end", "beforeEach Hooks", 41),
    group("group-start", "Test", 50),
    assertionEvent({ actionIndex: 3, assertion: "toHaveText" }),
    group("group-end", "Test", 60),
  ],
}

test.describe("Action list sections", () => {
  test("shows the app reset as its own section ahead of the hooks it precedes", async ({ viewer, actions }) => {
    await viewer.open(FILE_TRACE)

    await expect(actions.groups).toHaveText(["APP RESET", "BEFORE ALL", "TEST BODY"])
    // The hook's own actions sit under BEFORE ALL, not under the reset.
    const rows = actions.list.locator('[data-testid="action-group"], [data-testid="action-item"]')
    await expect(rows).toHaveText([
      /APP RESET/, /resetApp/,
      /BEFORE ALL/, /openDeepLink/, /toBeVisible/,
      /TEST BODY/, /toHaveText/,
    ])
  })

  test("hides a section that has nothing in it", async ({ viewer, actions }) => {
    await viewer.open(FILE_TRACE)
    // beforeEach Hooks is present in the trace but empty.
    await expect(actions.groups.filter({ hasText: "BEFORE EACH" })).toHaveCount(0)
  })

  test("hides a section whose every row the filter removes", async ({ viewer, actions, page }) => {
    await viewer.open(FILE_TRACE)

    await page.getByLabel("Filter actions").fill("toHaveText")
    await expect(actions.items).toHaveText([/toHaveText/])
    await expect(actions.groups).toHaveText(["TEST BODY"])

    await page.getByLabel("Filter actions").fill("")
    await expect(actions.groups).toHaveText(["APP RESET", "BEFORE ALL", "TEST BODY"])
  })

  test("keeps a section whose reset was satisfied by preparation (summary row only)", async ({ viewer, actions }) => {
    await viewer.open({
      events: [
        group("group-start", "App reset", 0),
        actionEvent({ actionIndex: 0, action: "appReset" }),
        group("group-end", "App reset", 10),
        group("group-start", "Test", 20),
        assertionEvent({ actionIndex: 1, assertion: "toBeVisible" }),
        group("group-end", "Test", 30),
      ],
    })
    await expect(actions.groups).toHaveText(["APP RESET", "TEST BODY"])
  })
})
