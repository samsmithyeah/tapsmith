import { test, expect, describe } from "pilot"
import { text, id, contentDesc } from "pilot"

describe("Slow load screen", () => {
  test("navigate to slow load screen", async ({ device }) => {
    await device.swipe("up")
    await device.tap(contentDesc("Slow Load"))
  })

  test("shows heading and description", async ({ device }) => {
    await expect(device.element(text("Slow Loading"))).toBeVisible()
  })

  // ─── Data Fetching ───

  test("load buttons are visible", async ({ device }) => {
    await expect(device.element(id("load-2s"))).toBeVisible()
    await expect(device.element(id("load-5s"))).toBeVisible()
    await expect(device.element(id("load-fail"))).toBeVisible()
  })

  test("2s load shows data after loading", async ({ device }) => {
    await device.tap(id("load-2s"))
    await expect(device.element(text("User Profile"))).toBeVisible({ timeout: 10000 })
    await expect(device.element(text("John Doe"))).toBeVisible()
  })

  test("data rows show correct content", async ({ device }) => {
    await expect(device.element(id("data-row-1"))).toBeVisible()
    await expect(device.element(text("Email"))).toBeVisible()
    await expect(device.element(text("john@example.com"))).toBeVisible()
  })

  test("failed load shows error", async ({ device }) => {
    await device.tap(id("load-fail"))
    await expect(device.element(id("fetch-error"))).toBeVisible({ timeout: 10000 })
    await expect(device.element(text("Network request failed: timeout"))).toBeVisible()
  })

  // ─── Polling Counter ───

  test("counter starts at 0", async ({ device }) => {
    await device.swipe("up")
    await expect(device.element(text("0"))).toBeVisible()
  })

  // Counter tests deferred pending PILOT-149 (.not.toBeVisible polling fix)
  // and investigation into tap() hanging on start-counter button
})
