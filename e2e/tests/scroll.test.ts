import { beforeAll, contentDesc, describe, expect, id, test, text } from "pilot"

describe("Scroll screen", () => {
  beforeAll(async ({ device }) => {
    await device.swipe("up")
    await device.tap(contentDesc("Scroll"))
  })

  test("shows heading and description", async ({ device }) => {
    await expect(device.element(text("Scroll Testing"))).toBeVisible()
  })

  test("first section is visible", async ({ device }) => {
    await expect(device.element(id("section-Section A"))).toBeVisible()
    await expect(device.element(id("scroll-item-A-1"))).toBeVisible()
  })

  test("first item has correct accessible name", async ({ device }) => {
    await expect(device.element(id("scroll-item-A-1"))).toHaveAccessibleName("Item A-1")
  })

  // ─── Element Screenshots ───

  test("can take element screenshot", async ({ device }) => {
    const png = await device.element(id("section-Section A")).screenshot()
    expect(png.length).toBeGreaterThan(0)
  })

  test("can take full device screenshot", async ({ device }) => {
    const screenshot = await device.takeScreenshot()
    expect(screenshot.success).toBe(true)
    expect(screenshot.data.length).toBeGreaterThan(0)
  })
})
