import { test, expect, describe } from "pilot"
import { text, contentDesc, id } from "pilot"

describe("Accessibility screen", () => {
  test("navigate to accessibility screen", async ({ device }) => {
    await device.tap(contentDesc("Accessibility"))
  })

  test("shows heading", async ({ device }) => {
    await expect(device.element(text("Accessibility Testing"))).toBeVisible()
  })

  // ─── Roles ───
  // PILOT-XXX: RN accessibilityRole not mapped to Android role

  test("button role element exists", async ({ device }) => {
    await expect(device.element(id("role-button"))).toExist()
  })

  test("link role element exists", async ({ device }) => {
    await expect(device.element(id("role-link"))).toExist()
  })

  test("header role element exists", async ({ device }) => {
    await expect(device.element(id("role-header"))).toExist()
  })

  test("image role element exists", async ({ device }) => {
    await expect(device.element(id("role-image"))).toExist()
  })

  test("alert role element exists", async ({ device }) => {
    await expect(device.element(id("role-alert"))).toExist()
  })

  // ─── Accessible Names ───

  test("button has accessible name 'Submit form'", async ({ device }) => {
    await expect(device.element(id("role-button"))).toHaveAccessibleName("Submit form")
  })

  test("image has accessible name 'Profile photo'", async ({ device }) => {
    await expect(device.element(id("role-image"))).toHaveAccessibleName("Profile photo")
  })

  // ─── Content Descriptions ───

  test("close icon has content description", async ({ device }) => {
    await expect(device.element(contentDesc("Close menu"))).toBeVisible()
  })

  test("cart icon has content description", async ({ device }) => {
    await expect(device.element(contentDesc("Shopping cart with 3 items"))).toBeVisible()
  })

  test("avatar has content description", async ({ device }) => {
    await expect(device.element(id("desc-avatar"))).toBeVisible()
    await expect(device.element(id("desc-avatar"))).toHaveAccessibleName("User avatar")
  })

  // ─── Grouped Elements ───

  test("grouped profile is visible after scrolling", async ({ device }) => {
    await device.swipe("up")
    await expect(device.element(id("grouped-profile"))).toBeVisible()
  })
})
