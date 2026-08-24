// The Hierarchy tab and the Locator playground it feeds.
//
// Both are shared with UI mode, where the same components back pick mode on the
// live device mirror.

import { test, expect } from "../fixtures.js"
import { actionEvent, hierarchyXml } from "../trace-builder.js"

const HIERARCHY = hierarchyXml([
  { class: "android.widget.TextView", text: "Gesture Testing", bounds: "[40,120][600,180]" },
  {
    class: "android.widget.Button",
    text: "Tap area",
    desc: "Tap area",
    id: "dev.tapsmith.testapp:id/tap-area",
    bounds: "[40,220][1040,520]",
  },
  {
    class: "android.widget.TextView",
    text: "Last gesture: None",
    id: "dev.tapsmith.testapp:id/last-gesture",
    bounds: "[40,560][1040,620]",
  },
])

/** Two identical rows, so an ambiguous selector is deterministic. */
const AMBIGUOUS_HIERARCHY = hierarchyXml([
  { class: "android.widget.Button", text: "Delete", desc: "Delete", bounds: "[40,220][500,300]" },
  { class: "android.widget.Button", text: "Delete", desc: "Delete", bounds: "[540,220][1000,300]" },
])

function traceWith(xml: string) {
  return {
    events: [
      actionEvent({
        actionIndex: 0,
        action: "doubleTap",
        selector: 'getByRole("button", { name: "Tap area" })',
        hierarchies: { before: true, after: true },
      }),
    ],
    hierarchies: {
      "hierarchy/action-000-before.xml": xml,
      "hierarchy/action-000-after.xml": xml,
    },
  }
}

const SPEC = traceWith(HIERARCHY)

test.describe("Hierarchy tab", () => {
  test("renders the captured view tree", async ({ viewer, detailTabs, hierarchy }) => {
    await viewer.open(SPEC)
    await detailTabs.select("Hierarchy")

    await expect(hierarchy.tree).toBeVisible()
    await expect(hierarchy.row("Tap area")).toBeVisible()
    // The archive's own <hierarchy> element is the root, then the FrameLayout,
    // then its three children.
    await expect(hierarchy.rows).toHaveCount(5)
  })

  test("reports depth through aria-level", async ({ viewer, detailTabs, hierarchy }) => {
    await viewer.open(SPEC)
    await detailTabs.select("Hierarchy")

    // Level 1 is the archive's own <hierarchy> element, 2 the root layout, 3
    // its children.
    await expect(hierarchy.rows.first()).toHaveAttribute("aria-level", "1")
    await expect(hierarchy.rows.nth(1)).toHaveAttribute("aria-level", "2")
    await expect(hierarchy.row("Tap area")).toHaveAttribute("aria-level", "3")
  })

  test("selects a node and shows its properties", async ({ viewer, detailTabs, hierarchy }) => {
    await viewer.open(SPEC)
    await detailTabs.select("Hierarchy")

    await hierarchy.selectRow("Tap area")
    await expect(hierarchy.selectedRow).toHaveCount(1)
    // The property sheet is the point of selecting a node.
    await expect(hierarchy.properties).toBeVisible()
    await expect(hierarchy.properties).toContainText("tap-area")
  })

  test("narrows the tree to matches and their ancestors", async ({
    viewer,
    detailTabs,
    hierarchy,
  }) => {
    await viewer.open(SPEC)
    await detailTabs.select("Hierarchy")
    await expect(hierarchy.rows).toHaveCount(5)

    await hierarchy.searchFor("last-gesture")
    // The match is highlighted, and its ancestors stay so it keeps its place in
    // the tree — here the <hierarchy> root and the layout above it.
    await expect(hierarchy.searchMatches).toHaveCount(1)
    await expect(hierarchy.rows).toHaveCount(3)

    await hierarchy.searchFor("")
    await expect(hierarchy.rows).toHaveCount(5)
  })

  test("says so when no hierarchy was captured", async ({ viewer, detailTabs }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.select("Hierarchy")
    await expect(detailTabs.noContent).toBeVisible()
  })
})

test.describe("Locator playground", () => {
  test("counts matches for a typed selector", async ({ viewer, detailTabs, locator }) => {
    await viewer.open(SPEC)
    await detailTabs.select("Locator")

    await locator.type('device.getByText("Gesture Testing")')
    await expect(locator.matchCount).toHaveText("1 match")
  })

  test("reports a selector that matches nothing", async ({ viewer, detailTabs, locator }) => {
    await viewer.open(SPEC)
    await detailTabs.select("Locator")

    await locator.type('device.getByText("Nothing here")')
    await expect(locator.matchCount).toHaveText("0 matches")
  })

  test("counts every match of an ambiguous selector", async ({ viewer, detailTabs, locator }) => {
    await viewer.open(traceWith(AMBIGUOUS_HIERARCHY))
    await detailTabs.select("Locator")

    await locator.type('device.getByText("Delete")')
    await expect(locator.matchCount).toHaveText("2 matches")
  })

  test("warns when an ambiguous selector has no positional chain", async ({
    viewer,
    detailTabs,
    locator,
  }) => {
    await viewer.open(traceWith(AMBIGUOUS_HIERARCHY))
    await detailTabs.select("Locator")

    // Without .first() this throws a strict-mode violation at runtime, so
    // warning here — where the selector is being composed — is the point
    // (PILOT-226).
    await locator.type('device.getByText("Delete")')
    await expect(locator.strictWarning).toBeVisible()
  })

  test("drops the warning once disambiguated", async ({ viewer, detailTabs, locator }) => {
    await viewer.open(traceWith(AMBIGUOUS_HIERARCHY))
    await detailTabs.select("Locator")

    await locator.type('device.getByText("Delete")')
    await expect(locator.strictWarning).toBeVisible()

    await locator.type('device.getByText("Delete").first()')
    await expect(locator.strictWarning).toHaveCount(0)
  })
})
