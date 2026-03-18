import { test, expect, describe } from "pilot"

const PKG = "dev.pilot.testapp"

// ─── Device Setup ───

describe("Device setup", () => {
  test("wake() wakes the device screen", async ({ device }) => {
    await device.wake()
  })

  test("unlock() dismisses the lock screen", async ({ device }) => {
    await device.unlock()
  })
})

// ─── App Lifecycle ───

describe("App lifecycle", () => {
  test("currentPackage() returns the foreground app", async ({ device }) => {
    const pkg = await device.currentPackage()
    expect(pkg).toBe(PKG)
  })

  test("currentActivity() returns a non-empty activity", async ({ device }) => {
    const activity = await device.currentActivity()
    expect(activity.length).toBeGreaterThan(0)
  })

  test("getAppState() returns 'foreground' for active app", async ({ device }) => {
    const state = await device.getAppState(PKG)
    expect(state).toBe("foreground")
  })

  test("sendToBackground() backgrounds the app", async ({ device }) => {
    await device.sendToBackground()
    const state = await device.getAppState(PKG)
    expect(state).toBe("background")
  })

  test("bringToForeground() brings the app back", async ({ device }) => {
    await device.bringToForeground(PKG)
    const state = await device.getAppState(PKG)
    expect(state).toBe("foreground")
  })

  test("terminateApp() stops the app", async ({ device }) => {
    await device.terminateApp(PKG)
    const state = await device.getAppState(PKG)
    expect(state).toBe("stopped")
  })

  test("getAppState() returns 'not_installed' for unknown package", async ({ device }) => {
    const state = await device.getAppState("com.nonexistent.fake.app")
    expect(state).toBe("not_installed")
  })

  test("launchApp() with clearData starts fresh", async ({ device }) => {
    await device.launchApp(PKG, { clearData: true })
    const pkg = await device.currentPackage()
    expect(pkg).toBe(PKG)
  })
})

// ─── Deep Links ───

describe("Deep links", () => {
  test("openDeepLink() navigates to a screen", async ({ device }) => {
    await device.openDeepLink("pilottest:///login")
  })

  test("navigate back after deep link", async ({ device }) => {
    await device.pressBack()
  })
})

// ─── Orientation ───

describe("Orientation", () => {
  test("setOrientation('landscape') changes to landscape", async ({ device }) => {
    await device.setOrientation("landscape")
    const orientation = await device.getOrientation()
    expect(orientation).toBe("landscape")
  })

  test("setOrientation('portrait') restores portrait", async ({ device }) => {
    await device.setOrientation("portrait")
    const orientation = await device.getOrientation()
    expect(orientation).toBe("portrait")
  })
})

// ─── Keyboard ───

describe("Keyboard", () => {
  test("isKeyboardShown() returns false when no keyboard visible", async ({ device }) => {
    await device.pressHome()
    const shown = await device.isKeyboardShown()
    expect(shown).toBe(false)
  })

  test("hideKeyboard() does not throw when no keyboard is shown", async ({ device }) => {
    await device.hideKeyboard()
  })
})

// ─── Device Navigation ───

describe("Device navigation", () => {
  test("pressHome() goes to home screen", async ({ device }) => {
    await device.launchApp(PKG)
    await device.pressHome()
    const pkg = await device.currentPackage()
    expect(pkg).not.toBe(PKG)
  })

  test("openNotifications() opens notification shade", async ({ device }) => {
    await device.openNotifications()
  })

  test("pressBack() closes notification shade", async ({ device }) => {
    await device.pressBack()
  })

  test("openQuickSettings() opens quick settings", async ({ device }) => {
    await device.openQuickSettings()
  })

  test("pressBack() closes quick settings", async ({ device }) => {
    await device.pressBack()
  })

  test("pressRecentApps() opens recents", async ({ device }) => {
    await device.pressRecentApps()
    await device.pressBack()
  })
})

// ─── Color Scheme ───

describe("Color scheme", () => {
  test("setColorScheme('dark') enables dark mode", async ({ device }) => {
    await device.setColorScheme("dark")
    const scheme = await device.getColorScheme()
    expect(scheme).toBe("dark")
  })

  test("setColorScheme('light') restores light mode", async ({ device }) => {
    await device.setColorScheme("light")
    const scheme = await device.getColorScheme()
    expect(scheme).toBe("light")
  })
})

// ─── Permissions ───

describe("Permissions", () => {
  test("grantPermission() grants a runtime permission", async ({ device }) => {
    await device.grantPermission(PKG, "android.permission.CAMERA")
  })

  test("revokePermission() revokes a runtime permission", async ({ device }) => {
    await device.revokePermission(PKG, "android.permission.CAMERA")
  })
})

// ─── Clipboard ───

describe("Clipboard", () => {
  test("setClipboard() + getClipboard() round-trips text", async ({ device }) => {
    await device.launchApp(PKG)
    await device.setClipboard("Pilot E2E clipboard test!")
    const clipText = await device.getClipboard()
    expect(clipText).toBe("Pilot E2E clipboard test!")
  })
})

// ─── waitForIdle ───

describe("Wait for idle", () => {
  test("waitForIdle() completes without error", async ({ device }) => {
    await device.waitForIdle()
  })

  test("waitForIdle() with custom timeout", async ({ device }) => {
    await device.waitForIdle(5000)
  })
})

// ─── pressKey ───

describe("Key presses", () => {
  test("pressKey('VOLUME_UP') does not throw", async ({ device }) => {
    await device.pressKey("VOLUME_UP")
  })

  test("pressKey('VOLUME_DOWN') does not throw", async ({ device }) => {
    await device.pressKey("VOLUME_DOWN")
  })
})

// ─── App Data ───

describe("App data", () => {
  test("clearAppData() clears app data, app can be relaunched", async ({ device }) => {
    await device.clearAppData(PKG)
    const state = await device.getAppState(PKG)
    expect(state).toBe("stopped")

    // clearAppData stops the app — relaunch to leave a clean state
    await device.launchApp(PKG)
    const pkg = await device.currentPackage()
    expect(pkg).toBe(PKG)
  })
})
