import { describe, test, expect } from "pilot"

const PKG = "dev.pilot.testapp"

// ─── Tests that use the project-level appState (restored auth) ───
// The "authenticated" project sets appState in the config, so the runner
// restores auth state at the start of this file.

test("profile is accessible when app state is restored", async ({ device }) => {
  await device.openDeepLink("pilottest:///profile")

  // appState restores auth, so the profile screen should be accessible
  await expect(device.getByText("Profile", { exact: true })).toBeVisible()
  await expect(device.getByText("test@example.com", { exact: true })).toBeVisible()
  await expect(device.getByText("Authenticated", { exact: true })).toBeVisible()
})

// ─── Override: opt OUT of restored auth for a single scope ───

describe("without auth", () => {
  test.use({ appState: "" })

  test("profile redirects to login when not authenticated", async ({ device }) => {
    await device.openDeepLink("pilottest:///profile")

    // appState: '' clears app data, so the profile gate should redirect to login
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })
})
