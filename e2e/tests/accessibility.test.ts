import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("Accessibility screen", () => {
  test.beforeAll(async ({ device, accessibilityScreen }) => {
    await openScreen(device, "/accessibility")
    await expect(accessibilityScreen.heading).toBeVisible()
  })

  test.beforeEach(async ({ device, accessibilityScreen }) => {
    if (!(await accessibilityScreen.heading.exists())) {
      await openScreen(device, "/accessibility")
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

  test("grouped profile is visible after scrolling", async ({ accessibilityScreen }) => {
    // scrollIntoView rather than a blind swipe: one swipe's scroll distance
    // depends on device metrics — on iPhone 17 (iOS 26 CI image) it left the
    // profile below the fold at y=1076 with an ~874pt viewport, failing the
    // visibility assertion. This test is about grouped a11y semantics, not
    // swipe mechanics (gestures.test.ts covers those).
    await accessibilityScreen.groupedProfile.scrollIntoView()
    await expect(accessibilityScreen.groupedProfile).toBeVisible()
  })
})
