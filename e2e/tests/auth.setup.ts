import path from "node:path"
import { test, expect } from "../fixtures.js"

const PKG = "dev.tapsmith.testapp"

// ─── Auth setup: log in once and save state ───
// Mirrors Playwright's auth.setup.ts pattern.
// When running under a named project (e.g. "android:auth-setup"),
// the state file is per-project so multiple platforms can run in parallel.
test.use({ timeout: 180_000 })

test("authenticate and save app state", async ({ device, projectName, loginScreen }) => {
  const suffix = projectName ? `-${projectName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""
  const statePath = path.join(process.cwd(), "tapsmith-results", `auth-state${suffix}.tar.gz`)

  // Session preflight already cleared data and launched the app fresh.
  await device.openDeepLink("tapsmithtest:///login")

  await loginScreen.emailField.clearAndType("test@example.com")
  await loginScreen.passwordField.clearAndType("password123")
  await device.hideKeyboard()
  await loginScreen.signInButton.tap()

  // Verify login succeeded
  await expect(device.getByText("Login successful!", { exact: true })).toBeVisible()

  // Save authenticated state — like Playwright's storageState()
  await device.saveAppState(PKG, statePath)
})
