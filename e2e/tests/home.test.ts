import { describe, expect, test, text } from "pilot"

describe("Home screen", () => {
  test("shows the app header", async ({ device }) => {
    await expect(device.element(text("Test Screens"))).toBeVisible()
  })

  test("displays navigation cards", async ({ device }) => {
    await expect(device.element(text("Login Form"))).toBeVisible()
    await expect(device.element(text("List"))).toBeVisible()
    await expect(device.element(text("Toggles"))).toBeVisible()
    await expect(device.element(text("Spinner"))).toBeVisible()
    await expect(device.element(text("Gestures"))).toBeVisible()
    await expect(device.element(text("Dialogs"))).toBeVisible()
  })

  test("cards have descriptions", async ({ device }) => {
    await expect(
      device.element(text("Text inputs, buttons, focus/blur, keyboard")),
    ).toBeVisible()
    await expect(
      device.element(text("Scrollable list, filtering, counting items")),
    ).toBeVisible()
  })

  test("header element exists and has text", async ({ device }) => {
    await expect(device.element(text("Test Screens"))).toExist()
    await expect(device.element(text("Test Screens"))).toHaveText("Test Screens")
  })

  test("can scroll to see more cards", async ({ device }) => {
    await device.swipe("up")
    await expect(device.element(text("Slow Load"))).toBeVisible()
    await expect(device.element(text("Scroll"))).toBeVisible()
  })
})
