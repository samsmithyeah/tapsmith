import { beforeAll, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("getByRole state options", () => {
  beforeAll(async ({ device }) => {
    await openScreen(device, "/toggles")
    await expect(device.getByText("Switches", { exact: true })).toBeVisible()
  })

  // ─── checked ───

  describe("checked", () => {
    test("finds unchecked switch with checked: false", async ({ device }) => {
      const darkMode = device.getByRole("switch", { name: "Dark Mode", checked: false })
      await expect(darkMode).toBeVisible()
    })

    test("does not find unchecked switch with checked: true", async ({ device }) => {
      const darkMode = device.getByRole("switch", { name: "Dark Mode", checked: true })
      const exists = await darkMode.exists()
      expect(exists).toBe(false)
    })

    test("finds checked switch with checked: true", async ({ device }) => {
      // Notifications starts checked (useState(true) in test app)
      const notifications = device.getByRole("switch", { name: "Notifications", checked: true })
      await expect(notifications).toBeVisible()
    })

    test("state updates after interaction", async ({ device }) => {
      const darkMode = device.getByRole("switch", { name: "Dark Mode" })
      await darkMode.tap()
      // Now it should be checked
      const checkedDarkMode = device.getByRole("switch", { name: "Dark Mode", checked: true })
      await expect(checkedDarkMode).toBeVisible()
    })
  })

  // ─── disabled ───

  describe("disabled", () => {
    test("finds enabled element with disabled: false", async ({ device }) => {
      const darkMode = device.getByRole("switch", { name: "Dark Mode", disabled: false })
      await expect(darkMode).toBeVisible()
    })

    test("does not find enabled element with disabled: true", async ({ device }) => {
      const darkMode = device.getByRole("switch", { name: "Dark Mode", disabled: true })
      const exists = await darkMode.exists()
      expect(exists).toBe(false)
    })
  })

  // ─── selected ───

  describe("selected", () => {
    test("finds unselected switch with selected: false", async ({ device }) => {
      const darkMode = device.getByRole("switch", { name: "Dark Mode", selected: false })
      await expect(darkMode).toBeVisible()
    })
  })
})
