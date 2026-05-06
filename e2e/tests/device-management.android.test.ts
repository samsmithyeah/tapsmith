import { test, expect, describe } from "tapsmith"

const PKG = "dev.tapsmith.testapp"
const CAMERA_PERMISSION = "android.permission.CAMERA"

async function expectAppReady(device) {
  expect(await device.currentPackage()).toBe(PKG)
  expect(await device.getAppState(PKG)).toBe("foreground")
  await expect(device.getByText("Tapsmith Test App", { exact: true })).toBeVisible()
}

async function launchAppReady(device) {
  await device.launchApp(PKG)
  await device.openDeepLink("tapsmithtest:///")
  await expectAppReady(device)
}

// ─── Android-only device management tests ───
// These tests use APIs that are only available on Android.
// They are excluded from the iOS test suite via tapsmith.config.ios.mjs.

// ─── App Lifecycle (Android-specific) ───

describe("App lifecycle (Android)", () => {
  test("currentActivity() returns a non-empty activity", async ({ device }) => {
    await launchAppReady(device)
    const activity = await device.currentActivity()
    expect(activity.length).toBeGreaterThan(0)
  })

  test("sendToBackground() backgrounds the app", async ({ device }) => {
    await launchAppReady(device)
    await device.sendToBackground()
    expect(await device.getAppState(PKG)).toBe("background")

    await device.bringToForeground(PKG)
    await expectAppReady(device)
  })

  test("bringToForeground() brings a backgrounded app back", async ({ device }) => {
    await launchAppReady(device)
    await device.sendToBackground()
    expect(await device.getAppState(PKG)).toBe("background")

    await device.bringToForeground(PKG)
    await expectAppReady(device)
  })

  test("getAppState() returns 'not_installed' for unknown package", async ({ device }) => {
    const state = await device.getAppState("com.nonexistent.fake.app")
    expect(state).toBe("not_installed")
  })
})

// ─── Deep Links (Android-specific) ───

describe("Deep links (Android)", () => {
  test("navigate back after deep link", async ({ device }) => {
    await launchAppReady(device)
    await device.openDeepLink("tapsmithtest:///login")
    await expect(device.getByText("Sign In", { exact: true })).toBeVisible()

    await device.pressBack()
    await expectAppReady(device)
  })
})

// ─── Device Navigation ───

describe("Device navigation", () => {
  test("pressHome() goes to home screen and app can be relaunched", async ({ device }) => {
    await launchAppReady(device)
    await device.pressHome()

    expect(await device.getAppState(PKG)).toBe("background")
    expect(await device.currentPackage()).not.toBe(PKG)

    await launchAppReady(device)
  })

  test("openNotifications() opens notification shade and pressBack() closes it", async ({ device }) => {
    await launchAppReady(device)
    await device.openNotifications()
    await expect(device.getByText("Android System", { exact: true })).toBeVisible()

    await device.pressBack()
    await expectAppReady(device)
  })

  test("openQuickSettings() opens quick settings and pressBack() closes it", async ({ device }) => {
    await launchAppReady(device)
    await device.openQuickSettings()
    await expect(device.getByText("Internet", { exact: true })).toBeVisible()

    await device.pressBack()
    await device.pressBack()
    await expectAppReady(device)
  })

  test("pressRecentApps() opens recents without stopping the app", async ({ device }) => {
    await launchAppReady(device)
    await device.pressRecentApps()
    expect(await device.getAppState(PKG)).not.toBe("stopped")

    await launchAppReady(device)
  })
})

// ─── Color Scheme ───

describe("Color scheme", () => {
  test("setColorScheme() toggles dark and light mode", async ({ device }) => {
    await device.setColorScheme("dark")
    expect(await device.getColorScheme()).toBe("dark")

    await device.setColorScheme("light")
    expect(await device.getColorScheme()).toBe("light")
  })
})

// ─── Permissions ───

describe("Permissions", () => {
  test("grantPermission() grants camera permission to the app", async ({ device }) => {
    await device.revokePermission(PKG, CAMERA_PERMISSION)
    await device.grantPermission(PKG, CAMERA_PERMISSION)
    await device.openDeepLink("tapsmithtest:///permissions")

    await expect(device.getByText("Permissions", { exact: true })).toBeVisible()
    await device.locator({ id: "request-camera" }).tap()
    await expect(device.locator({ id: "camera-status" })).toContainText("granted")
  })

  test("revokePermission() revokes a runtime permission without disrupting the app", async ({ device }) => {
    await device.grantPermission(PKG, CAMERA_PERMISSION)
    await device.revokePermission(PKG, CAMERA_PERMISSION)
    expect(await device.getAppState(PKG)).not.toBe("not_installed")

    await launchAppReady(device)
  })
})

// ─── pressKey (Hardware) ───

describe("Key presses", () => {
  test("pressKey('VOLUME_UP') keeps the app running", async ({ device }) => {
    await launchAppReady(device)
    await device.pressKey("VOLUME_UP")
    expect(await device.getAppState(PKG)).toBe("foreground")
  })

  test("pressKey('VOLUME_DOWN') keeps the app running", async ({ device }) => {
    await launchAppReady(device)
    await device.pressKey("VOLUME_DOWN")
    expect(await device.getAppState(PKG)).toBe("foreground")
  })
})

// ─── App Data ───

describe("App data", () => {
  test("clearAppData() clears app data, app can be relaunched", async ({ device }) => {
    await device.clearAppData(PKG)
    expect(await device.getAppState(PKG)).toBe("stopped")

    await launchAppReady(device)
  })
})
