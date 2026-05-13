import { beforeAll, beforeEach, describe, expect, test } from "tapsmith"
import { AccessibilityScreen } from "../screens/accessibility.screen.js"

describe("Accessibility screen", () => {
  beforeAll(async ({ device }) => {
    await device.restartApp()
    const screen = new AccessibilityScreen(device)
    await screen.navCard.scrollIntoView()
    await screen.navCard.tap()
    await expect(screen.heading).toBeVisible()
  })

  beforeEach(async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    if (!(await screen.heading.exists())) {
      await screen.navCard.scrollIntoView()
      await screen.navCard.tap()
      await expect(screen.heading).toBeVisible()
    }
  })

  test("shows heading", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  // ─── Roles ───

  test("button role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleButton).toExist()
    await expect(screen.roleButton).toHaveRole("button")
  })

  test("link role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleLink).toExist()
    await expect(screen.roleLink).toHaveRole("link")
  })

  test("header role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleHeader).toExist()
    await expect(screen.roleHeader).toHaveRole("heading")
  })

  test("image role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleImage).toExist()
    await expect(screen.roleImage).toHaveRole("image")
  })

  test("alert role element exists", async ({ device }) => {
    const screen = new AccessibilityScreen(device)
    await expect(screen.roleAlert).toExist()
    // toHaveRole("alert") omitted: iOS has no UIAccessibilityTrait for
    // alert, so the agent can't report the role back. The toExist()
    // above verifies getByRole("alert") finds the element.
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
