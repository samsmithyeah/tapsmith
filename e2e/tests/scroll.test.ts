import { describe, expect, test } from "../fixtures.js"

describe("Scroll screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///scroll")
  })

  test("shows heading and description", async ({ scrollScreen }) => {
    await expect(scrollScreen.heading).toBeVisible()
  })

  test("first section is visible", async ({ scrollScreen }) => {
    await expect(scrollScreen.sectionA).toBeVisible()
    await expect(scrollScreen.firstItem).toBeVisible()
  })

  test("first item has correct accessible name", async ({ scrollScreen }) => {
    await expect(scrollScreen.firstItem).toHaveAccessibleName("Item A-1")
  })

  // ─── Element Screenshots ───

  test("can take element screenshot", async ({ scrollScreen }) => {
    const png = await scrollScreen.sectionA.screenshot()
    expect(png.length).toBeGreaterThan(0)
  })

  test("can take full device screenshot", async ({ device }) => {
    const screenshot = await device.takeScreenshot()
    expect(screenshot.success).toBe(true)
    expect(screenshot.data.length).toBeGreaterThan(0)
  })
})
