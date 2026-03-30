import { beforeEach, contentDesc, describe, expect, test } from "pilot"
import { TogglesScreen } from "../screens/toggles.screen.js"

describe("Toggles screen", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp()
    await device.tap(contentDesc("Toggles"))
    const screen = new TogglesScreen(device)
    await expect(screen.switchesHeading).toBeVisible()
  })

  // ─── Switches ───

  test("dark mode switch starts unchecked", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await expect(screen.darkModeSwitch).not.toBeChecked()
  })

  test("notifications switch starts checked", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await expect(screen.notificationsSwitch).toBeChecked()
  })

  test("setChecked() can turn dark mode on and off", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await screen.darkModeSwitch.setChecked(true)
    await expect(screen.darkModeSwitch).toBeChecked()

    await screen.darkModeSwitch.setChecked(false)
    await expect(screen.darkModeSwitch).not.toBeChecked()
  })

  test("isChecked() returns current state", async ({ device }) => {
    const screen = new TogglesScreen(device)
    const checked = await screen.notificationsSwitch.isChecked()
    expect(checked).toBe(true)
  })

  // ─── Checkboxes ───

  test("agree checkbox starts unchecked", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await expect(screen.agreeCheckbox).not.toBeChecked()
  })

  test("tapping checkbox toggles its state", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await screen.agreeCheckbox.tap()
    await expect(screen.agreeCheckbox).toBeChecked()

    await screen.agreeCheckbox.tap()
    await expect(screen.agreeCheckbox).not.toBeChecked()
  })

  // ─── Radio Buttons ───

  test("radio buttons are visible", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await device.swipe("up")
    await expect(screen.smallLabel).toBeVisible()
    await expect(screen.mediumLabel).toBeVisible()
    await expect(screen.largeLabel).toBeVisible()
  })

  test("tapping small selects it", async ({ device }) => {
    const screen = new TogglesScreen(device)
    await device.swipe("up")
    await screen.radioSmall.tap()
    await expect(screen.radioSmall).toBeChecked()
  })
})
