import { beforeAll, beforeEach, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("getByRole expanded option", () => {
  beforeAll(async ({ device }) => {
    await openScreen(device, "/visibility")
    await expect(device.getByText("Visibility Testing", { exact: true })).toBeVisible()
  })

  beforeEach(async ({ device }) => {
    if (!(await device.getByText("Visibility Testing", { exact: true }).exists())) {
      await device.getByDescription("Visibility").tap()
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
