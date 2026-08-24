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
  test("the tabs are sequential tab stops", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.tab("Call").focus()

    // Pressing Tab rather than calling focus() on each: focus() bypasses
    // sequential navigation, so it would pass even on unreachable tabs.
    for (const label of ["Log", "Console", "Source"] as const) {
      await page.keyboard.press("Tab")
      await expect(detailTabs.tab(label)).toBeFocused()
    }
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

  test("every tab is wired to the detail panel", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })

    // A tab that does not point at its panel leaves assistive tech unable to
    // associate the two.
    const controls = await detailTabs.tabList
      .getByRole("tab")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-controls")))
    expect(new Set(controls)).toEqual(new Set(["detail-tabpanel"]))

    await detailTabs.select("Network")
    // Located by accessible name, which only resolves if aria-labelledby points
    // at the right tab; the id then confirms it is the panel the tabs control.
    await expect(page.getByRole("tabpanel", { name: /^Network/ })).toHaveId("detail-tabpanel")
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

  test("Enter and Space activate the focused stage", async ({
    viewer,
    screenshotPanel,
    page,
  }) => {
    await viewer.open(WITH_SCREENSHOTS)

    await screenshotPanel.stage("After").focus()
    await page.keyboard.press("Enter")
    await expect(screenshotPanel.stage("After")).toHaveAttribute("aria-selected", "true")

    await screenshotPanel.stage("Before").focus()
    await page.keyboard.press(" ")
    await expect(screenshotPanel.stage("Before")).toHaveAttribute("aria-selected", "true")
    await expect(screenshotPanel.image).toHaveAttribute("alt", "Screenshot before")
  })

  test("no tab panel when there is only one screenshot", async ({
    viewer,
    screenshotPanel,
    page,
  }) => {
    // Most traced actions capture only an "after" shot, so the strip does not
    // render — and a tabpanel with no owning tablist would announce an unnamed
    // panel with nothing to navigate.
    await viewer.open({
      events: [actionEvent({ actionIndex: 0, action: "tap", screenshots: { after: true } })],
      screenshots: {
        "screenshots/action-000-after.png": solidPng(SCREEN.width, SCREEN.height, [30, 200, 30]),
      },
    })

    await expect(screenshotPanel.image).toBeVisible()
    await expect(screenshotPanel.stages).toHaveCount(0)
    // Asserted on the element, not by role and name: an orphaned panel has no
    // accessible name at all, so a name-filtered query would not match it and
    // this would pass with the bug present.
    await expect(page.locator("#screenshot-tabpanel")).toHaveCount(0)
  })

  test("each stage is wired to the image panel", async ({ viewer, screenshotPanel, page }) => {
    await viewer.open(WITH_SCREENSHOTS)
    await screenshotPanel.selectStage("Before")

    await expect(screenshotPanel.stage("Before")).toHaveAttribute(
      "aria-controls",
      "screenshot-tabpanel",
    )
    await expect(page.getByRole("tabpanel", { name: "Before" })).toHaveId("screenshot-tabpanel")
  })
})
