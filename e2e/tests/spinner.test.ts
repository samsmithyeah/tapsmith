import { beforeAll, contentDesc, describe, expect, test } from "pilot"
import { SpinnerScreen } from "../screens/spinner.screen.js"

describe("Spinner screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Spinner"))
  })

  // ─── Dropdowns ───

  test("shows dropdown heading", async ({ device }) => {
    const screen = new SpinnerScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  test("country dropdown starts with no selection", async ({ device }) => {
    const screen = new SpinnerScreen(device)
    await expect(screen.countryDropdown).toBeVisible()
    await expect(screen.selectedCountry).toHaveText("Country: None")
  })

  test("tapping country dropdown opens options and allows selection", async ({ device }) => {
    const screen = new SpinnerScreen(device)
    await screen.countryDropdown.tap()
    await expect(screen.option("United States")).toBeVisible()
    await expect(screen.option("United Kingdom")).toBeVisible()
    await screen.option("Canada").tap()
    await expect(screen.selectedCountry).toHaveText("Country: Canada")
  })

  test("can select a color", async ({ device }) => {
    const screen = new SpinnerScreen(device)
    await screen.colorDropdown.tap()
    await screen.option("Blue").tap()
    await expect(screen.selectedColor).toHaveText("Color: Blue")
  })

  test("can select a priority", async ({ device }) => {
    const screen = new SpinnerScreen(device)
    await screen.priorityDropdown.tap()
    await screen.option("High").tap()
    await expect(screen.selectedPriority).toHaveText("Priority: High")
  })
})
