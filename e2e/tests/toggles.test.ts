import { beforeEach, contentDesc, describe, expect, role, test, text } from "pilot"

const PKG = "dev.pilot.testapp"

describe("Toggles screen", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp(PKG)
    await device.tap(contentDesc("Toggles"))
    await expect(device.element(text("Switches"))).toBeVisible()
  })

  // ─── Switches ───

  test("switches section heading is visible", async ({ device }) => {
    await expect(device.element(text("Switches"))).toBeVisible()
  })

  test("dark mode switch starts unchecked", async ({ device }) => {
    await expect(device.element(role("switch", "Dark Mode"))).not.toBeChecked()
  })

  test("notifications switch starts checked", async ({ device }) => {
    await expect(device.element(role("switch", "Notifications"))).toBeChecked()
  })

  test("setChecked() can turn dark mode on and off", async ({ device }) => {
    await device.element(role("switch", "Dark Mode")).setChecked(true)
    await expect(device.element(role("switch", "Dark Mode"))).toBeChecked()

    await device.element(role("switch", "Dark Mode")).setChecked(false)
    await expect(device.element(role("switch", "Dark Mode"))).not.toBeChecked()
  })

  test("isChecked() returns current state", async ({ device }) => {
    const checked = await device.element(role("switch", "Notifications")).isChecked()
    expect(checked).toBe(true)
  })

  // ─── Checkboxes ───

  test("agree checkbox starts unchecked", async ({ device }) => {
    await expect(device.element(role("checkbox", "I agree to terms"))).not.toBeChecked()
  })

  test("tapping checkbox toggles its state", async ({ device }) => {
    await device.tap(role("checkbox", "I agree to terms"))
    await expect(device.element(role("checkbox", "I agree to terms"))).toBeChecked()

    await device.tap(role("checkbox", "I agree to terms"))
    await expect(device.element(role("checkbox", "I agree to terms"))).not.toBeChecked()
  })

  // ─── Radio Buttons ───

  test("radio buttons are visible", async ({ device }) => {
    await device.swipe("up")
    await expect(device.element(text("Small"))).toBeVisible()
    await expect(device.element(text("Medium"))).toBeVisible()
    await expect(device.element(text("Large"))).toBeVisible()
  })

  test("tapping small selects it", async ({ device }) => {
    await device.swipe("up")
    await device.tap(role("radiobutton", "Small"))
    await expect(device.element(role("radiobutton", "Small"))).toBeChecked()
  })
})
