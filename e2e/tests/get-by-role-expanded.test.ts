import { beforeAll, beforeEach, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("getByRole expanded option", () => {
  beforeAll(async ({ device }) => {
    await openScreen(device, "/visibility")
    await expect(device.getByText("Visibility Testing", { exact: true })).toBeVisible()
  })

  beforeEach(async ({ device }) => {
    // exists() is non-waiting (PILOT-344), so a lagging accessibility tree can
    // answer false while the screen is showing. Re-open the route (a deep link,
    // idempotent) rather than tapping a home-screen row that is not here.
    if (!(await device.getByText("Visibility Testing", { exact: true }).exists())) {
      await openScreen(device, "/visibility")
      await expect(device.getByText("Visibility Testing", { exact: true })).toBeVisible()
    }
  })

  test("finds collapsed element with expanded: false", async ({ device }) => {
    const toggle = device.getByRole("button", { name: "Toggle details", expanded: false })
    await expect(toggle).toBeVisible()
  })

  test("does not find collapsed element with expanded: true", async ({ device }) => {
    const toggle = device.getByRole("button", { name: "Toggle details", expanded: true })
    const exists = await toggle.exists()
    expect(exists).toBe(false)
  })

  test("state updates after expanding", async ({ device }) => {
    await device.getByRole("button", { name: "Toggle details" }).tap()
    const expanded = device.getByRole("button", { name: "Toggle details", expanded: true })
    await expect(expanded).toBeVisible()
  })
})
