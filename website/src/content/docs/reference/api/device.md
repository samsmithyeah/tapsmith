---
title: Device
description: "Device-level actions: swipe, press keys, launch apps, manage permissions, and control device state."
---

The `Device` class is the primary interface for interacting with a mobile device. Test functions receive a `device` instance through the test fixtures.

In addition to the [locator methods](./locators/), `Device` provides device-level actions that don't target a specific element.

### `device.swipe(direction: string, options?: SwipeOptions): Promise<void>`

Perform a swipe gesture across the screen in the given direction.

```typescript
await device.swipe("up");
await device.swipe("left", { speed: 500, distance: 0.5 });
```

**SwipeOptions:**

| Option | Type | Description |
|---|---|---|
| `speed` | `number` | Swipe speed in pixels per second |
| `distance` | `number` | Swipe distance as a fraction of screen size (0-1) |
| `timeoutMs` | `number` | Override the default timeout |

### `device.pressKey(key: string): Promise<void>`

Press a device key.

```typescript
await device.pressKey("ENTER");
await device.pressKey("HOME");
await device.pressKey("VOLUME_UP");
```

### `device.pressBack(): Promise<void>` *(Android only)*

Press the Android back button. Convenience method equivalent to `device.pressKey("BACK")`.

```typescript
await device.pressBack();
```

### `device.takeScreenshot(): Promise<ScreenshotResponse>`

Capture a screenshot of the current device screen. Returns an object with `success`, `data` (PNG bytes), and `errorMessage` fields.

```typescript
const screenshot = await device.takeScreenshot();
```

### `device.waitForIdle(timeoutMs?: number): Promise<void>`

Wait until the device UI is idle (no animations, no pending layout passes). Uses the configured default timeout if none is specified.

```typescript
await device.waitForIdle();
await device.waitForIdle(5000);
```

### `device.installApk(apkPath: string): Promise<void>`

Install an APK on the connected device.

```typescript
await device.installApk("./app-debug.apk");
```

### `device.listDevices(): Promise<DeviceInfo[]>`

List all connected Android devices and emulators.

### `device.setDevice(serial: string): Promise<void>`

Target a specific device by its serial number.

```typescript
await device.setDevice("emulator-5554");
```

### `device.startAgent(targetPackage: string): Promise<void>`

Start the Tapsmith on-device agent for the given app package.

```typescript
await device.startAgent("com.myapp");
```

### `device.launchApp(packageName: string, options?: LaunchAppOptions): Promise<void>`

Launch an Android app by package name. This is the mobile equivalent of `page.goto(url)`.

```typescript
await device.launchApp("com.example.myapp");
await device.launchApp("com.example.myapp", { activity: ".MainActivity" });
await device.launchApp("com.example.myapp", { clearData: true }); // fresh start
await device.launchApp("com.example.myapp", { waitForIdle: false }); // return immediately
```

**Options:**
- `activity?` — specific Activity to launch (e.g., `".settings.ProfileActivity"`)
- `clearData?` — clear all app data before launching (default: `false`)
- `waitForIdle?` — wait for the UI to settle after launch (default: `true`)

### `device.openDeepLink(uri: string): Promise<void>`

Navigate to a screen via deep link URI.

```typescript
await device.openDeepLink("myapp://settings/profile");
await device.openDeepLink("https://example.com/product/123"); // app links
```

### `device.currentPackage(): Promise<string>`

Returns the package name of the foreground app.

```typescript
const pkg = await device.currentPackage(); // "com.example.myapp"
```

### `device.currentActivity(): Promise<string>` *(Android only)*

Returns the current activity name.

```typescript
const activity = await device.currentActivity(); // ".settings.ProfileActivity"
```

### `device.terminateApp(packageName: string): Promise<void>`

Force-stop an app.

```typescript
await device.terminateApp("com.example.myapp");
```

### `device.getAppState(packageName: string): Promise<AppState>`

Check the state of an app. Returns `"not_installed"`, `"stopped"`, `"background"`, or `"foreground"`.

```typescript
const state = await device.getAppState("com.example.myapp");
```

### `device.sendToBackground(): Promise<void>` *(Android only)*

Press the home button to send the current app to the background.

```typescript
await device.sendToBackground();
```

### `device.bringToForeground(packageName: string): Promise<void>`

Bring a backgrounded app back to the foreground.

```typescript
await device.bringToForeground("com.example.myapp");
```

### `device.restartApp(packageName: string, options?: { waitForIdle?: boolean }): Promise<void>`

Force-stops and relaunches the app without clearing persistent storage. Resets all in-memory state (React component state, navigation stack) while preserving data on disk (AsyncStorage, SQLite, SharedPreferences).

Use this in `beforeEach` hooks when tests modify in-memory state and you need isolation, but don't need a clean persistent state:

```typescript
beforeEach(async ({ device }) => {
  await device.restartApp("com.example.myapp")
  await device.getByDescription("Settings").tap()
  await expect(device.getByText("Settings", { exact: true })).toBeVisible()
})
```

**Options:**
- `waitForIdle?` — wait for the UI to settle after relaunch (default: `true`)

### `device.clearAppData(packageName: string): Promise<void>`

Clear all app data and cache, providing test isolation similar to Playwright's fresh browser context.

```typescript
await device.clearAppData("com.example.myapp");
```

### `device.saveAppState(packageName: string, path: string): Promise<void>`

Snapshot the app's data directory (`/data/data/<package>/`) — including SharedPreferences, databases, and internal files — and save it as a tar.gz archive on the host. The app is force-stopped before snapshotting to avoid data corruption.

Requires root (emulators) or a debuggable app (`run-as` fallback on physical devices).

```typescript
// Save authenticated state after login
await device.saveAppState("com.example.myapp", "./auth-state.tar.gz");
```

### `device.restoreAppState(packageName: string, path: string): Promise<void>`

Restore a previously saved app state archive. Clears the app's data first (`pm clear`), then extracts the archive, fixing file ownership and SELinux contexts when running as root.

```typescript
// Restore state instead of logging in again
await device.restoreAppState("com.example.myapp", "./auth-state.tar.gz");
```

### `device.grantPermission(packageName: string, permission: string): Promise<void>` *(Android only)*

Programmatically grant an Android runtime permission.

```typescript
await device.grantPermission("com.example.myapp", "android.permission.CAMERA");
await device.grantPermission("com.example.myapp", "android.permission.ACCESS_FINE_LOCATION");
```

### `device.revokePermission(packageName: string, permission: string): Promise<void>` *(Android only)*

Revoke a previously granted runtime permission.

```typescript
await device.revokePermission("com.example.myapp", "android.permission.CAMERA");
```

### `device.setClipboard(text: string): Promise<void>`

Set the device clipboard content.

```typescript
await device.setClipboard("Hello, world!");
```

### `device.getClipboard(): Promise<string>`

Read the current device clipboard content.

```typescript
const text = await device.getClipboard();
```

### `device.setOrientation(orientation: Orientation): Promise<void>`

Set the device orientation. Accepts `"portrait"` or `"landscape"`.

```typescript
await device.setOrientation("landscape");
await device.setOrientation("portrait");
```

### `device.getOrientation(): Promise<Orientation>`

Get the current device orientation.

```typescript
const orientation = await device.getOrientation(); // "portrait" | "landscape"
```

### `device.isKeyboardShown(): Promise<boolean>`

Check if the soft keyboard is currently visible.

```typescript
if (await device.isKeyboardShown()) {
  await device.hideKeyboard();
}
```

### `device.hideKeyboard(): Promise<void>`

Hide the soft keyboard if it is visible.

```typescript
await device.hideKeyboard();
```

### `device.wake(): Promise<void>`

Wake the device screen if it is off.

```typescript
await device.wake();
```

### `device.unlock(): Promise<void>`

Wake the screen and dismiss the lock screen. Works with non-secure lock screens (no PIN/pattern). Useful for CI and emulator setups.

```typescript
await device.unlock();
```

### `device.pressHome(): Promise<void>` *(Android only)*

Press the home button. Convenience method equivalent to `device.pressKey("HOME")`.

```typescript
await device.pressHome();
```

### `device.openNotifications(): Promise<void>` *(Android only)*

Pull down the notification shade.

```typescript
await device.openNotifications();
```

### `device.openQuickSettings(): Promise<void>` *(Android only)*

Pull down the quick settings panel.

```typescript
await device.openQuickSettings();
```

### `device.pressRecentApps(): Promise<void>` *(Android only)*

Open the recent apps screen. Convenience method equivalent to `device.pressKey("APP_SWITCH")`.

```typescript
await device.pressRecentApps();
```

### `device.setColorScheme(scheme: ColorScheme): Promise<void>` *(Android only)*

Set the system UI mode. Accepts `"dark"` or `"light"`.

```typescript
await device.setColorScheme("dark");
await device.setColorScheme("light");
```

### `device.getColorScheme(): Promise<ColorScheme>`

Get the current system color scheme.

```typescript
const scheme = await device.getColorScheme(); // "dark" | "light"
```

### `device.close(): void`

Close the gRPC connection to the daemon.
