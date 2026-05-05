import { beforeAll, describe, expect, test } from "tapsmith"

describe("getByRole expanded option", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Visibility").tap()
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
