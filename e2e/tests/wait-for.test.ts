import { beforeAll, describe, expect, test } from "tapsmith"
import { VisibilityScreen } from "../screens/visibility.screen.js"

describe("waitFor", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Visibility").tap()
  })

  // ─── state: visible (default) ───

  test("waitFor() resolves when element is already visible", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    await screen.banner.waitFor()
  })

  test("waitFor({ state: 'visible' }) waits for element to appear", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    // Dismiss the banner, then show it again and wait for it
    await screen.dismissBannerButton.tap()
    await screen.showBannerButton.tap()
    await screen.banner.waitFor({ state: "visible" })
    await expect(screen.banner).toBeVisible()
  })

  // ─── state: hidden ───

  test("waitFor({ state: 'hidden' }) resolves when element is not present", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    // Expanded content doesn't exist yet — hidden should resolve immediately
    await screen.expandedContent.waitFor({ state: "hidden" })
  })

  test("waitFor({ state: 'hidden' }) waits for element to disappear", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    await device.swipe("up")
    // Start loading — the loading indicator appears then disappears after ~2s
    await screen.startLoadingButton.tap()
    await expect(screen.loadingIndicator).toBeVisible()
    await screen.loadingIndicator.waitFor({ state: "hidden", timeout: 5000 })
    await expect(screen.contentLoaded).toBeVisible()
  })

  // ─── state: attached ───

  test("waitFor({ state: 'attached' }) resolves when element exists regardless of visibility", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    await device.swipe("down")
    // Banner is visible — attached should resolve
    await screen.banner.waitFor({ state: "attached" })
  })

  test("waitFor({ state: 'attached' }) waits for element to be added to hierarchy", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    // Expand the section — the content gets added to the hierarchy
    await screen.expandToggle.tap()
    await screen.expandedContent.waitFor({ state: "attached" })
    await expect(screen.expandedContent).toExist()
  })

  // ─── state: detached ───

  test("waitFor({ state: 'detached' }) resolves when element does not exist", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    // Error message doesn't exist yet
    await screen.errorMessage.waitFor({ state: "detached" })
  })

  test("waitFor({ state: 'detached' }) waits for element to be removed from hierarchy", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    // Collapse the expanded section — content gets removed entirely
    await screen.expandToggle.tap()
    await screen.expandedContent.waitFor({ state: "detached" })
    const exists = await screen.expandedContent.exists()
    expect(exists).toBe(false)
  })

  // ─── timeout ───

  test("waitFor() throws when timeout expires", async ({ device }) => {
    const screen = new VisibilityScreen(device)
    // Error message doesn't exist — waiting for 'visible' should time out
    let error: Error | undefined
    try {
      await screen.errorMessage.waitFor({ state: "visible", timeout: 1000 })
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
