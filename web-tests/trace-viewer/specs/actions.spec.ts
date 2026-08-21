// The action list and the screenshot panel it drives. Both shared with UI mode.

import { test, expect } from "../fixtures.js"
import { actionEvent, assertionEvent } from "../trace-builder.js"
import { solidPng } from "../../png.js"

const SCREEN = { width: 240, height: 500 }

const WITH_SCREENSHOTS = {
  events: [
    actionEvent({
      actionIndex: 0,
      action: "launchApp",
      screenshots: { before: true, after: true },
    }),
    actionEvent({
      actionIndex: 1,
      action: "doubleTap",
      selector: 'getByRole("button", { name: "Tap area" })',
      screenshots: { before: true, after: true },
    }),
  ],
  screenshots: {
    "screenshots/action-000-before.png": solidPng(SCREEN.width, SCREEN.height, [200, 30, 30]),
    "screenshots/action-000-after.png": solidPng(SCREEN.width, SCREEN.height, [30, 200, 30]),
    "screenshots/action-001-before.png": solidPng(SCREEN.width, SCREEN.height, [30, 30, 200]),
    "screenshots/action-001-after.png": solidPng(SCREEN.width, SCREEN.height, [200, 200, 30]),
  },
}

test.describe("Action list", () => {
  test("lists actions and assertions in order", async ({ viewer, actions }) => {
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "launchApp" }),
        actionEvent({ actionIndex: 1, action: "doubleTap" }),
        assertionEvent({ actionIndex: 2, assertion: "toContainText" }),
      ],
    })

    await expect(actions.items).toHaveCount(3)
    await expect(actions.items.nth(0)).toContainText("launchApp")
    await expect(actions.items.nth(1)).toContainText("doubleTap")
    await expect(actions.items.nth(2)).toContainText("toContainText")
  })

  test("marks the selected row", async ({ viewer, actions }) => {
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "launchApp" }),
        actionEvent({ actionIndex: 1, action: "doubleTap" }),
      ],
    })

    await actions.items.nth(1).click()
    await expect(actions.items.nth(1)).toHaveAttribute("aria-selected", "true")
    await expect(actions.items.nth(0)).toHaveAttribute("aria-selected", "false")
  })

  test("distinguishes a failed action", async ({ viewer, actions }) => {
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "launchApp" }),
        actionEvent({
          actionIndex: 1,
          action: "doubleTap",
          success: false,
          error: "Element not found",
        }),
      ],
    })
    // A red row is how a failure is found without reading every entry.
    await expect(actions.items.nth(1)).toHaveClass(/failed/)
    await expect(actions.items.nth(0)).not.toHaveClass(/failed/)
  })

  test("distinguishes a failed assertion", async ({ viewer, actions }) => {
    await viewer.open({
      events: [
        assertionEvent({
          actionIndex: 0,
          assertion: "toBeVisible",
          passed: false,
          error: "Timed out",
        }),
      ],
    })
    await expect(actions.items.first()).toHaveClass(/failed/)
  })

  test("shows the selector an action targeted", async ({ viewer, actions }) => {
    await viewer.open({
      events: [
        actionEvent({
          actionIndex: 0,
          action: "doubleTap",
          selector: 'getByTestId("tap-area")',
        }),
      ],
    })
    await expect(actions.items.first()).toContainText("tap-area")
  })

  test("filters the list", async ({ viewer, actions, page }) => {
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "launchApp" }),
        actionEvent({ actionIndex: 1, action: "doubleTap" }),
        actionEvent({ actionIndex: 2, action: "swipe" }),
      ],
    })

    await page.getByRole("textbox", { name: "Filter actions" }).fill("tap")
    await expect(actions.items).toHaveCount(1)
    await expect(actions.items.first()).toContainText("doubleTap")
  })
})

test.describe("Screenshot panel", () => {
  test("shows the screenshot for the selected action", async ({ viewer, screenshotPanel }) => {
    await viewer.open(WITH_SCREENSHOTS)
    await expect(screenshotPanel.image).toBeVisible()
  })

  test("names the test in the header", async ({ viewer, screenshotPanel }) => {
    await viewer.open({
      ...WITH_SCREENSHOTS,
      metadata: { testName: "Gestures screen > double tap" },
    })
    await expect(screenshotPanel.title).toHaveText("Gestures screen > double tap")
  })

  test("switches between before, action and after", async ({
    viewer,
    actions,
    screenshotPanel,
  }) => {
    await viewer.open(WITH_SCREENSHOTS)
    await actions.items.nth(1).click()

    // The stage tabs only appear when both a before and an after were captured.
    await expect(screenshotPanel.stages).toBeVisible()

    await screenshotPanel.selectStage("Before")
    await expect(screenshotPanel.stage("Before")).toHaveAttribute("aria-selected", "true")
    await expect(screenshotPanel.image).toHaveAttribute("alt", "Screenshot before")

    await screenshotPanel.selectStage("After")
    await expect(screenshotPanel.image).toHaveAttribute("alt", "Screenshot after")
  })

  test("changes the screenshot when a different action is selected", async ({
    viewer,
    actions,
    screenshotPanel,
  }) => {
    await viewer.open(WITH_SCREENSHOTS)

    await actions.items.nth(0).click()
    const first = await screenshotPanel.image.getAttribute("src")

    await actions.items.nth(1).click()
    await expect(screenshotPanel.image).not.toHaveAttribute("src", first!)
  })

  test("says so when no screenshots were captured", async ({ viewer, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    // Without screenshots the panel has nothing to show but must not look broken.
    await expect(page.locator(".viewer-empty, .screenshot-empty").first()).toBeVisible()
  })
})
