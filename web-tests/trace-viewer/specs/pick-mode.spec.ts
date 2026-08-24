// Pick mode: click an element on the captured screenshot and get a locator for
// it. The same components back pick mode on UI mode's live device mirror.

import { test, expect } from "../fixtures.js"
import { actionEvent, hierarchyXml } from "../trace-builder.js"
import { solidPng } from "../../png.js"

// Screenshot and hierarchy bounds share one coordinate space, which is what
// makes a click on the image resolvable to a node.
const SCREEN = { width: 360, height: 800 }

const HIERARCHY = hierarchyXml([
  { class: "android.widget.TextView", text: "Gesture Testing", bounds: "[20,40][340,80]" },
  {
    class: "android.widget.Button",
    text: "Tap area",
    desc: "Tap area",
    id: "dev.tapsmith.testapp:id/tap-area",
    bounds: "[20,120][340,320]",
  },
])

const SPEC = {
  metadata: {
    device: {
      serial: "emulator-5554",
      isEmulator: true,
      screenResolution: SCREEN,
      devicePixelRatio: 1,
    },
  },
  events: [
    actionEvent({
      actionIndex: 0,
      action: "doubleTap",
      screenshots: { before: true, after: true },
      hierarchies: { before: true, after: true },
    }),
  ],
  screenshots: {
    "screenshots/action-000-before.png": solidPng(SCREEN.width, SCREEN.height, [30, 30, 40]),
    "screenshots/action-000-after.png": solidPng(SCREEN.width, SCREEN.height, [30, 30, 40]),
  },
  hierarchies: {
    "hierarchy/action-000-before.xml": HIERARCHY,
    "hierarchy/action-000-after.xml": HIERARCHY,
  },
}

/** Click the screenshot at the centre of a node's captured bounds. */
async function clickBounds(
  image: import("@playwright/test").Locator,
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  const box = await image.boundingBox()
  if (!box) throw new Error("screenshot is not visible")
  const fx = (bounds.left + bounds.right) / 2 / SCREEN.width
  const fy = (bounds.top + bounds.bottom) / 2 / SCREEN.height
  await image.page().mouse.click(box.x + box.width * fx, box.y + box.height * fy)
}

const TAP_AREA = { left: 20, top: 120, right: 340, bottom: 320 }
const HEADING = { left: 20, top: 40, right: 340, bottom: 80 }

test.describe("Pick mode", () => {
  test("offers a pick button once a screenshot is shown", async ({ viewer, page }) => {
    await viewer.open(SPEC)
    await expect(page.getByRole("button", { name: /Pick/ })).toBeEnabled()
  })

  test("reports that picking is active", async ({ viewer, page }) => {
    await viewer.open(SPEC)
    await page.getByRole("button", { name: "Pick", exact: true }).click()
    // The label is the only cue that the next click picks rather than navigates.
    await expect(page.getByRole("button", { name: "Picking…", exact: true })).toBeVisible()
  })

  test("picking an element suggests locators for it", async ({
    viewer,
    page,
    screenshotPanel,
    detailTabs,
    locator,
  }) => {
    await viewer.open(SPEC)
    await page.getByRole("button", { name: "Pick", exact: true }).click()
    await clickBounds(screenshotPanel.image, TAP_AREA)

    await detailTabs.select("Locator")
    await expect(locator.options.first()).toBeVisible()
    // The picked element has a content-desc and a resource id, so the generator
    // should prefer one of those over a class or xpath.
    await expect(locator.optionCodes.first()).toHaveText(
      /getBy(Role|Text|Label|TestId|Description)/,
    )
  })

  test("suggests locators specific to the element picked", async ({
    viewer,
    page,
    screenshotPanel,
    detailTabs,
    locator,
  }) => {
    await viewer.open(SPEC)
    await page.getByRole("button", { name: "Pick", exact: true }).click()
    await clickBounds(screenshotPanel.image, HEADING)

    await detailTabs.select("Locator")
    // Picking the heading must not offer the button's locators.
    await expect(locator.suggestions).toContainText("Gesture Testing")
    await expect(locator.suggestions).not.toContainText("tap-area")
  })

  test("leaves pick mode after a pick", async ({ viewer, page, screenshotPanel }) => {
    await viewer.open(SPEC)
    await page.getByRole("button", { name: "Pick", exact: true }).click()
    await clickBounds(screenshotPanel.image, TAP_AREA)

    // One pick per activation, so a stray second click can't silently repick.
    // Exact, because Playwright matches accessible names by substring and the
    // active label "Picking…" also contains "Pick".
    await expect(page.getByRole("button", { name: "Pick", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Picking…", exact: true })).toHaveCount(0)
  })

  test("a suggested locator matches the element it came from", async ({
    viewer,
    page,
    screenshotPanel,
    detailTabs,
    locator,
  }) => {
    await viewer.open(SPEC)
    await page.getByRole("button", { name: "Pick", exact: true }).click()
    await clickBounds(screenshotPanel.image, TAP_AREA)

    await detailTabs.select("Locator")
    await locator.options.first().click()

    // The generator's own suggestion must resolve to exactly one element —
    // otherwise it would throw a strict-mode violation when used.
    await expect(locator.matchCount).toHaveText("1 match")
  })
})

// Network-family actions (route/unroute/unrouteAll) never touch the device, so
// they capture no hierarchy — but the panel still shows a borrowed screenshot,
// so picking must work against a borrowed hierarchy too, not silently no-op.
// PILOT-302.
const SPEC_WITH_NETWORK_ACTION = {
  ...SPEC,
  events: [
    ...SPEC.events,
    actionEvent({ actionIndex: 1, action: "unrouteAll", category: "network" }),
  ],
}

test.describe("Pick mode on actions with no captured hierarchy", () => {
  test("picking works on a network action via the borrowed hierarchy", async ({
    viewer,
    page,
    actions,
    screenshotPanel,
    detailTabs,
    locator,
  }) => {
    await viewer.open(SPEC_WITH_NETWORK_ACTION)
    await actions.item("unrouteAll").click()

    await page.getByRole("button", { name: "Pick", exact: true }).click()
    await clickBounds(screenshotPanel.image, TAP_AREA)

    // Before the borrowed-hierarchy fallback this pick silently did nothing.
    await detailTabs.select("Locator")
    await expect(locator.options.first()).toBeVisible()
    await expect(locator.suggestions).toContainText("tap-area")
  })

  test("says the hierarchy is borrowed while picking", async ({
    viewer,
    page,
    actions,
  }) => {
    await viewer.open(SPEC_WITH_NETWORK_ACTION)
    await actions.item("unrouteAll").click()
    await page.getByRole("button", { name: "Pick", exact: true }).click()

    await expect(page.getByTestId("pick-note")).toHaveText("Hierarchy from the previous step")
  })

  test("does not show the borrowed note on actions with their own hierarchy", async ({
    viewer,
    page,
    actions,
  }) => {
    await viewer.open(SPEC_WITH_NETWORK_ACTION)
    await actions.item("doubleTap").click()
    await page.getByRole("button", { name: "Pick", exact: true }).click()

    await expect(page.getByRole("button", { name: "Picking…", exact: true })).toBeVisible()
    await expect(page.getByTestId("pick-note")).toHaveCount(0)
  })

  test("the After stage picks from the next step's hierarchy, matching its screenshot", async ({
    viewer,
    page,
    actions,
    screenshotPanel,
    detailTabs,
    locator,
  }) => {
    // The After stage shows the next action's before-screenshot, so picks on
    // it must resolve against that same moment's tree — the screen may have
    // changed since the previous step (e.g. a fulfilled route re-rendering).
    const SUBMIT = { left: 20, top: 400, right: 340, bottom: 600 }
    await viewer.open({
      metadata: SPEC.metadata,
      events: [
        ...SPEC_WITH_NETWORK_ACTION.events,
        actionEvent({
          actionIndex: 2,
          action: "tap",
          screenshots: { before: true },
          hierarchies: { before: true },
        }),
      ],
      screenshots: {
        ...SPEC.screenshots,
        "screenshots/action-002-before.png": solidPng(SCREEN.width, SCREEN.height, [40, 30, 30]),
      },
      hierarchies: {
        ...SPEC.hierarchies,
        "hierarchy/action-002-before.xml": hierarchyXml([
          {
            class: "android.widget.Button",
            text: "Submit order",
            desc: "Submit order",
            id: "dev.tapsmith.testapp:id/submit-order",
            bounds: "[20,400][340,600]",
          },
        ]),
      },
    })
    await actions.item("unrouteAll").click()
    await screenshotPanel.selectStage("After")
    await page.getByRole("button", { name: "Pick", exact: true }).click()

    await expect(page.getByTestId("pick-note")).toHaveText("Hierarchy from the next step")
    await clickBounds(screenshotPanel.image, SUBMIT)

    await detailTabs.select("Locator")
    await expect(locator.suggestions).toContainText("Submit order")
    await expect(locator.suggestions).not.toContainText("tap-area")
  })

  test("an active pick can still be exited on an action where picking is unavailable", async ({
    viewer,
    page,
    actions,
  }) => {
    // Two hierarchy-less actions before the only captured step: selecting the
    // first one mid-pick leaves nothing to borrow in either direction, and
    // the active Pick button must stay enabled as the way out.
    await viewer.open({
      metadata: SPEC.metadata,
      events: [
        actionEvent({ actionIndex: 0, action: "route", category: "network" }),
        actionEvent({ actionIndex: 1, action: "unrouteAll", category: "network" }),
        actionEvent({
          actionIndex: 2,
          action: "doubleTap",
          screenshots: { before: true, after: true },
          hierarchies: { before: true, after: true },
        }),
      ],
      screenshots: {
        "screenshots/action-002-before.png": solidPng(SCREEN.width, SCREEN.height, [30, 30, 40]),
        "screenshots/action-002-after.png": solidPng(SCREEN.width, SCREEN.height, [30, 30, 40]),
      },
      hierarchies: {
        "hierarchy/action-002-before.xml": HIERARCHY,
        "hierarchy/action-002-after.xml": HIERARCHY,
      },
    })
    await actions.item("doubleTap").click()
    await page.getByRole("button", { name: "Pick", exact: true }).click()
    await actions.item("route").first().click()

    const picking = page.getByRole("button", { name: "Picking…", exact: true })
    await expect(picking).toBeEnabled()
    await picking.click()

    // Out of pick mode, the dead control is disabled with the explanation.
    await expect(page.getByRole("button", { name: "Pick", exact: true })).toBeDisabled()
  })

  test("disables picking when no hierarchy was ever captured", async ({ viewer, page }) => {
    // A test whose only action is a network one: nothing earlier to borrow.
    await viewer.open({
      metadata: SPEC.metadata,
      events: [actionEvent({ actionIndex: 0, action: "unrouteAll", category: "network" })],
    })

    const pick = page.getByRole("button", { name: "Pick", exact: true })
    await expect(pick).toBeDisabled()
    // The tooltip explains why, rather than leaving a dead control.
    await expect(pick).toHaveAttribute(
      "title",
      "No view hierarchy captured yet — pick from a device action instead",
    )
  })
})
