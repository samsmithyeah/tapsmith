import { contentDesc, describe, expect, role, test, text } from "pilot"

describe("Toggles screen", () => {
  test("navigate to toggles screen", async ({ device }) => {
    await device.tap(contentDesc("Toggles"))
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

  test("setChecked(true) turns dark mode on", async ({ device }) => {
    await device.element(role("switch", "Dark Mode")).setChecked(true)
    await expect(device.element(role("switch", "Dark Mode"))).toBeChecked()
  })

  test("setChecked(false) turns dark mode off", async ({ device }) => {
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

  test("tapping checkbox checks it", async ({ device }) => {
    await device.tap(role("checkbox", "I agree to terms"))
    await expect(device.element(role("checkbox", "I agree to terms"))).toBeChecked()
  })

  test("tapping again unchecks it", async ({ device }) => {
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
    await device.tap(role("radiobutton", "Small"))
    await expect(device.element(role("radiobutton", "Small"))).toBeChecked()
  })
})
