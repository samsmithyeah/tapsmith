import path from "node:path"
import { test, expect } from "pilot"
import { LoginScreen } from "../screens/login.screen.js"

const PKG = "dev.pilot.testapp"

// ─── Auth setup: log in once and save state ───
// Mirrors Playwright's auth.setup.ts pattern.
// When running under a named project (e.g. "android:auth-setup"),
// the state file is per-project so multiple platforms can run in parallel.

test("authenticate and save app state", async ({ device, projectName }) => {
  const suffix = projectName ? `-${projectName.replace(/[^a-zA-Z0-9]/g, "-")}` : ""
  const statePath = path.join(process.cwd(), "pilot-results", `auth-state${suffix}.tar.gz`)

  // Session preflight already cleared data and launched the app fresh.
  await device.getByDescription("Login Form").tap()

  const login = new LoginScreen(device)
  await login.emailField.clearAndType("test@example.com")
  await login.passwordField.clearAndType("password123")
  await device.hideKeyboard()
  await login.signInButton.tap()

  // Verify login succeeded
  await expect(device.getByText("Login successful!", { exact: true })).toBeVisible()

  // Save authenticated state — like Playwright's storageState()
  await device.saveAppState(PKG, statePath)
})
