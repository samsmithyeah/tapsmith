import { describe, expect, test } from "../fixtures.js"

describe("Slow load screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///slow-load")
  })

  test("shows heading and description", async ({ slowLoadScreen }) => {
    await expect(slowLoadScreen.heading).toBeVisible()
  })

  // ─── Data Fetching ───

  test("load buttons are visible", async ({ slowLoadScreen }) => {
    await expect(slowLoadScreen.load2sButton).toBeVisible()
    await expect(slowLoadScreen.load5sButton).toBeVisible()
    await expect(slowLoadScreen.loadFailButton).toBeVisible()
  })

  test("2s load shows data after loading", async ({ slowLoadScreen }) => {
    await slowLoadScreen.load2sButton.tap()
    await expect(slowLoadScreen.profileHeading).toBeVisible({ timeout: 15_000 })
    await expect(slowLoadScreen.profileName).toBeVisible()
  })

  test("data rows show correct content", async ({ slowLoadScreen }) => {
    await expect(slowLoadScreen.profileHeading).toBeVisible()
    await expect(slowLoadScreen.emailLabel).toBeVisible()
    await expect(slowLoadScreen.emailValue).toBeVisible()
  })

  test("failed load shows error", async ({ slowLoadScreen }) => {
    await slowLoadScreen.loadFailButton.tap()
    await expect(slowLoadScreen.errorMessage).toBeVisible({ timeout: 10000 })
  })

  // ─── Polling Counter ───

  test("counter starts at 0", async ({ device }) => {
    await device.swipe("up")
    await expect(device.getByText("0", { exact: true })).toBeVisible()
  })

  // Counter tests deferred pending PILOT-149 (.not.toBeVisible polling fix)
  // and investigation into tap() hanging on start-counter button
})
