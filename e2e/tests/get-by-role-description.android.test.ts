import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-656: React Native renders tab, progressbar and combobox as a generic
// android.view.View whose only role signal is a role description ("Tab",
// "Progress Bar", "Combo Box"). The snapshot reported those roles, but
// getByRole matched tab and progressbar by widget class only and compared the
// raw multi-word descriptions, so none of these locators found anything.
//
// Android-only: React Navigation gives its bottom tabs role "button" on iOS,
// so getByRole("tab") is not how an iOS suite finds them.
describe("getByRole for roles published as an RN role description", () => {
  test("getByRole('tab') finds React Navigation bottom tabs and switches tabs", async ({ device }) => {
    await openScreen(device, "/tabs")
    await expect(device.getByText("Library content", { exact: true })).toBeVisible()

    await expect(device.getByRole("tab")).toHaveCount(2)
    const settings = device.getByRole("tab", { name: "Settings" })
    await expect(settings).toHaveRole("tab")

    await settings.tap()
    await expect(device.getByText("Settings content", { exact: true })).toBeVisible()

    await device.getByRole("tab", { name: "Library" }).tap()
    await expect(device.getByText("Library content", { exact: true })).toBeVisible()
  })

  test("getByRole('progressbar') finds an RN progress bar", async ({ device }) => {
    await openScreen(device, "/accessibility")
    // Below the fold: off-screen RN views are not in the accessibility tree.
    const progress = device.getByRole("progressbar", { name: "Upload progress" })
    await progress.scrollIntoView()
    await expect(progress).toBeVisible()
    await expect(progress).toHaveRole("progressbar")
  })

  test("getByRole('combobox') finds an RN combo box", async ({ device }) => {
    await openScreen(device, "/spinner")
    const country = device.getByRole("combobox", { name: "Country" })
    await expect(country).toBeVisible()
    await expect(country).toHaveRole("combobox")
  })
})
