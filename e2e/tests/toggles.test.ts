import { contentDesc, describe, expect, id, test, text } from "pilot"

describe("Toggles screen", () => {
  test("navigate to toggles screen", async ({ device }) => {
    await device.tap(contentDesc("Toggles"))
  })

  // ─── Switches ───

  test("switches section heading is visible", async ({ device }) => {
    await expect(device.element(text("Switches"))).toBeVisible()
  })

  test("dark mode switch starts unchecked", async ({ device }) => {
    await expect(device.element(id("dark-mode-switch"))).not.toBeChecked()
  })

  test("notifications switch starts checked", async ({ device }) => {
    await expect(device.element(id("notifications-switch"))).toBeChecked()
  })

  test("setChecked(true) turns dark mode on", async ({ device }) => {
    await device.element(id("dark-mode-switch")).setChecked(true)
    await expect(device.element(id("dark-mode-switch"))).toBeChecked()
  })

  test("setChecked(false) turns dark mode off", async ({ device }) => {
    await device.element(id("dark-mode-switch")).setChecked(false)
    await expect(device.element(id("dark-mode-switch"))).not.toBeChecked()
  })

  test("isChecked() returns current state", async ({ device }) => {
    const checked = await device.element(id("notifications-switch")).isChecked()
    expect(checked).toBe(true)
  })

  // ─── Checkboxes ───

  test("agree checkbox starts unchecked", async ({ device }) => {
    await expect(device.element(id("agree-checkbox"))).not.toBeChecked()
  })

  test("tapping checkbox checks it", async ({ device }) => {
    await device.tap(id("agree-checkbox"))
    await expect(device.element(id("agree-checkbox"))).toBeChecked()
  })

  test("tapping again unchecks it", async ({ device }) => {
    await device.tap(id("agree-checkbox"))
    await expect(device.element(id("agree-checkbox"))).not.toBeChecked()
  })

  // ─── Radio Buttons ───

  test("radio buttons are visible", async ({ device }) => {
    await device.swipe("up")
    await expect(device.element(text("Small"))).toBeVisible()
    await expect(device.element(text("Medium"))).toBeVisible()
    await expect(device.element(text("Large"))).toBeVisible()
  })

  test("tapping small selects it", async ({ device }) => {
    await device.tap(id("radio-small"))
    await expect(device.element(id("radio-small"))).toBeChecked()
  })
})
