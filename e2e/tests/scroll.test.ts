import { beforeAll, describe, expect, test } from "pilot"
import { ScrollScreen } from "../screens/scroll.screen.js"

describe("Scroll screen", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Scroll").scrollIntoView()
    await device.getByDescription("Scroll").tap()
  })

  test("shows heading and description", async ({ device }) => {
    const screen = new ScrollScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  test("first section is visible", async ({ device }) => {
    const screen = new ScrollScreen(device)
    await expect(screen.sectionA).toBeVisible()
    await expect(screen.firstItem).toBeVisible()
  })

  test("first item has correct accessible name", async ({ device }) => {
    const screen = new ScrollScreen(device)
    await expect(screen.firstItem).toHaveAccessibleName("Item A-1")
  })

  // ─── Element Screenshots ───

  test("can take element screenshot", async ({ device }) => {
    const screen = new ScrollScreen(device)
    const png = await screen.sectionA.screenshot()
    expect(png.length).toBeGreaterThan(0)
  })

  test("can take full device screenshot", async ({ device }) => {
    const screenshot = await device.takeScreenshot()
    expect(screenshot.success).toBe(true)
    expect(screenshot.data.length).toBeGreaterThan(0)
  })
})
