import path from "node:path"
import { describe, test, expect, text } from "pilot"

const PKG = "dev.pilot.testapp"
const STATE_PATH = path.join(process.cwd(), "pilot-results", "auth-state.tar.gz")

test("profile redirects to login when not authenticated", async ({ device }) => {
  await device.clearAppData(PKG)
  await device.launchApp(PKG)
  await device.openDeepLink("pilottest:///profile")

  // Without auth, the profile screen should redirect to login
  await expect(device.element(text("Sign In"))).toBeVisible()
})

// ─── Override: opt into restored auth for a single scope ───

describe("with restored auth", () => {
  test.use({ appState: STATE_PATH })

  test("profile is accessible when app state is restored", async ({ device }) => {
    await device.openDeepLink("pilottest:///profile")

    // appState restores auth, so the profile screen should be accessible
    await expect(device.element(text("Profile"))).toBeVisible()
    await expect(device.element(text("test@example.com"))).toBeVisible()
    await expect(device.element(text("Authenticated"))).toBeVisible()
  })
})
