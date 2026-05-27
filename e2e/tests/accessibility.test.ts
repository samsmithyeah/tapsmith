import { describe, expect, test } from "../fixtures.js"
import { resetApp } from "../utils/app-reset.js"

describe("Accessibility screen", () => {
  test.beforeAll(async ({ device }) => {
    await resetApp(device, "/accessibility")
    await expect(device.getByText("Accessibility Testing", { exact: true })).toBeVisible()
  })

  test.beforeEach(async ({ device, accessibilityScreen }) => {
    if (!(await accessibilityScreen.heading.exists())) {
      await resetApp(device, "/accessibility")
    }
  })

  test("shows heading", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.heading).toBeVisible()
  })

  // ─── Roles ───

  test("button role element exists", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleButton).toExist()
    await expect(accessibilityScreen.roleButton).toHaveRole("button")
  })

  test("link role element exists", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleLink).toExist()
    await expect(accessibilityScreen.roleLink).toHaveRole("link")
  })

  test("header role element exists", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleHeader).toExist()
    await expect(accessibilityScreen.roleHeader).toHaveRole("heading")
  })

  test("image role element exists", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleImage).toExist()
    await expect(accessibilityScreen.roleImage).toHaveRole("image")
  })

  test("alert role element exists", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleAlert).toExist()
    // toHaveRole("alert") omitted: iOS has no UIAccessibilityTrait for
    // alert, so the agent can't report the role back. The toExist()
    // above verifies getByRole("alert") finds the element.
  })

  // ─── Accessible Names ───

  test("button has accessible name 'Submit form'", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleButton).toHaveAccessibleName("Submit form")
  })

  test("image has accessible name 'Profile photo'", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.roleImage).toHaveAccessibleName("Profile photo")
  })

  // ─── Content Descriptions ───

  test("close icon has content description", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.closeIcon).toBeVisible()
  })

  test("cart icon has content description", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.cartIcon).toBeVisible()
  })

  test("avatar has content description", async ({ accessibilityScreen }) => {
    await expect(accessibilityScreen.avatar).toBeVisible()
    await expect(accessibilityScreen.avatar).toHaveAccessibleName("User avatar")
  })

  // ─── Grouped Elements ───

  test("grouped profile is visible after scrolling", async ({ device, accessibilityScreen }) => {
    await device.swipe("up")
    await expect(accessibilityScreen.groupedProfile).toBeVisible()
  })
})
