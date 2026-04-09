import { beforeEach, describe, expect, test } from "pilot"
import { AccessibilityScreen } from "../screens/accessibility.screen.js"

describe("Accessibility screen", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp()
    const accessibilityCard = device.getByDescription("Accessibility")
    await accessibilityCard.scrollIntoView()
    await accessibilityCard.tap()
    await expect(device.getByText("Accessibility Testing", { exact: true })).toBeVisible()
  })

  test("shows heading", async ({ device }) => {
    await expect(device.getByText("Accessibility Testing", { exact: true })).toBeVisible()
  })

  // ─── Roles ───
  // PILOT-XXX: RN accessibilityRole not mapped to Android role

  test("button role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleButton).toExist()
  })

  test("link role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleLink).toExist()
  })

  test("header role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleHeader).toExist()
  })

  test("image role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleImage).toExist()
  })

  test("alert role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleAlert).toExist()
  })

  // ─── Accessible Names ───

  test("button has accessible name 'Submit form'", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleButton).toHaveAccessibleName("Submit form")
  })

  test("image has accessible name 'Profile photo'", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleImage).toHaveAccessibleName("Profile photo")
  })

  // ─── Content Descriptions ───

  test("close icon has content description", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.closeIcon).toBeVisible()
  })

  test("cart icon has content description", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.cartIcon).toBeVisible()
  })

  test("avatar has content description", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.avatar).toBeVisible()
    await expect(screen.avatar).toHaveAccessibleName("User avatar")
  })

  // ─── Grouped Elements ───

  test("grouped profile is visible after scrolling", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await device.swipe("up")
    await expect(screen.groupedProfile).toBeVisible()
  })
})
