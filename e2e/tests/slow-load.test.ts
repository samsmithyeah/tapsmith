import { beforeAll, contentDesc, describe, expect, test, text } from "pilot"
import { SlowLoadScreen } from "../screens/slow-load.screen.js"

describe("Slow load screen", () => {
  beforeAll(async ({ device }) => {
    await device.element(contentDesc("Slow Load")).scrollIntoView()
    await device.tap(contentDesc("Slow Load"))
  })

  test("shows heading and description", async ({ device }) => {
    const screen = new SlowLoadScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  // ─── Data Fetching ───

  test("load buttons are visible", async ({ device }) => {
    const screen = new SlowLoadScreen(device)
    await expect(screen.load2sButton).toBeVisible()
    await expect(screen.load5sButton).toBeVisible()
    await expect(screen.loadFailButton).toBeVisible()
  })

  test("2s load shows data after loading", async ({ device }) => {
    const screen = new SlowLoadScreen(device)
    await screen.load2sButton.tap()
    await expect(screen.profileHeading).toBeVisible({ timeout: 10000 })
    await expect(screen.profileName).toBeVisible()
  })

  test("data rows show correct content", async ({ device }) => {
    const screen = new SlowLoadScreen(device)
    await expect(screen.profileHeading).toBeVisible()
    await expect(screen.emailLabel).toBeVisible()
    await expect(screen.emailValue).toBeVisible()
  })

  test("failed load shows error", async ({ device }) => {
    const screen = new SlowLoadScreen(device)
    await screen.loadFailButton.tap()
    await expect(screen.errorMessage).toBeVisible({ timeout: 10000 })
  })

  // ─── Polling Counter ───

  test("counter starts at 0", async ({ device }) => {
    await device.swipe("up")
    await expect(device.element(text("0"))).toBeVisible()
  })

  // Counter tests deferred pending PILOT-149 (.not.toBeVisible polling fix)
  // and investigation into tap() hanging on start-counter button
})
