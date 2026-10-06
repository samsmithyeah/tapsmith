import { beforeAll, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

// getByRole's `name` matches like Playwright's (PILOT-549): a case-insensitive
// substring by default, case-sensitive and whole with `{ exact: true }`. The
// toggles screen's switches are labelled "Dark Mode" and "Notifications".
describe("getByRole name matching", () => {
  beforeAll(async ({ device }) => {
    await openScreen(device, "/toggles")
    await expect(device.getByText("Switches", { exact: true })).toBeVisible()
  })

  test("matches the name case-insensitively by default", async ({ device }) => {
    await expect(device.getByRole("switch", { name: "DARK MODE" })).toBeVisible()
    await expect(device.getByRole("switch", { name: "dark mode" })).toHaveCount(1)
  })

  test("matches a substring of the name by default", async ({ device }) => {
    await expect(device.getByRole("switch", { name: "notif" })).toBeVisible()
    await expect(device.getByRole("switch", { name: "notif" })).toHaveCount(1)
  })

  test("exact: true is case-sensitive and whole-string", async ({ device }) => {
    await expect(device.getByRole("switch", { name: "Dark Mode", exact: true })).toBeVisible()
    expect(await device.getByRole("switch", { name: "dark mode", exact: true }).exists()).toBe(false)
    expect(await device.getByRole("switch", { name: "Dark", exact: true }).exists()).toBe(false)
  })

  test("a timed-out lookup names the locator as valid code", async ({ device }) => {
    const missing = device.getByRole("switch", { name: "Airplane mode", exact: true })
    const error = await missing.waitFor({ timeout: 1_000 }).then(() => null, (e: unknown) => e)
    expect(String(error)).toContain('getByRole("switch", { name: "Airplane mode", exact: true })')
  })
})
