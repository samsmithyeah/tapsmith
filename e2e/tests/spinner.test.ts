import { describe, expect, test } from "../fixtures.js"

describe("Spinner screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///spinner")
  })

  // ─── Dropdowns ───

  test("shows dropdown heading", async ({ spinnerScreen }) => {
    await expect(spinnerScreen.heading).toBeVisible()
  })

  test("country dropdown starts with no selection", async ({ spinnerScreen }) => {
    await expect(spinnerScreen.countryDropdown).toBeVisible()
    await expect(spinnerScreen.selectedCountry).toHaveText("Country: None")
  })

  test("tapping country dropdown opens options and allows selection", async ({ spinnerScreen }) => {
    await spinnerScreen.countryDropdown.tap()
    await expect(spinnerScreen.option("United States")).toBeVisible()
    await expect(spinnerScreen.option("United Kingdom")).toBeVisible()
    await spinnerScreen.option("Canada").tap()
    await expect(spinnerScreen.selectedCountry).toHaveText("Country: Canada")
  })

  test("can select a color", async ({ spinnerScreen }) => {
    await spinnerScreen.colorDropdown.tap()
    await spinnerScreen.option("Blue").tap()
    await expect(spinnerScreen.selectedColor).toHaveText("Color: Blue")
  })

  test("can select a priority", async ({ spinnerScreen }) => {
    await spinnerScreen.priorityDropdown.tap()
    await spinnerScreen.option("High").tap()
    await expect(spinnerScreen.selectedPriority).toHaveText("Priority: High")
  })
})
