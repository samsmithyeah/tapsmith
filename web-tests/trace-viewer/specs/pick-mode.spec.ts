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
