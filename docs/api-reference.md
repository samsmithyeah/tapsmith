# API Reference

Complete reference for all public APIs in the `pilot` package.

## Locators

Locators identify UI elements on the device. They are exposed as Playwright-style `getBy*` methods on `Device` and `ElementHandle`. Each method returns an `ElementHandle` — a lazy reference that resolves when an action or assertion runs against it.

See the [Selectors Guide](selectors.md) for a deeper discussion of when to use each one.

### `device.getByText(text: string, options?: { exact?: boolean }): ElementHandle`

Locate an element by its visible text. **Substring match by default**, like Playwright. Pass `{ exact: true }` for an exact match.

```typescript
device.getByText("Welcome")                          // substring
device.getByText("Sign In", { exact: true })         // exact
```

### `device.getByRole(role: string, options?: { name?: string }): ElementHandle`

Locate an element by its accessibility role, optionally filtered by accessible name.

```typescript
device.getByRole("button", { name: "Submit" })
device.getByRole("textfield", { name: "Email" })
device.getByRole("checkbox")
```

### `device.getByDescription(text: string): ElementHandle`

Locate an element by its accessibility description (Android `contentDescription`, iOS `accessibilityLabel`).

```typescript
device.getByDescription("Close menu")
device.getByDescription("Profile photo")
```

### `device.getByPlaceholder(text: string): ElementHandle`

Locate an input by its placeholder / hint text.

```typescript
device.getByPlaceholder("Enter your email")
device.getByPlaceholder("Search")
```

### `device.getByTestId(testId: string): ElementHandle`

Locate an element by its dedicated test identifier.

```typescript
device.getByTestId("submit-button")
```

### `device.locator(options: LocatorOptions): ElementHandle`

Escape hatch for native, non-accessible queries. Exactly one of `id`, `xpath`, or `className` must be set.

```typescript
device.locator({ id: "com.myapp:id/email_input" })
device.locator({ className: "com.myapp.widget.ColorPicker" })
// XPath is Android-only. Always include a comment explaining why.
device.locator({ xpath: "//android.widget.Button[@text='OK']" })
```

**LocatorOptions:**

| Option | Type | Description |
|---|---|---|
| `id` | `string` | Native resource id (Android `R.id.foo` or iOS `accessibilityIdentifier`). |
| `xpath` | `string` | XPath expression. Android-only. |
| `className` | `string` | Native widget class name. |

> The `getBy*` methods and `locator()` are also available on every `ElementHandle`. Calling them on a parent locator scopes the search to its descendants. See [ElementHandle Scoping](#scoping).

> **iOS wrapper suppression.** When traversing the iOS accessibility tree, Pilot drops `XCUIElementTypeOther` containers whose `accessibilityIdentifier`, `accessibilityLabel`, and visible text are all empty or fully duplicated by a descendant in the same subtree. This collapses the redundant wrappers React Native (and SwiftUI in some configurations) emit around interactive elements, so a `getByText("Submit")` resolves to the actual control rather than the surrounding container. If your native iOS app deliberately exposes a labeled `.other` container *and* labels its child with the same identifier, the outer wrapper will not be selectable — give the wrapper a unique `accessibilityIdentifier` (or use `device.locator({ id: ... })`) to address it directly.

---

## Device

The `Device` class is the primary interface for interacting with a mobile device. Test functions receive a `device` instance through the test fixtures.

In addition to the locator methods above, `Device` provides device-level actions that don't target a specific element.

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

Start the Pilot on-device agent for the given app package.

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

---

### Network Interception

Pilot supports Playwright-style network interception. Route handlers let you mock, modify, or abort HTTP/HTTPS requests made by the app under test.

#### `device.route(url, handler, options?): Promise<void>`

Intercept network requests matching a URL pattern.

- `url`: `string | RegExp | ((url: URL) => boolean)` — URL pattern (glob), regex, or predicate
- `handler`: `(route: Route) => Promise<void> | void` — handler that decides how to handle the request
- `options.times?`: `number` — how many times to intercept (then auto-remove)

```ts
await device.route('**/api/posts*', async (route) => {
  await route.fulfill({ json: [{ id: 1, title: 'Mocked' }] })
})
```

#### `device.unroute(url, handler?): Promise<void>`

Remove a previously registered route handler. If `handler` is omitted, all handlers for the pattern are removed.

#### `device.unrouteAll(): Promise<void>`

Remove all registered route handlers.

#### `device.waitForRequest(urlOrPredicate, options?): Promise<PilotRequest>`

Wait for a network request matching the pattern.

- `urlOrPredicate`: `string | RegExp | ((request: PilotRequest) => boolean)`
- `options.timeout?`: `number` — timeout in ms (default: device timeout)

#### `device.waitForResponse(urlOrPredicate, options?): Promise<NetworkResponseEventData>`

Wait for a network response matching the pattern.

#### `device.on(event, handler): void`

Subscribe to network events: `'request'` or `'response'`.

```ts
device.on('request', (req) => console.log(req.url))
device.on('response', (resp) => console.log(resp.status))
```

#### `device.off(event, handler): void`

Unsubscribe from network events.

### Route

The `Route` object is passed to route handlers. It provides methods to decide how to handle the intercepted request.

#### `route.request(): PilotRequest`

Returns the intercepted request.

#### `route.abort(errorCode?): Promise<void>`

Abort the request. Optional `errorCode`: `'connectionrefused'`, `'connectionreset'`, `'timedout'`.

#### `route.continue(overrides?): Promise<void>`

Continue the request to the server with optional modifications.

- `overrides.url?`: `string` — override the URL **path and query** (see limitation below)
- `overrides.method?`: `string` — override the HTTP method
- `overrides.headers?`: `Record<string, string>` — override headers
- `overrides.postData?`: `string | Buffer` — override request body

> **Known limitation:** `overrides.url` currently only swaps the path and query —
> the host stays the same (upstream TCP connection and `Host` header are
> unchanged). Cross-origin redirection via `route.continue()` is not yet
> supported. If you need to hit a different host, use `route.fetch({ url })`
> and then `route.fulfill()` with the result. Tracked in PILOT-189.

#### `route.fulfill(options?): Promise<void>`

Return a mock response without contacting the server.

- `options.status?`: `number` — HTTP status code (default: 200)
- `options.headers?`: `Record<string, string>` — response headers
- `options.body?`: `string | Buffer` — response body
- `options.contentType?`: `string` — content-type header
- `options.json?`: `unknown` — convenience: JSON-serializes and sets content-type
- `options.path?`: `string` — read body from a file

#### `route.fetch(overrides?): Promise<FetchedAPIResponse>`

Fetch the actual response from the server. Returns a `FetchedAPIResponse` that you can inspect and modify before calling `route.fulfill()`.

- `overrides.url?`: `string` — override the URL to fetch from. **Unlike `route.continue()`, this may target a different host** — the daemon opens an independent connection to the override URL's host/port/scheme
- `overrides.method?`: `string` — override the HTTP method
- `overrides.headers?`: `Record<string, string>` — override headers
- `overrides.postData?`: `string | Buffer` — override request body

```ts
await device.route('**/api/users/*', async (route) => {
  const response = await route.fetch()
  const data = response.json()
  data.name = 'Modified'
  await route.fulfill({ json: data })
})
```

### PilotRequest

Properties: `method`, `url`, `headers`, `postData`, `isHttps`.

### FetchedAPIResponse

Returned by `route.fetch()`. Properties: `status`, `headers`. Methods: `body()`, `text()`, `json()`.

---

## ElementHandle

An `ElementHandle` is a lazy reference to a UI element. It is returned by every `device.getBy*()` and `device.locator()` call, and supports chaining, queries, actions, and positional selection.

### Scoping

`ElementHandle` exposes the same `getBy*` methods and `locator()` as `Device`. Calling any of them on an existing handle scopes the search to its descendants — exactly like Playwright's `locator.locator(...)`.

| Method | Description |
|---|---|
| `getByText(text, options?)` | Substring (default) or exact text match within the parent. |
| `getByRole(role, options?)` | Accessibility role within the parent. |
| `getByDescription(text)` | Accessibility description within the parent. |
| `getByPlaceholder(text)` | Placeholder / hint text within the parent. |
| `getByTestId(id)` | Test identifier within the parent. |
| `locator(options)` | Native id / xpath / className within the parent. |

Cannot be called on modified handles (e.g. after `.first()`, `.filter()`, `.and()`).

```typescript
const list = device.getByRole("list", { name: "Shopping cart" });
const item = list.getByText("Item 3", { exact: true });
await item.tap();

// Tap a delete button inside a specific row
await device.getByTestId("row-5").getByRole("button", { name: "Delete" }).tap();
```

### Positional Selection

#### `elementHandle.first(): ElementHandle`

Return a new handle targeting the first match. The handle is lazy -- it does not resolve until an action or assertion is performed.

```typescript
await device.getByRole("listitem").first().tap();
```

#### `elementHandle.last(): ElementHandle`

Return a new handle targeting the last match.

```typescript
await device.getByRole("listitem").last().tap();
```

#### `elementHandle.nth(index: number): ElementHandle`

Return a new handle targeting the match at the given 0-based index. Negative indices count from the end.

```typescript
await device.getByRole("listitem").nth(2).tap();
await device.getByRole("listitem").nth(-1).tap(); // last item
```

### Filtering

#### `elementHandle.filter(criteria: FilterOptions): ElementHandle`

Narrow matches by additional criteria without changing the selector. Returns a new lazy handle.

```typescript
const premiumItems = device.getByRole("listitem").filter({ hasText: "Premium" });
const count = await premiumItems.count();
```

**FilterOptions:**

| Option | Type | Description |
|---|---|---|
| `hasText` | `string \| RegExp` | Keep elements whose text contains this string or matches this RegExp |
| `hasNotText` | `string \| RegExp` | Exclude elements whose text contains this string or matches this RegExp |
| `has` | `ElementHandle` | Keep elements that have a descendant matching this locator |
| `hasNot` | `ElementHandle` | Exclude elements that have a descendant matching this locator |

### Combining Selectors

#### `elementHandle.and(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy both this and the other handle's selector (intersection). AND binds tighter than OR.

```typescript
const submitButton = device.getByRole("button").and(device.getByText("Submit", { exact: true }));
await submitButton.tap();
```

#### `elementHandle.or(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy either this or the other handle's selector (union).

```typescript
const acceptButton = device.getByText("OK", { exact: true }).or(device.getByText("Accept", { exact: true }));
await acceptButton.tap();
```

### Queries

#### `elementHandle.find(): Promise<ElementInfo>`

Resolve the handle to an `ElementInfo` object. Throws if the element is not found within the timeout.

The `ElementInfo` object contains:

| Property | Type | Description |
|---|---|---|
| `elementId` | `string` | Internal element identifier |
| `className` | `string` | Android class name |
| `text` | `string` | Visible text content |
| `contentDescription` | `string` | Accessibility content description |
| `resourceId` | `string` | Android resource ID |
| `enabled` | `boolean` | Whether the element is enabled |
| `visible` | `boolean` | Whether the element is visible |
| `clickable` | `boolean` | Whether the element is clickable |
| `focusable` | `boolean` | Whether the element is focusable |
| `scrollable` | `boolean` | Whether the element is scrollable |
| `hint` | `string` | Input hint text |
| `checked` | `boolean` | Whether the element is checked |
| `selected` | `boolean` | Whether the element is selected |
| `focused` | `boolean` | Whether the element has input focus |
| `role` | `string` | Accessibility role (e.g. "button", "textfield") |
| `viewportRatio` | `number` | Fraction of element visible in viewport (0.0-1.0) |
| `bounds` | `Bounds` | Element bounding rectangle |

#### `elementHandle.exists(): Promise<boolean>`

Returns `true` if the element exists in the current UI hierarchy.

```typescript
const exists = await device.getByText("Optional banner", { exact: true }).exists();
```

#### `elementHandle.count(): Promise<number>`

Return the number of elements matching the selector.

```typescript
const itemCount = await device.getByRole("listitem").count();
```

#### `elementHandle.all(): Promise<ElementHandle[]>`

Return an array of `ElementHandle` instances, one for each matching element. Useful for iterating over a list of elements.

```typescript
const items = await device.getByRole("listitem").all();
for (const item of items) {
  const info = await item.find();
  console.log(info.text);
}
```

### Actions

#### `elementHandle.tap(): Promise<void>`

Tap this element.

```typescript
await device.getByRole("button", { name: "Submit" }).tap();
```

#### `elementHandle.doubleTap(): Promise<void>`

Double-tap this element.

```typescript
await device.getByText("Zoom here", { exact: true }).doubleTap();
```

#### `elementHandle.longPress(durationMs?: number): Promise<void>`

Long press this element.

```typescript
await device.getByText("Item 1", { exact: true }).longPress(2000);
```

#### `elementHandle.type(text: string): Promise<void>`

Type text into this element.

```typescript
await device.getByPlaceholder("Email").type("user@example.com");
```

> **Control characters.** `\n`, `\t`, and `\b` are dispatched as
> `KEYCODE_ENTER` / `KEYCODE_TAB` / `KEYCODE_DEL` key events on Android
> and the equivalent key events on iOS. Notably `\b` is **destructive**
> — `type("foo\bbar")` deletes the `o` and types `bar`, ending with
> `fobar`. CR (`\r`) is dropped (Android keyboards send `\n` for the
> Enter key). Other ASCII control codes below `0x20` are dropped with
> a one-shot warning log.

#### `elementHandle.clearAndType(text: string): Promise<void>`

Clear existing text and type new text.

```typescript
await device.locator({ id: "search_box" }).clearAndType("new query");
```

#### `elementHandle.clear(): Promise<void>`

Clear the text content of this element.

```typescript
await device.locator({ id: "search_box" }).clear();
```

> **iOS very-long-field ceiling.** On iOS, `clear()` first attempts
> Cmd+A + Delete; if that misses (common on React Native wrapped
> controls), it falls back to a per-character backspace loop capped at
> 16 iterations × 256 keystrokes = 4096 backspaces. A field with more
> than ~4000 grapheme clusters of content will throw `actionFailed`
> rather than partially clearing. The cap exists so a misbehaving
> field can't hang the agent. Android uses the native `UiObject2.clear()`
> API and isn't subject to this limit.

#### `elementHandle.scroll(direction: string, options?: { distance?: number }): Promise<void>`

Scroll this element in the given direction.

```typescript
await device.getByRole("list").scroll("down", { distance: 300 });
```

#### `elementHandle.scrollIntoView(options?: { direction?: string; maxScrolls?: number; speed?: number }): Promise<void>`

Scroll the viewport until this element is visible on screen. Useful for reaching elements that are below the fold in a scrollable container.

Swipes in the given direction, checking visibility between each attempt. Throws if the element is not visible after `maxScrolls` attempts.

| Option | Default | Description |
|---|---|---|
| `direction` | `"up"` | Swipe direction. `"up"` scrolls down (reveals content below), `"down"` scrolls up (reveals content above). |
| `maxScrolls` | `5` | Maximum swipe attempts before throwing |
| `speed` | `2000` | Swipe speed in pixels/second |

```typescript
// Scroll down until the "Settings" card is visible, then tap it
await device.getByDescription("Settings").scrollIntoView();
await device.getByDescription("Settings").tap();

// Scroll up (reverse direction)
await device.getByText("Top Section", { exact: true }).scrollIntoView({ direction: "down" });
```

#### `elementHandle.dragTo(target: ElementHandle): Promise<void>`

Drag this element to a target element.

```typescript
const source = device.getByText("Item 1", { exact: true });
const target = device.getByText("Drop Zone", { exact: true });
await source.dragTo(target);
```

#### `elementHandle.setChecked(checked: boolean): Promise<void>`

Ensure a checkbox, switch, or radio button is in the desired state. Idempotent -- only taps if the current state differs from the desired state, and verifies the state changed after tapping.

```typescript
await device.getByRole("switch", { name: "Dark Mode" }).setChecked(true);
await device.getByRole("checkbox", { name: "Remember me" }).setChecked(false);
```

#### `elementHandle.selectOption(option: string | { index: number }): Promise<void>`

Select an option from a native spinner or dropdown. Abstracts the tap-spinner, wait-for-popup, tap-option pattern into a single action.

```typescript
await device.getByRole("combobox").selectOption("Option 2");
await device.getByRole("combobox").selectOption({ index: 1 });
```

#### `elementHandle.focus(): Promise<void>`

Programmatically focus this element. For text fields, this shows the keyboard.

```typescript
await device.getByRole("textfield", { name: "Email" }).focus();
```

#### `elementHandle.blur(): Promise<void>`

Remove focus from this element by tapping outside its bounds.

```typescript
await device.getByRole("textfield", { name: "Email" }).blur();
```

#### `elementHandle.pinchIn(options?: { scale?: number }): Promise<void>`

Perform a pinch-in (zoom out) gesture on this element.

```typescript
await device.getByText("Map", { exact: true }).pinchIn();
await device.getByText("Map", { exact: true }).pinchIn({ scale: 0.3 });
```

#### `elementHandle.pinchOut(options?: { scale?: number }): Promise<void>`

Perform a pinch-out (zoom in) gesture on this element.

```typescript
await device.getByText("Map", { exact: true }).pinchOut();
await device.getByText("Map", { exact: true }).pinchOut({ scale: 3.0 });
```

#### `elementHandle.highlight(options?: { durationMs?: number }): Promise<void>`

Highlight this element for debugging. Validates that the element exists and is accessible.

```typescript
await device.getByRole("button", { name: "Submit" }).highlight();
```

#### `elementHandle.screenshot(): Promise<Buffer>`

Capture a screenshot cropped to this element's bounding box. Returns a `Buffer` containing PNG image data.

```typescript
const png = await device.getByRole("image", { name: "Profile" }).screenshot();
```

### Info Accessors

#### `elementHandle.getText(): Promise<string>`

Get the visible text content of this element.

```typescript
const label = await device.locator({ id: "status_label" }).getText();
```

#### `elementHandle.isVisible(): Promise<boolean>`

Check whether this element is visible on screen.

```typescript
const visible = await device.getByText("Error", { exact: true }).isVisible();
```

#### `elementHandle.isEnabled(): Promise<boolean>`

Check whether this element is enabled (interactive).

```typescript
const enabled = await device.getByRole("button", { name: "Submit" }).isEnabled();
```

#### `elementHandle.isChecked(): Promise<boolean>`

Check whether this checkbox, switch, or radio button is in the checked state.

```typescript
const checked = await device.getByRole("switch", { name: "Notifications" }).isChecked();
```

#### `elementHandle.inputValue(): Promise<string>`

Get the current value of an input field. On Android, this returns the element's text property.

```typescript
const value = await device.getByRole("textfield", { name: "Email" }).inputValue();
```

#### `elementHandle.boundingBox(): Promise<BoundingBox | null>`

Get the element's position and dimensions. Returns `null` if the element has no bounds.

```typescript
const box = await device.getByText("Header", { exact: true }).boundingBox();
// Returns: { x: number, y: number, width: number, height: number }
```

---

## Assertions

The `expect()` function creates assertions for an `ElementHandle` or a plain value. Locator assertions auto-wait by polling until the condition is met or the timeout expires.

### `expect(elementHandle: ElementHandle): PilotAssertions`

Create an assertion object for the given element handle.

```typescript
await expect(device.getByText("Hello", { exact: true })).toBeVisible();
```

### `expect(value: unknown): GenericAssertions`

Create a generic assertion for a plain value (non-ElementHandle). These are synchronous and do not auto-wait.

```typescript
expect(5).toBe(5);
expect("hello").toContain("ell");
expect([1, 2, 3]).toHaveLength(3);
```

### `expect.soft(elementHandle: ElementHandle): PilotAssertions`

Create a soft assertion that records failures without stopping the test. Failures are collected and can be flushed at the end.

```typescript
expect.soft(device.getByText("Header", { exact: true })).toBeVisible();
expect.soft(device.getByText("Footer", { exact: true })).toBeVisible();
// Test continues even if assertions fail

const errors = flushSoftErrors();
// errors contains any failures from soft assertions
```

### `expect.poll(fn: () => unknown | Promise<unknown>, options?: PollOptions): GenericAssertions`

Poll an async function until the assertion passes or the timeout expires. Useful for waiting on values that change over time.

```typescript
await expect.poll(async () => {
  const el = await device.getByRole("listitem").count();
  return el;
}).toBe(5);

await expect.poll(() => fetchStatus(), { timeout: 10000 }).toBe("ready");
```

**PollOptions:**

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | 5000 | How long to poll before failing |
| `intervals` | `number[]` | `[250]` | Polling intervals in milliseconds |

### `flushSoftErrors(): Error[]`

Retrieve and clear all soft assertion failures collected by `expect.soft()`.

```typescript
const errors = flushSoftErrors();
if (errors.length > 0) {
  console.log(`${errors.length} soft assertions failed`);
}
```

### `.not`

Negate the following assertion.

```typescript
await expect(device.getByText("Loading...", { exact: true })).not.toBeVisible();
```

### Locator Assertions

All locator assertions accept an optional `options` object:

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | Element's timeout (default 30s) | How long to wait for the condition |
| `ratio` | `number` | `0` | (toBeInViewport only) Minimum fraction of element visible in viewport |

#### `.toBeVisible(options?): Promise<void>`

Assert that the element is visible on screen. With `.not`, waits for the element to disappear.

```typescript
await expect(device.getByText("Welcome", { exact: true })).toBeVisible();
await expect(device.getByText("Spinner", { exact: true })).not.toBeVisible();

// Custom timeout
await expect(device.getByText("Welcome", { exact: true })).toBeVisible({ timeout: 10000 });
```

#### `.toBeEnabled(options?): Promise<void>`

Assert that the element is enabled (interactive).

```typescript
await expect(device.getByRole("button", { name: "Submit" })).toBeEnabled();
await expect(device.getByRole("button", { name: "Submit" })).not.toBeEnabled();
```

#### `.toBeDisabled(options?): Promise<void>`

Assert that the element is disabled (not interactive). More expressive than `.not.toBeEnabled()`.

```typescript
await expect(device.getByRole("button", { name: "Submit" })).toBeDisabled();
```

#### `.toBeChecked(options?): Promise<void>`

Assert that a checkbox, switch, or radio button is in the checked state.

```typescript
await expect(device.getByRole("switch", { name: "Dark Mode" })).toBeChecked();
await expect(device.getByRole("checkbox")).not.toBeChecked();
```

#### `.toBeHidden(options?): Promise<void>`

Assert that the element is not visible on screen (either not in the hierarchy or has visibility=false). More expressive than `.not.toBeVisible()`.

```typescript
await expect(device.getByText("Loading...", { exact: true })).toBeHidden();
```

#### `.toBeEmpty(options?): Promise<void>`

Assert that the element has no text content or is an empty input field. The agents normalize text-input fields so a placeholder/hint is not reported as text — `toBeEmpty()` after `clear()` passes even when the placeholder is still drawn.

> **Android API < 26 limitation.** The precise placeholder-vs-value distinction uses `AccessibilityNodeInfo.isShowingHintText()` and `getHintText()`, both of which are only available from API 26 (Android 8.0). On API 21–25 we cannot tell whether a textfield is displaying its placeholder or a real typed value, so `toBeEmpty()` after `clear()` may incorrectly report the field as non-empty (it sees the placeholder text). Bump `minSdk` to 26 if your tests rely on this behavior. iOS is unaffected.

```typescript
await expect(device.getByRole("textfield", { name: "Search" })).toBeEmpty();
```

#### `.toBeFocused(options?): Promise<void>`

Assert that the element currently has accessibility/input focus.

```typescript
await device.getByRole("textfield", { name: "Email" }).tap();
await expect(device.getByRole("textfield", { name: "Email" })).toBeFocused();
```

#### `.toBeEditable(options?): Promise<void>`

Assert that the element is an editable input field (a text field that is enabled).

```typescript
await expect(device.getByRole("textfield", { name: "Name" })).toBeEditable();
await expect(device.getByRole("textfield", { name: "ID" })).not.toBeEditable(); // read-only
```

#### `.toBeInViewport(options?): Promise<void>`

Assert that the element is currently within the visible screen area. Different from `toBeVisible()` which checks the visibility property -- this checks if the element's bounds intersect with the screen bounds.

```typescript
await expect(device.getByText("Footer", { exact: true })).toBeInViewport();
await expect(device.getByText("Footer", { exact: true })).toBeInViewport({ ratio: 0.5 }); // at least 50% visible
```

#### `.toHaveText(expected: string, options?): Promise<void>`

Assert that the element's text content matches the expected string exactly.

```typescript
await expect(device.locator({ id: "counter" })).toHaveText("42");
```

#### `.toContainText(expected: string | RegExp, options?): Promise<void>`

Assert that the element's text contains the given substring or matches a regex. Unlike `toHaveText()` which requires an exact match, this allows partial matching.

When the matched element has no own text (e.g. a wrapping `View` around `<Text>` children, common in React Native), the agents aggregate descendant text/labels so the assertion sees the visible string.

```typescript
await expect(device.getByTestId("status")).toContainText("Success");
await expect(device.getByTestId("status")).toContainText(/\d+ items/);
```

#### `.toHaveCount(count: number, options?): Promise<void>`

Assert that the selector resolves to exactly N elements.

```typescript
await expect(device.getByRole("listitem")).toHaveCount(5);
await expect(device.getByText("Error", { exact: true })).toHaveCount(0);
```

#### `.toHaveAttribute(name: string, value: unknown, options?): Promise<void>`

Assert that the element has a specific property/attribute value. For Android, this maps to view properties like `className`, `resourceId`, `contentDescription`, `enabled`, `clickable`, `focusable`, `scrollable`, `selected`, etc.

```typescript
await expect(device.getByText("Item", { exact: true })).toHaveAttribute("selected", true);
await expect(device.getByText("Item", { exact: true })).toHaveAttribute("className", "android.widget.TextView");
```

#### `.toHaveAccessibleName(name: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible name. On Android, this is the `contentDescription` if set, otherwise the `text` property.

```typescript
await expect(device.getByRole("button")).toHaveAccessibleName("Submit form");
await expect(device.getByRole("image")).toHaveAccessibleName(/Profile/);
```

#### `.toHaveAccessibleDescription(description: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible description. On Android, this maps to the `hint` property.

```typescript
await expect(device.getByRole("image")).toHaveAccessibleDescription("Profile photo");
```

#### `.toHaveRole(role: string, options?): Promise<void>`

Assert that the element has a specific accessibility role.

The role is derived from a framework-set role description first (React Native's `accessibilityRole`, the `isHeading` flag, the `UIAccessibilityTraitHeader` trait, etc.) and falls back to the platform's class/element-type mapping. `"header"` and `"heading"` are accepted as aliases on both platforms.

```typescript
await expect(device.getByText("Submit", { exact: true })).toHaveRole("button");
await expect(device.getByTestId("toggle")).toHaveRole("switch");
await expect(device.getByText("Section title", { exact: true })).toHaveRole("heading");
```

#### `.toHaveValue(value: string, options?): Promise<void>`

Assert that an input field contains a specific value.

```typescript
await device.getByRole("textfield", { name: "Email" }).type("test@example.com");
await expect(device.getByRole("textfield", { name: "Email" })).toHaveValue("test@example.com");
```

#### `.toExist(options?): Promise<void>`

Assert that the element exists in the UI hierarchy (regardless of visibility).

```typescript
await expect(device.getByTestId("hidden-input")).toExist();
await expect(device.getByText("Deleted item", { exact: true })).not.toExist();
```

### Generic Value Assertions

When `expect()` receives a non-ElementHandle value, it returns `GenericAssertions` with synchronous Jest-style matchers. All support `.not` for negation.

| Assertion | Description |
|---|---|
| `.toBe(expected)` | Strict equality using `Object.is` |
| `.toEqual(expected)` | Deep equality |
| `.toStrictEqual(expected)` | Deep equality with type checking |
| `.toBeTruthy()` | Value is truthy |
| `.toBeFalsy()` | Value is falsy |
| `.toBeDefined()` | Value is not `undefined` |
| `.toBeUndefined()` | Value is `undefined` |
| `.toBeNull()` | Value is `null` |
| `.toBeNaN()` | Value is `NaN` |
| `.toContain(expected)` | String/array contains item |
| `.toContainEqual(expected)` | Array contains item matching deep equality |
| `.toHaveLength(expected)` | Value has `.length` equal to expected |
| `.toHaveProperty(path, value?)` | Value has property at path, optionally with value |
| `.toMatch(expected)` | String matches regex or string pattern |
| `.toMatchObject(expected)` | Object matches subset of properties |
| `.toBeGreaterThan(expected)` | Number is greater than expected |
| `.toBeGreaterThanOrEqual(expected)` | Number is greater than or equal to expected |
| `.toBeLessThan(expected)` | Number is less than expected |
| `.toBeLessThanOrEqual(expected)` | Number is less than or equal to expected |
| `.toBeCloseTo(expected, numDigits?)` | Number is close to expected within precision |
| `.toBeInstanceOf(expected)` | Value is instance of class |
| `.toThrow(expected?)` | Function throws, optionally matching message |

```typescript
expect(result).toBe(42);
expect(items).toHaveLength(3);
expect(name).toMatch(/^[A-Z]/);
expect(config).toMatchObject({ debug: true });
expect(() => parse("bad")).toThrow("Invalid");
```

---

## Test Runner

Pilot includes a built-in test runner with an API inspired by Jest and Playwright.

### `test(name: string, fn: (fixtures: TestFixtures) => Promise<void>): void`

Register a test. The test function receives a `fixtures` object containing a `device` instance.

```typescript
test("user can log in", async ({ device }) => {
  await device.getByText("Sign In", { exact: true }).tap();
});
```

### `test.only(name, fn)`

Run only this test (and other tests marked with `.only`). All other tests are skipped.

```typescript
test.only("focused test", async ({ device }) => {
  // Only this test will run
});
```

### `test.skip(name, fn)`

Skip this test.

```typescript
test.skip("broken test", async ({ device }) => {
  // This test will not run
});
```

### `test.use(options: UseOptions): void`

Override configuration options for all tests in the current describe scope. Overrides cascade — inner describe blocks inherit and can further override outer ones.

```typescript
describe("slow animations screen", () => {
  test.use({ timeout: 60000 })

  test("animation completes", async ({ device }) => {
    // runs with 60s timeout instead of the default
  })
})
```

Multiple calls in the same scope merge together:

```typescript
describe("custom config", () => {
  test.use({ timeout: 60000 })
  test.use({ screenshot: "always" })
  // equivalent to: test.use({ timeout: 60000, screenshot: "always" })
})
```

**`UseOptions`**

| Option       | Type                                        | Description                                  |
| ------------ | ------------------------------------------- | -------------------------------------------- |
| `timeout`    | `number`                                    | Action/assertion timeout (ms)                |
| `screenshot` | `'always' \| 'only-on-failure' \| 'never'` | Screenshot capture mode                      |
| `retries`    | `number`                                    | Retry count for failed tests                 |
| `trace`      | `TraceMode \| Partial<TraceConfig>`         | Trace recording configuration. See [configuration.md](./configuration.md#traceconfig) for the full `TraceConfig` shape (includes `network`, `networkHosts`, `networkIgnoreHosts`, `screenshots`, etc.). |
| `appState`   | `string`                                    | Path to saved app state archive to restore   |

The following device-shaping fields may **only** be set on a project's
`use` block (not via `test.use()`), since the device is bound to the
worker before any test runs:

| Option            | Type                                  | Description                              |
| ----------------- | ------------------------------------- | ---------------------------------------- |
| `platform`        | `'android' \| 'ios'`                  | Target platform for this project         |
| `device`          | `string`                              | Explicit device serial / iOS UDID        |
| `avd`             | `string`                              | Android AVD name to launch               |
| `simulator`       | `string`                              | iOS simulator name or UDID               |
| `apk`             | `string`                              | Path to Android APK under test           |
| `app`             | `string`                              | Path to iOS .app bundle under test       |
| `package`         | `string`                              | Android package name / iOS bundle ID     |
| `activity`        | `string`                              | Optional Android launcher activity       |
| `agentApk`        | `string`                              | Override path to the Android agent APK   |
| `agentTestApk`    | `string`                              | Override path to the Android agent test APK |
| `iosXctestrun`    | `string`                              | Override path to the iOS .xctestrun file |
| `deviceStrategy`  | `'prefer-connected' \| 'avd-only'`    | Device selection strategy (Android)      |
| `launchEmulators` | `boolean`                             | Auto-launch emulators (Android)          |
| `resetAppDeepLink`| `string`                              | Soft-reset deep link between files       |
| `resetAppWaitMs`  | `number`                              | Wait after the reset deep link           |

**Reusable auth state** — mirrors Playwright's `storageState`:

```typescript
// Setup: authenticate once and save state
test("authenticate", async ({ device }) => {
  await device.launchApp("com.example.myapp");
  // ... perform login flow ...
  await device.saveAppState("com.example.myapp", "./auth-state.tar.gz");
});

// Tests: restore state instead of logging in
describe("authenticated tests", () => {
  test.use({ appState: "./auth-state.tar.gz" });

  test("shows profile", async ({ device }) => {
    // Already logged in — no login flow needed
  });
});
```

### `describe(name: string, fn: () => void): void`

Group tests into a suite.

```typescript
describe("Login flow", () => {
  test("valid credentials", async ({ device }) => { /* ... */ });
  test("invalid credentials", async ({ device }) => { /* ... */ });
});
```

### `describe.only(name, fn)` / `describe.skip(name, fn)`

Focus or skip an entire suite.

### `beforeAll(fn: () => void | Promise<void>): void`

Run a function once before all tests in the current suite.

```typescript
beforeAll(async () => {
  // Set up shared state
});
```

### `afterAll(fn: () => void | Promise<void>): void`

Run a function once after all tests in the current suite.

### `beforeEach(fn: () => void | Promise<void>): void`

Run a function before each test in the current suite. Hooks are inherited by nested suites.

```typescript
beforeEach(async () => {
  // Reset app state
});
```

### `afterEach(fn: () => void | Promise<void>): void`

Run a function after each test in the current suite. Runs even if the test fails.

---

## API Request Fixture

The `request` fixture provides HTTP request methods for making API calls during tests. Useful for seeding test data, fetching auth tokens, or verifying backend state without going through the UI. Modeled after Playwright's `APIRequestContext`.

### Usage

The `request` fixture is built-in and available in every test alongside `device`:

```typescript
test("shows created item", async ({ device, request }) => {
  // Seed data via API
  await request.post("https://api.example.com/items", {
    data: { name: "Test Item", price: 9.99 },
    headers: { Authorization: "Bearer ..." },
  });

  // Verify it shows in the app
  await device.getByText("Refresh").tap();
  await expect(device.getByText("Test Item")).toBeVisible();
});
```

### `request.get(url, options?)`
### `request.post(url, options?)`
### `request.put(url, options?)`
### `request.patch(url, options?)`
### `request.delete(url, options?)`
### `request.head(url, options?)`

Send an HTTP request. Returns a `PilotAPIResponse`. **Does not throw on non-2xx responses** (matching Playwright's behavior) — check `.ok` or `.status` instead.

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | URL (absolute, or relative to `baseURL` if configured) |
| `options.data` | `unknown` | Request body. Objects are JSON-serialized automatically with `Content-Type: application/json`. |
| `options.headers` | `Record<string, string>` | Per-request headers (override `extraHTTPHeaders`). |
| `options.params` | `Record<string, string> \| URLSearchParams` | Query parameters appended to the URL. |
| `options.form` | `Record<string, string>` | Form-encoded body (sets `Content-Type: application/x-www-form-urlencoded`). |
| `options.timeout` | `number` | Per-request timeout in milliseconds. |

### `request.fetch(url, options?)`

Send a request with an explicit method via `options.method`. Defaults to `GET`.

### `PilotAPIResponse`

| Property / Method | Type | Description |
|---|---|---|
| `.status` | `number` | HTTP status code |
| `.statusText` | `string` | HTTP status text |
| `.ok` | `boolean` | `true` for 2xx status codes |
| `.url` | `string` | Final response URL |
| `.headers` | `Headers` | Response headers |
| `.json()` | `Promise<unknown>` | Parse body as JSON |
| `.text()` | `Promise<string>` | Body as UTF-8 string |
| `.body()` | `Promise<Buffer>` | Raw body buffer |
| `.dispose()` | `void` | Explicit cleanup |

The response body is eagerly buffered, so `.json()`, `.text()`, and `.body()` can each be called multiple times.

### Configuration

Set `baseURL` and `extraHTTPHeaders` in your config or via `test.use()`:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  baseURL: "https://api.example.com",
  extraHTTPHeaders: {
    Authorization: "Bearer my-token",
  },
});
```

With `baseURL` configured, relative paths are resolved against it:

```typescript
// Resolves to https://api.example.com/users/1
const res = await request.get("/users/1");
```

Per-request headers override `extraHTTPHeaders` when names collide.

### Trace Integration

When tracing is enabled (`--trace on`), each `request.*()` call:
- Appears as an action event in the trace viewer's actions panel
- Generates a network entry visible in the Network tab (alongside device network traffic)

This gives full visibility into test-level API calls alongside device interactions.

---

## Configuration

### `defineConfig(overrides?: Partial<PilotConfig>): PilotConfig`

Create a Pilot configuration by merging overrides with defaults. Used in `pilot.config.ts`.

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  timeout: 15_000,
});
```

See the [Configuration](configuration.md) guide for all options.

### Projects

Projects group test files with shared options and dependency ordering, mirroring Playwright's project concept. Each project can target its own device by overriding device-shaping fields under `use:`. Setup projects run first; dependent projects run after their dependencies complete.

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  projects: [
    // Setup project: runs first
    { name: "setup", testMatch: ["**/auth.setup.ts"] },
    // Default tests: no dependencies, runs in parallel with setup
    { name: "default", testMatch: ["**/*.test.ts"] },
    // Authenticated tests: runs after setup, with restored app state
    {
      name: "authenticated",
      dependencies: ["setup"],
      use: { appState: "./pilot-results/auth-state.tar.gz" },
      testMatch: ["**/app-state.test.ts"],
    },
  ],
});
```

**Per-device targeting (Android + iOS):**

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  package: "com.example.app",
  projects: [
    {
      name: "Pixel 6",
      use: {
        platform: "android",
        avd: "Pixel_6_API_34",
        apk: "./android/app-debug.apk",
        launchEmulators: true,
      },
    },
    {
      name: "iPhone 16",
      use: {
        platform: "ios",
        simulator: "iPhone 16",
        app: "./ios/MyApp.app",
        iosXctestrun: "./ios-agent/PilotAgent.xctestrun",
      },
    },
  ],
});
```

Run with `pilot test --workers 2` to execute both projects in parallel
(one worker per device target). Run with `--workers 1` to run them
sequentially with a device switch between projects. Both `--ui` and
`--watch` honor per-project devices and route file execution to the
correct device.

**`ProjectConfig`**

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Unique project name |
| `testMatch` | `string[]` | Glob patterns for test files (inherits global if unset) |
| `testIgnore` | `string[]` | Glob patterns to exclude from test discovery |
| `dependencies` | `string[]` | Projects that must complete first |
| `use` | `UseOptions` | Per-project option overrides (applied under file-level `test.use()`). Includes the device-shaping fields documented above. |
| `workers` | `number` | Number of parallel workers (devices) for this project. Additive — does not consume from the global `workers` budget. When unset, the project shares the global budget proportionally to file count. |

### `loadConfig(dir?: string): Promise<PilotConfig>`

Load configuration from a `pilot.config.ts`, `pilot.config.js`, or `pilot.config.mjs` file. Falls back to defaults if no config file exists. This is used internally by the CLI.

---

## Tracing

The `device.tracing` API provides programmatic control over trace recording.

### `device.tracing.start(options?)`

Start tracing. All subsequent device actions will be recorded.

```typescript
await device.tracing.start();
await device.tracing.start({ screenshots: true, snapshots: true });
```

**Options:**
| Option | Type | Default | Description |
|---|---|---|---|
| `screenshots` | `boolean` | `true` | Capture before/after screenshots |
| `snapshots` | `boolean` | `true` | Capture view hierarchy XML |
| `sources` | `boolean` | `true` | Include test source files |
| `network` | `boolean` | `true` | Capture HTTP/HTTPS traffic via proxy |
| `title` | `string` | — | Custom title for the trace |

### `device.tracing.stop(options?)`

Stop tracing and optionally write the trace archive.

```typescript
// Stop and save
await device.tracing.stop({ path: 'traces/my-test.zip' });

// Stop and discard
await device.tracing.stop();
```

Returns the path to the created zip file, or `undefined` if no path was specified.

### `device.tracing.group(name)` / `device.tracing.groupEnd()`

Group actions in the trace viewer for better organization.

```typescript
device.tracing.group('Login flow');
await device.getByText('Username', { exact: true }).tap();
await device.getByText('Username', { exact: true }).type('admin');
await device.getByRole('button', { name: 'Sign In' }).tap();
device.tracing.groupEnd();
```

### `device.tracing.startChunk(options?)` / `device.tracing.stopChunk(options?)`

Start a new trace chunk. Useful for splitting long test runs into multiple trace files.

```typescript
await device.tracing.startChunk();
// ... actions ...
await device.tracing.stopChunk({ path: 'traces/chunk-1.zip' });

await device.tracing.startChunk();
// ... more actions ...
await device.tracing.stopChunk({ path: 'traces/chunk-2.zip' });
```

---

## Reporters

Pilot includes a reporter system inspired by Playwright. Reporters receive lifecycle events during a test run and produce output in various formats.

### Configuration

Configure reporters in `pilot.config.ts`:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  // Single reporter
  reporter: "list",

  // Reporter with options
  reporter: ["json", { outputFile: "results.json" }],

  // Multiple reporters
  reporter: ["list", ["json", { outputFile: "results.json" }]],
});
```

**Auto-detection:** When `reporter` is not set, Pilot uses `list` for local runs and `dot` for CI (detected via the `CI` environment variable). The `github` reporter is automatically added when running in GitHub Actions.

### Built-in reporters

| Reporter | Description | Default |
| --- | --- | --- |
| `list` | Detailed per-test output with status, name, and duration | Local runs |
| `line` | Concise single-line output, overwrites previous line | — |
| `dot` | Minimal output: one character per test (`·` / `F` / `×`) | CI runs |
| `json` | Structured JSON file with full test data | — |
| `junit` | JUnit XML for CI system ingestion | — |
| `html` | Self-contained interactive HTML report | — |
| `github` | GitHub Actions annotations on failures | Auto in GH Actions |
| `blob` | Serialized data for shard merging | — |

### Reporter options

**`json`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFile` | `string` | `"pilot-results/results.json"` |

**`junit`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFile` | `string` | `"pilot-results/results.xml"` |

**`html`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFolder` | `string` | `"pilot-report"` |
| `open` | `"always" \| "never" \| "on-failure"` | `"on-failure"` |

**`blob`**

| Option | Type | Default |
| --- | --- | --- |
| `outputDir` | `string` | `"blob-report"` |

### Custom reporters

Implement the `PilotReporter` interface:

```typescript
import type { PilotReporter, FullResult } from "pilot";
import type { TestResult } from "pilot";

class MyReporter implements PilotReporter {
  onRunStart(config, fileCount) {
    console.log(`Running ${fileCount} test files`);
  }

  onTestEnd(test: TestResult) {
    console.log(`${test.status}: ${test.fullName}`);
  }

  onRunEnd(result: FullResult) {
    console.log(`Done in ${result.duration}ms`);
  }
}

export default MyReporter;
```

Use by path in config:

```typescript
export default defineConfig({
  reporter: [["./my-reporter.ts", {}]],
});
```

### `PilotReporter` interface

All types are importable from `"pilot"`:

```typescript
import type {
  PilotReporter,
  FullResult,
  PilotConfig,
  TestResult,
  SuiteResult,
} from "pilot";
```

```typescript
interface PilotReporter {
  onRunStart?(config: PilotConfig, fileCount: number): void;
  onTestFileStart?(filePath: string): void;
  onTestEnd?(test: TestResult): void;
  onTestFileEnd?(filePath: string, results: TestResult[]): void;
  onRunEnd?(result: FullResult): Promise<void> | void;
  onError?(error: Error): void;
}
```

### `TestResult`

```typescript
interface TestResult {
  name: string;
  fullName: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: Error;
  screenshotPath?: string;
  tracePath?: string; // path to the trace archive (.zip) when tracing is enabled
  workerIndex?: number; // set in parallel mode — index of the worker that ran this test
}
```

### `SuiteResult`

```typescript
interface SuiteResult {
  name: string;
  durationMs: number;
  tests: TestResult[];
  suites: SuiteResult[]; // nested describe() blocks
}
```

### `FullResult`

```typescript
interface FullResult {
  status: "passed" | "failed";
  duration: number; // total wall-clock time in milliseconds (including setup)
  setupDuration?: number; // time spent on device provisioning, APK install, agent startup
  tests: TestResult[]; // flattened list of all test results
  suites: SuiteResult[]; // hierarchical suite tree (one per test file)
}
```

When `setupDuration` is present, console reporters show a timing breakdown:

```
Summary: 12 passed | 45.2s (setup 30.1s, tests 15.1s)
```

---

## CLI

### `pilot test [files...]`

Run test files. If no files are specified, discovers tests using the `testMatch` patterns from your config.

```bash
npx pilot test
npx pilot test tests/login.test.ts tests/signup.test.ts
```

### `pilot test --device <serial>` / `pilot test -d <serial>`

Target a specific device by its ADB serial number. This is mainly useful for
single-device debugging or reproducing an issue on one known device.

```bash
npx pilot test --device emulator-5554
```

For multi-worker emulator runs, prefer config-based provisioning with
`workers`, `launchEmulators`, and `avd`.

### `pilot test --workers <n>` / `pilot test -j <n>`

Run tests in parallel across `n` devices. Each worker gets its own device/emulator and daemon instance. Tests are distributed via a work-stealing queue for natural load balancing.

```bash
npx pilot test --workers 4
npx pilot test -j 2
```

Overrides the `workers` config option. Requires enough connected devices or `launchEmulators: true` with an `avd` configured. In parallel mode, each test result includes a `workerIndex` field and console reporters show `[worker N]` tags.

### `pilot test --shard=x/y`

Split the test suite deterministically across `y` machines, running only shard `x`. Shards are assigned by file index (`file_index % total === current - 1`).

```bash
# In a CI matrix with 4 jobs:
npx pilot test --shard=1/4
npx pilot test --shard=2/4
npx pilot test --shard=3/4
npx pilot test --shard=4/4
```

When sharding is active, the `blob` reporter is automatically added so results can be merged later with `pilot merge-reports`.

### `pilot show-trace <file.zip>`

Open the trace viewer in the default browser to inspect a recorded trace.

```bash
npx pilot show-trace test-results/traces/trace-my_test.zip
```

The trace viewer shows:
- **Actions panel** — chronological list of actions with icons, selectors, and durations
- **Timeline filmstrip** — screenshot thumbnails for quick navigation
- **Screenshot panel** — before/after screenshots with tap coordinate overlays
- **Detail tabs** — Call info, Console output, Source code, View hierarchy, Network requests, Errors
- **Keyboard navigation** — Arrow keys or j/k to move between actions

### `pilot test --trace <mode>`

Record traces during test execution. Overrides the `trace` config option.

```bash
npx pilot test --trace on                    # Record all tests
npx pilot test --trace retain-on-failure     # Only keep traces for failures
```

### `pilot test --network` / `pilot test --no-network`

Enable or disable network capture when tracing. By default, network capture is enabled whenever tracing is active. Use `--no-network` to disable it.

```bash
npx pilot test --trace on --no-network      # Trace without network capture
```

### `pilot merge-reports [dir]`

Merge blob reports from sharded CI runs into a single HTML report.

```bash
# After collecting all shard blob-report/ directories:
npx pilot merge-reports           # reads from blob-report/
npx pilot merge-reports ./blobs   # custom directory
```

### `pilot show-report [dir]`

Open the HTML test report in the default browser.

```bash
npx pilot show-report               # opens pilot-report/index.html
npx pilot show-report ./my-report   # custom directory
```

### iOS physical-device commands

These commands support running tests on USB-attached iPhones/iPads. See
[docs/ios-physical-devices.md](./ios-physical-devices.md) for the full
setup walkthrough.

#### `pilot list-devices [--json]`

Print a table of every device Pilot can target right now — Android (ADB),
iOS simulators (simctl), and iOS physical (devicectl) — with a one-line
status (`Ready` or an imperative fix). `--json` emits the row model for
scripting.

#### `pilot setup-ios-device [udid]`

Run the per-device preflight checklist for a physical iOS device: pairing,
Developer Mode, Developer Disk Image, USB transport, built agent cache,
firewall stealth mode, and the Xcode 26 CoreDevice sudo prompt probe.
Prints per-check `ok`/`fix` output and exits non-zero if anything blocks
`pilot test`. With no UDID, auto-selects the single attached device.

#### `pilot build-ios-agent [--team <id>] [--device|--simulator]`

Build the signed `PilotAgent` XCUITest bundle for the current device /
provisioning profile. Auto-detects the Apple Developer team ID from Xcode's
preferences (or keychain) if `--team` is omitted. The resulting
`.xctestrun` is cached under `~/.pilot/` and picked up automatically by
`pilot test`.

#### `pilot configure-ios-network <udid> [--ssid <name>] [--device-name <name>]`

Generate a `.mobileconfig` profile that routes the physical device's Wi-Fi
traffic through Pilot's MITM proxy for decrypted HTTPS capture, and reveal
it in Finder so you can AirDrop it to the device. `--ssid` targets a
specific Wi-Fi network (defaults to the host's current SSID); `--device-name`
sets the profile's `PayloadDisplayName`.

#### `pilot refresh-ios-network <udid>`

Regenerate the profile for a device whose host IP or Wi-Fi SSID has
changed since the last run. Same shape as `configure-ios-network` — the
difference is only wording in the output.

#### `pilot verify-ios-network <udid>`

End-to-end sanity check that the installed profile plus the trusted CA
actually produce decrypted HTTPS capture. Starts the proxy, asks you to
load an HTTPS page in Safari on the device, then reports whether Pilot
saw the request and could decrypt the body. Exits non-zero on failure
with fix-it hints for each failure mode.

### `pilot --version` / `pilot -v`

Print the Pilot version.

### `pilot --help` / `pilot -h`

Show help text with available commands and options.
