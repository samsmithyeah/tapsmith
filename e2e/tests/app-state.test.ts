import { describe, test, expect, text } from "pilot"

// ─── Authenticated tests ───
// This file runs as part of the "authenticated" project, which has
// `dependencies: ['setup']` and `use: { appState: './pilot-results/auth-state.tar.gz' }`.
// The runner automatically restores app state before these tests —
// no manual login flow needed. Mirrors Playwright's storageState pattern.

test("profile screen is accessible without logging in", async ({ device }) => {
  // Navigate to the auth-gated profile screen (at bottom of home, needs scroll)
  await device.openDeepLink("pilottest:///profile")

  // Without restored auth, this would redirect to login.
  // With restored app state, we land directly on the profile.
  await expect(device.element(text("Profile"))).toBeVisible()
  await expect(device.element(text("test@example.com"))).toBeVisible()
  await expect(device.element(text("Authenticated"))).toBeVisible()
})

test("login screen shows authenticated state", async ({ device }) => {
  await device.openDeepLink("pilottest:///login")

  // Should show the logged-in view, not the sign-in form
  await expect(device.element(text("Login successful!"))).toBeVisible()
  await expect(device.element(text("Welcome, test@example.com"))).toBeVisible()
})

// ─── Override: opt out of restored auth for a single scope ───
// Mirrors Playwright's test.use({ storageState: { cookies: [], origins: [] } })

describe("without auth", () => {
  test.use({ appState: "" })

  test("profile redirects to login when app state is cleared", async ({ device }) => {
    await device.openDeepLink("pilottest:///profile")

    // appState: '' clears app data, so the profile gate should redirect to login
    await expect(device.element(text("Sign In"))).toBeVisible()
  })
})
