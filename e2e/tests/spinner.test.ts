import { beforeAll, contentDesc, describe, expect, id, test, text } from "pilot"

describe("Spinner screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Spinner"))
  })

  // ─── Dropdowns ───

  test("shows dropdown heading", async ({ device }) => {
    await expect(device.element(text("Dropdowns"))).toBeVisible()
  })

  test("country dropdown shows placeholder initially", async ({ device }) => {
    await expect(device.element(id("country-dropdown"))).toBeVisible()
    await expect(device.element(text("Select..."))).toBeVisible()
  })

  test("tapping country dropdown opens options and allows selection", async ({ device }) => {
    await device.tap(id("country-dropdown"))
    await expect(device.element(text("United States"))).toBeVisible()
    await expect(device.element(text("United Kingdom"))).toBeVisible()
    await device.tap(text("Canada"))
    await expect(device.element(id("selected-country"))).toHaveText("Country: Canada")
  })

  test("can select a color", async ({ device }) => {
    await device.tap(id("color-dropdown"))
    await device.tap(text("Blue"))
    await expect(device.element(id("selected-color"))).toHaveText("Color: Blue")
  })

  test("can select a priority", async ({ device }) => {
    await device.tap(id("priority-dropdown"))
    await device.tap(text("High"))
    await expect(device.element(id("selected-priority"))).toHaveText("Priority: High")
  })
})
