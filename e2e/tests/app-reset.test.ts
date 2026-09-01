import type { Device } from "tapsmith"
import { test, describe, expect } from "../fixtures.js"
import type { LoginScreen } from "../screens/login.screen"

/**
 * The reset ladder end to end against the test app, which mounts
 * `@tapsmith/react-native`: warm in-app resets are acknowledged, land on the
 * requested route, and fall back honestly when warm delivery is impossible.
 */
describe("App reset (declared isolation)", () => {
  // These tests exercise resets explicitly; a per-test reset in front of them
  // would only add noise to the timings they assert on.
  test.use({ appReset: "none" })

  test.beforeAll(async ({ device }) => {
    await device.resetApp({ target: "/" })
  })

  async function signIn(device: Device, loginScreen: LoginScreen) {
    await device.openDeepLink("tapsmithtest:///login")
    await loginScreen.emailField.clearAndType("test@example.com")
    await loginScreen.passwordField.clearAndType("password123")
    await device.hideKeyboard()
    await loginScreen.signInButton.tap()
    await expect(device.getByText("Login successful!", { exact: true })).toBeVisible()
  }

  test("a warm reset is acknowledged by the in-app hooks and signs the user out", async ({ device, loginScreen }) => {
    await signIn(device, loginScreen)

    const before = await device.getByTestId("tapsmith-hooks").getText()
    const epochBefore = Number(/epoch=(\d+)/.exec(before ?? "")?.[1] ?? "-1")
    expect(epochBefore).toBeGreaterThanOrEqual(0)

    const result = await device.resetApp({ target: "/" })

    expect(result.hooksDetected).toBe(true)
    expect(result.modeUsed).toBe("warm")
    expect(result.fellBack).toBe(false)
    // Generous bound: a warm reset takes ~1s, a clear+relaunch 5-10s even on
    // cold software-GPU CI emulators — this only has to tell the two apart.
    expect(result.durationMs).toBeLessThan(15_000)
    expect(result.epochAfter).toBe(epochBefore + 1)
    // Cleared AsyncStorage + in-memory auth: the profile gate redirects to login.
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })

  test("a warm reset lands on the requested route", async ({ device }) => {
    const result = await device.resetApp({ target: "/gestures" })
    expect(result.modeUsed).toBe("warm")
    await expect(device.getByText("Gestures", { exact: true }).first()).toBeVisible()
  })

  test("falls back to a restart when the app is not running", async ({ device }) => {
    await device.terminateApp()
    const result = await device.resetApp({ mode: "warm", fallback: true })
    expect(["restart", "clear"]).toContain(result.modeUsed)
    expect(result.fellBack).toBe(true)
    // The exact phrasing is the daemon's to choose; what matters is that the
    // fallback carries a human-readable reason at all.
    expect(result.reason).toBeTruthy()
    await expect(device.getByText("Test Screens", { exact: true })).toBeVisible()
  })

  test("a restart keeps persisted data; a clear wipes it", async ({ device, loginScreen }) => {
    await signIn(device, loginScreen)

    const restart = await device.resetApp({ mode: "restart", fallback: false })
    expect(restart.modeUsed).toBe("restart")
    expect(restart.coldLaunch).toBe(true)
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Authenticated", { exact: true })).toBeVisible()

    const clear = await device.resetApp({ mode: "clear", fallback: false })
    expect(clear.modeUsed).toBe("clear")
    await device.openDeepLink("tapsmithtest:///profile")
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()
  })
})
