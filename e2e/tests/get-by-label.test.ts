import { beforeAll, describe, expect, test } from "tapsmith"
import { openScreen } from "../utils/app-reset.js"

describe("getByLabel", () => {
  // ─── Text fields (Login screen) ───

  describe("text fields", () => {
    beforeAll(async ({ device }) => {
      await device.getByDescription("Login Form").tap()
    })

    test("finds text field by its accessibility label", async ({ device }) => {
      const emailInput = device.getByLabel("Email")
      await expect(emailInput).toBeVisible()
    })

    test("can type into a labeled text field", async ({ device }) => {
      const emailInput = device.getByLabel("Email")
      await emailInput.clearAndType("test@example.com")
      await expect(emailInput).toHaveValue("test@example.com")
    })

    test("finds password field by label", async ({ device }) => {
      const passwordInput = device.getByLabel("Password")
      await expect(passwordInput).toBeVisible()
    })

    test("does not match non-input elements with the same text", async ({ device }) => {
      // "Email" appears as both a label Text and the TextInput's accessibilityLabel.
      // getByLabel should only find the input, not the label text.
      const count = await device.getByLabel("Email").count()
      expect(count).toBe(1)
    })
  })

  // ─── Switches (Toggles screen) ───

  describe("switches", () => {
    beforeAll(async ({ device }) => {
      await openScreen(device, "/toggles")
    })

    test("finds switch by its accessibility label", async ({ device }) => {
      const darkModeSwitch = device.getByLabel("Dark Mode")
      await expect(darkModeSwitch).toBeVisible()
    })

    test("can interact with a labeled switch", async ({ device }) => {
      const darkModeSwitch = device.getByLabel("Dark Mode")
      await expect(darkModeSwitch).toBeVisible()
      await expect(darkModeSwitch).not.toBeChecked()
      await darkModeSwitch.tap()
      await expect(darkModeSwitch).toBeChecked()
    })

    test("finds multiple labeled switches independently", async ({ device }) => {
      await expect(device.getByLabel("Sound")).toBeVisible()
      await expect(device.getByLabel("Vibration")).toBeVisible()
    })
  })
})
