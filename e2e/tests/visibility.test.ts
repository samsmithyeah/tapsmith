import { beforeAll, contentDesc, describe, expect, id, test, text } from "pilot"

describe("Visibility screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Visibility"))
  })

  // ─── Dismissable Banner ───

  test("banner is visible on load", async ({ device }) => {
    const banner = device.element(id("banner"))
    await expect(banner).toBeVisible()
    await expect(banner).toExist()
  })

  test("dismissing banner hides it", async ({ device }) => {
    await device.tap(id("dismiss-banner"))
    await expect(device.element(id("banner"))).not.toBeVisible()
  })

  test("show banner button restores it", async ({ device }) => {
    await device.tap(id("show-banner"))
    await expect(device.element(id("banner"))).toBeVisible()
  })

  // ─── Expandable Section ───

  test("expand toggle is visible", async ({ device }) => {
    await expect(device.element(id("expand-toggle"))).toBeVisible()
  })

  test("expanded content does not exist by default", async ({ device }) => {
    await expect(device.element(id("expanded-content"))).not.toExist()
  })

  test("expanding reveals content", async ({ device }) => {
    await device.tap(id("expand-toggle"))
    await expect(device.element(id("expanded-content"))).toBeVisible()
  })

  test("collapsing hides content", async ({ device }) => {
    await device.tap(id("expand-toggle"))
    await expect(device.element(id("expanded-content"))).not.toExist()
  })

  // ─── Dynamic List ───

  test("dynamic list shows 3 items initially", async ({ device }) => {
    await expect(device.element(text("3 items"))).toBeVisible()
  })

  test("adding an item increases the count", async ({ device }) => {
    await device.tap(id("add-item"))
    await expect(device.element(text("4 items"))).toBeVisible()
  })

  test("deleting an item decreases the count", async ({ device }) => {
    await device.element(text("Delete")).first().tap()
    await expect(device.element(text("3 items"))).toBeVisible()
  })

  // ─── Loading State ───

  test("content loaded is shown initially", async ({ device }) => {
    await expect(device.element(text("Content loaded"))).toBeVisible()
  })

  test("loading indicator appears and then disappears", async ({ device }) => {
    await device.swipe("up")
    await device.tap(id("start-loading"))
    await expect(device.element(text("Loading..."))).toBeVisible()
    await expect(device.element(text("Content loaded"))).toBeVisible({ timeout: 5000 })
  })

  // ─── Error State ───

  test("triggering error shows the error message", async ({ device }) => {
    await device.tap(id("toggle-error"))
    await expect(device.element(text("An error occurred. Please try again."))).toBeVisible()
  })

  test("clearing error hides the message", async ({ device }) => {
    await device.tap(id("toggle-error"))
    await expect(device.element(id("error-message"))).not.toBeVisible()
  })
})
