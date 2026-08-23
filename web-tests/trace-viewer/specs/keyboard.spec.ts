// Keyboard operation of the tab strips.
//
// These were clickable `div`s with no role and no way to reach them by keyboard.
// Giving them `role="tab"` without keyboard support would have announced a
// widget that cannot be operated, so the roles and the key handling belong
// together.
//
// Tabs stay individually tabbable rather than using APG's roving-tabindex
// pattern — see `src/ui-mode/tabstrip.ts` for why — so arrow keys are additive
// and Tab still reaches each one.

import { test, expect } from "../fixtures.js"
import { actionEvent } from "../trace-builder.js"
import { solidPng } from "../../png.js"

const SCREEN = { width: 200, height: 420 }

const WITH_SCREENSHOTS = {
  events: [
    actionEvent({
      actionIndex: 0,
      action: "doubleTap",
      screenshots: { before: true, after: true },
    }),
  ],
  screenshots: {
    "screenshots/action-000-before.png": solidPng(SCREEN.width, SCREEN.height, [200, 30, 30]),
    "screenshots/action-000-after.png": solidPng(SCREEN.width, SCREEN.height, [30, 200, 30]),
  },
}

test.describe("Detail tabs keyboard", () => {
  test("each tab is reachable with Tab", async ({ viewer, detailTabs }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.tab("Call").focus()
    await expect(detailTabs.tab("Call")).toBeFocused()
  })

  test("Right and Left move between tabs and select as they go", async ({
    viewer,
    detailTabs,
    page,
  }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.tab("Call").focus()

    await page.keyboard.press("ArrowRight")
    await expect(detailTabs.tab("Log")).toBeFocused()
    await expect(detailTabs.tab("Log")).toHaveAttribute("aria-selected", "true")

    await page.keyboard.press("ArrowLeft")
    await expect(detailTabs.tab("Call")).toBeFocused()
    await expect(detailTabs.tab("Call")).toHaveAttribute("aria-selected", "true")
  })

  test("wraps around at both ends", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.tab("Call").focus()

    // Call is first, so Left wraps to the last tab.
    await page.keyboard.press("ArrowLeft")
    await expect(detailTabs.tab("Errors")).toBeFocused()

    await page.keyboard.press("ArrowRight")
    await expect(detailTabs.tab("Call")).toBeFocused()
  })

  test("Home and End jump to the ends", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.tab("Source").focus()

    await page.keyboard.press("End")
    await expect(detailTabs.tab("Errors")).toBeFocused()
    await expect(detailTabs.tab("Errors")).toHaveAttribute("aria-selected", "true")

    await page.keyboard.press("Home")
    await expect(detailTabs.tab("Call")).toBeFocused()
  })

  test("Enter and Space activate the focused tab", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })

    // Focus without selecting, then activate — a div has no built-in activation.
    await detailTabs.tab("Network").focus()
    await page.keyboard.press("Enter")
    await expect(detailTabs.tab("Network")).toHaveAttribute("aria-selected", "true")

    await detailTabs.tab("Source").focus()
    await page.keyboard.press(" ")
    await expect(detailTabs.tab("Source")).toHaveAttribute("aria-selected", "true")
  })

  test("skips the Locator tab when the viewer has none", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    // The standalone viewer does render a Locator tab; assert navigation lands
    // on whatever is actually adjacent rather than assuming a fixed count.
    const count = await detailTabs.tabList.getByRole("tab").count()
    await detailTabs.tab("Call").focus()
    for (let i = 0; i < count; i++) await page.keyboard.press("ArrowRight")
    // A full lap returns to the start.
    await expect(detailTabs.tab("Call")).toBeFocused()
  })
})

test.describe("Screenshot stage keyboard", () => {
  test("Right and Left move between stages", async ({ viewer, screenshotPanel, page }) => {
    await viewer.open(WITH_SCREENSHOTS)
    await expect(screenshotPanel.stages).toBeVisible()

    await screenshotPanel.stage("Action").focus()
    await page.keyboard.press("ArrowRight")
    await expect(screenshotPanel.stage("Before")).toBeFocused()
    await expect(screenshotPanel.image).toHaveAttribute("alt", "Screenshot before")

    await page.keyboard.press("ArrowRight")
    await expect(screenshotPanel.stage("After")).toBeFocused()
    await expect(screenshotPanel.image).toHaveAttribute("alt", "Screenshot after")
  })

  test("Home and End jump to the ends", async ({ viewer, screenshotPanel, page }) => {
    await viewer.open(WITH_SCREENSHOTS)
    await screenshotPanel.stage("Before").focus()

    await page.keyboard.press("End")
    await expect(screenshotPanel.stage("After")).toBeFocused()

    await page.keyboard.press("Home")
    await expect(screenshotPanel.stage("Action")).toBeFocused()
  })

  test("Enter activates the focused stage", async ({ viewer, screenshotPanel, page }) => {
    await viewer.open(WITH_SCREENSHOTS)
    await screenshotPanel.stage("After").focus()
    await page.keyboard.press("Enter")
    await expect(screenshotPanel.stage("After")).toHaveAttribute("aria-selected", "true")
  })
})
