import { describe, expect, test } from "../fixtures.js"

describe("Visibility screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///visibility")
  })

  // ─── Dismissable Banner ───

  test("banner is visible on load", async ({ visibilityScreen }) => {
    await expect(visibilityScreen.banner).toBeVisible()
    await expect(visibilityScreen.banner).toExist()
  })

  test("dismissing banner hides it", async ({ visibilityScreen }) => {
    await visibilityScreen.dismissBannerButton.tap()
    await expect(visibilityScreen.banner).not.toBeVisible()
  })

  test("show banner button restores it", async ({ visibilityScreen }) => {
    await visibilityScreen.showBannerButton.tap()
    await expect(visibilityScreen.banner).toBeVisible()
  })

  // ─── Expandable Section ───

  test("expand toggle is visible", async ({ visibilityScreen }) => {
    await expect(visibilityScreen.expandToggle).toBeVisible()
  })

  test("expanded content does not exist by default", async ({ visibilityScreen }) => {
    await expect(visibilityScreen.expandedContent).not.toExist()
  })

  test("expanding reveals content", async ({ visibilityScreen }) => {
    await visibilityScreen.expandToggle.tap()
    await expect(visibilityScreen.expandedContent).toBeVisible()
  })

  test("collapsing hides content", async ({ visibilityScreen }) => {
    await visibilityScreen.expandToggle.tap()
    await expect(visibilityScreen.expandedContent).not.toExist()
  })

  // ─── Dynamic List ───

  test("dynamic list shows 3 items initially", async ({ visibilityScreen }) => {
    await expect(visibilityScreen.itemCount(3)).toBeVisible()
  })

  test("adding an item increases the count", async ({ visibilityScreen }) => {
    await visibilityScreen.addItemButton.tap()
    await expect(visibilityScreen.itemCount(4)).toBeVisible()
  })

  test("deleting an item decreases the count", async ({ visibilityScreen }) => {
    await visibilityScreen.deleteButton.first().tap()
    await expect(visibilityScreen.itemCount(3)).toBeVisible()
  })

  // ─── Loading State ───

  test("content loaded is shown initially", async ({ visibilityScreen }) => {
    await expect(visibilityScreen.contentLoaded).toBeVisible()
  })

  test("loading indicator appears and then disappears", async ({ device, visibilityScreen }) => {
    await device.swipe("up")
    await visibilityScreen.startLoadingButton.tap()
    await expect(visibilityScreen.loadingIndicator).toBeVisible()
    await expect(visibilityScreen.contentLoaded).toBeVisible({ timeout: 5000 })
  })

  // ─── Error State ───

  test("triggering error shows the error message", async ({ visibilityScreen }) => {
    await visibilityScreen.toggleErrorButton.tap()
    await expect(visibilityScreen.errorText).toBeVisible()
  })

  test("clearing error hides the message", async ({ visibilityScreen }) => {
    await visibilityScreen.toggleErrorButton.tap()
    await expect(visibilityScreen.errorMessage).not.toBeVisible()
  })
})
