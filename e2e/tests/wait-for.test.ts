import { describe, expect, test } from "../fixtures.js"

describe("waitFor", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///visibility")
  })

  // ─── state: visible (default) ───

  test("waitFor() resolves when element is already visible", async ({ visibilityScreen }) => {
    await visibilityScreen.banner.waitFor()
  })

  test("waitFor({ state: 'visible' }) waits for element to appear", async ({ visibilityScreen }) => {
    // Dismiss the banner, then show it again and wait for it
    await visibilityScreen.dismissBannerButton.tap()
    await visibilityScreen.showBannerButton.tap()
    await visibilityScreen.banner.waitFor({ state: "visible" })
    await expect(visibilityScreen.banner).toBeVisible()
  })

  // ─── state: hidden ───

  test("waitFor({ state: 'hidden' }) resolves when element is not present", async ({ visibilityScreen }) => {
    // Expanded content doesn't exist yet — hidden should resolve immediately
    await visibilityScreen.expandedContent.waitFor({ state: "hidden" })
  })

  test("waitFor({ state: 'hidden' }) waits for element to disappear", async ({ device, visibilityScreen }) => {
    await device.swipe("up")
    // Start loading — the loading indicator appears then disappears after ~2s
    await visibilityScreen.startLoadingButton.tap()
    await expect(visibilityScreen.loadingIndicator).toBeVisible()
    await visibilityScreen.loadingIndicator.waitFor({ state: "hidden", timeout: 5000 })
    await expect(visibilityScreen.contentLoaded).toBeVisible()
  })

  // ─── state: attached ───

  test("waitFor({ state: 'attached' }) resolves when element exists regardless of visibility", async ({ device, visibilityScreen }) => {
    await device.swipe("down")
    // Banner is visible — attached should resolve
    await visibilityScreen.banner.waitFor({ state: "attached" })
  })

  test("waitFor({ state: 'attached' }) waits for element to be added to hierarchy", async ({ visibilityScreen }) => {
    // Expand the section — the content gets added to the hierarchy
    await visibilityScreen.expandToggle.tap()
    await visibilityScreen.expandedContent.waitFor({ state: "attached" })
    await expect(visibilityScreen.expandedContent).toExist()
  })

  // ─── state: detached ───

  test("waitFor({ state: 'detached' }) resolves when element does not exist", async ({ visibilityScreen }) => {
    // Error message doesn't exist yet
    await visibilityScreen.errorMessage.waitFor({ state: "detached" })
  })

  test("waitFor({ state: 'detached' }) waits for element to be removed from hierarchy", async ({ visibilityScreen }) => {
    // Collapse the expanded section — content gets removed entirely
    await visibilityScreen.expandToggle.tap()
    await visibilityScreen.expandedContent.waitFor({ state: "detached" })
    const exists = await visibilityScreen.expandedContent.exists()
    expect(exists).toBe(false)
  })

  // ─── timeout ───

  test("waitFor() throws when timeout expires", async ({ visibilityScreen }) => {
    // Error message doesn't exist — waiting for 'visible' should time out
    let error: Error | undefined
    try {
      await visibilityScreen.errorMessage.waitFor({ state: "visible", timeout: 1000 })
    } catch (e) {
      error = e as Error
    }
    expect(error).toBeDefined()
    expect(error!.message).toMatch(/did not reach state "visible"/)
  })

  // ─── with modifiers ───

  test("waitFor() works with .first() modifier", async ({ device }) => {
    // The delete buttons are visible in the dynamic list
    await device.getByText("Delete").first().waitFor({ state: "visible" })
  })
})
