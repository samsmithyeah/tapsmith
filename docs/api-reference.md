# API Reference

Complete reference for all public APIs in the `pilot` package.

## Selectors

Selectors identify UI elements on the device. All selector functions return a `Selector` object that can be passed to device actions and assertions.

Every `Selector` has a `.within(parent)` method that returns a new selector scoped to descendants of the parent.

### `role(roleName: string, name?: string): Selector`

Match by accessibility role, optionally filtered by accessible name.

```typescript
role("button", "Submit")
role("textfield", "Email")
role("checkbox")
```

### `text(exactText: string): Selector`

Match by exact visible text content.

```typescript
text("Sign In")
text("Welcome back")
```

### `textContains(partial: string): Selector`

Match when the element's text contains the given substring.

```typescript
textContains("Welcome")
textContains("3 items")
```

### `contentDesc(desc: string): Selector`

Match by accessibility content description.

```typescript
contentDesc("Close menu")
contentDesc("Profile photo")
```

### `hint(hintText: string): Selector`

Match by input hint text (placeholder).

```typescript
hint("Enter your email")
hint("Search")
```

### `className(name: string): Selector`

Match by Android class name.

```typescript
className("com.myapp.widget.ColorPicker")
```

### `testId(id: string): Selector`

Match by test identifier.

```typescript
testId("submit-button")
```

### `id(resourceId: string): Selector`

Match by Android resource ID.

```typescript
id("com.myapp:id/email_input")
id("email_input")
```

### `xpath(expr: string): Selector`

Match by XPath expression on the view hierarchy.

```typescript
xpath("//android.widget.Button[@text='OK']")
```

### `Selector.within(parent: Selector): Selector`

Scope this selector within a parent element. Returns a new `Selector`.

```typescript
const deleteBtn = role("button", "Delete").within(testId("row-5"));
```

---

## Device

The `Device` class is the primary interface for interacting with a mobile device. Test functions receive a `device` instance through the test fixtures.

### `device.element(selector: Selector): ElementHandle`

Returns a lazy `ElementHandle` for the given selector. The element is not resolved until an action or assertion is performed on it.

```typescript
const el = device.element(text("Hello"));
await el.tap();
```

### `device.tap(selector: Selector): Promise<void>`

Tap an element. Auto-waits for the element to be visible, enabled, and stable.

```typescript
await device.tap(text("Sign In"));
await device.tap(role("button", "Submit"));
```

### `device.doubleTap(selector: Selector): Promise<void>`

Double-tap an element. The mobile equivalent of double-click.

```typescript
await device.doubleTap(text("Zoom here"));
```

### `device.longPress(selector: Selector, durationMs?: number): Promise<void>`

Long press an element. The duration defaults to the system long-press duration if not specified.

```typescript
await device.longPress(text("Item 1"));
await device.longPress(text("Item 1"), 2000); // 2 seconds
```

### `device.type(selector: Selector, text: string): Promise<void>`

Focus a text input and type text into it.

```typescript
await device.type(id("email_input"), "user@example.com");
```

### `device.clearAndType(selector: Selector, text: string): Promise<void>`

Clear existing text in an input field, then type new text.

```typescript
await device.clearAndType(id("email_input"), "new@example.com");
```

### `device.drag(options: DragOptions): Promise<void>`

Drag from one element to another.

```typescript
await device.drag({ from: text("Item 1"), to: text("Drop Zone") });
```

**DragOptions:**

| Option | Type | Description |
|---|---|---|
| `from` | `Selector` | Source element to drag from |
| `to` | `Selector` | Target element to drag to |

### `device.selectOption(selector: Selector, option: string | { index: number }): Promise<void>`

Select an option from a native spinner or dropdown.

```typescript
await device.selectOption(role("combobox"), "Option 2");
await device.selectOption(role("combobox"), { index: 1 });
```

### `device.focus(selector: Selector): Promise<void>`

Programmatically focus an element. For text fields, this shows the keyboard.

```typescript
await device.focus(role("textfield", "Email"));
```

### `device.blur(selector: Selector): Promise<void>`

Remove focus from an element by tapping outside its bounds.

```typescript
await device.blur(role("textfield", "Email"));
```

### `device.highlight(selector: Selector, options?: { durationMs?: number }): Promise<void>`

Highlight an element for debugging. Validates that the element exists and is accessible.

```typescript
await device.highlight(role("button", "Submit"));
```

### `device.swipe(direction: string, options?: SwipeOptions): Promise<void>`

Perform a swipe gesture in the given direction.

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

### `device.scroll(selector: Selector, direction: string, options?: ScrollOptions): Promise<void>`

Scroll a scrollable container in the given direction.

```typescript
await device.scroll(role("list"), "down");
await device.scroll(id("my_list"), "down", { distance: 300 });
```

**ScrollOptions:**

| Option | Type | Description |
|---|---|---|
| `distance` | `number` | Scroll distance in pixels |
| `timeoutMs` | `number` | Override the default timeout |

### `device.pinchIn(selector: Selector, options?: PinchOptions): Promise<void>`

Perform a pinch-in (zoom out) gesture on an element.

```typescript
await device.pinchIn(text("Map"));
await device.pinchIn(text("Map"), { scale: 0.3 });
```

### `device.pinchOut(selector: Selector, options?: PinchOptions): Promise<void>`

Perform a pinch-out (zoom in) gesture on an element.

```typescript
await device.pinchOut(text("Map"));
await device.pinchOut(text("Map"), { scale: 3.0 });
```

**PinchOptions:**

| Option | Type | Description |
|---|---|---|
| `scale` | `number` | Zoom scale factor. Defaults to 0.5 for pinchIn, 2.0 for pinchOut |

### `device.pressKey(key: string): Promise<void>`

Press a device key.

```typescript
await device.pressKey("ENTER");
await device.pressKey("HOME");
await device.pressKey("VOLUME_UP");
```

### `device.pressBack(): Promise<void>`

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

### `device.currentActivity(): Promise<string>`

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

### `device.sendToBackground(): Promise<void>`

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
  await device.tap(contentDesc("Settings"))
  await expect(device.element(text("Settings"))).toBeVisible()
})
```

**Options:**
- `waitForIdle?` — wait for the UI to settle after relaunch (default: `true`)

### `device.clearAppData(packageName: string): Promise<void>`

Clear all app data and cache, providing test isolation similar to Playwright's fresh browser context.

```typescript
await device.clearAppData("com.example.myapp");
```

### `device.grantPermission(packageName: string, permission: string): Promise<void>`

Programmatically grant an Android runtime permission.

```typescript
await device.grantPermission("com.example.myapp", "android.permission.CAMERA");
await device.grantPermission("com.example.myapp", "android.permission.ACCESS_FINE_LOCATION");
```

### `device.revokePermission(packageName: string, permission: string): Promise<void>`

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

### `device.pressHome(): Promise<void>`

Press the home button. Convenience method equivalent to `device.pressKey("HOME")`.

```typescript
await device.pressHome();
```

### `device.openNotifications(): Promise<void>`

Pull down the notification shade.

```typescript
await device.openNotifications();
```

### `device.openQuickSettings(): Promise<void>`

Pull down the quick settings panel.

```typescript
await device.openQuickSettings();
```

### `device.pressRecentApps(): Promise<void>`

Open the recent apps screen. Convenience method equivalent to `device.pressKey("APP_SWITCH")`.

```typescript
await device.pressRecentApps();
```

### `device.setColorScheme(scheme: ColorScheme): Promise<void>`

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

## ElementHandle

An `ElementHandle` is a lazy reference to a UI element. It is returned by `device.element()` and supports chaining, queries, actions, and positional selection.

### Scoping

#### `elementHandle.element(childSelector: Selector): ElementHandle`

Scope a child selector within this element. Returns a new `ElementHandle`.

Cannot be called on modified handles (e.g. after `.first()`, `.filter()`, `.and()`).

```typescript
const list = device.element(role("list", "Shopping cart"));
const item = list.element(text("Item 3"));
await item.tap();
```

### Positional Selection

#### `elementHandle.first(): ElementHandle`

Return a new handle targeting the first match. The handle is lazy -- it does not resolve until an action or assertion is performed.

```typescript
await device.element(role("listitem")).first().tap();
```

#### `elementHandle.last(): ElementHandle`

Return a new handle targeting the last match.

```typescript
await device.element(role("listitem")).last().tap();
```

#### `elementHandle.nth(index: number): ElementHandle`

Return a new handle targeting the match at the given 0-based index. Negative indices count from the end.

```typescript
await device.element(role("listitem")).nth(2).tap();
await device.element(role("listitem")).nth(-1).tap(); // last item
```

### Filtering

#### `elementHandle.filter(criteria: FilterOptions): ElementHandle`

Narrow matches by additional criteria without changing the selector. Returns a new lazy handle.

```typescript
const premiumItems = device.element(role("listitem")).filter({ hasText: "Premium" });
const count = await premiumItems.count();
```

**FilterOptions:**

| Option | Type | Description |
|---|---|---|
| `hasText` | `string \| RegExp` | Keep elements whose text contains this string or matches this RegExp |
| `hasNotText` | `string \| RegExp` | Exclude elements whose text contains this string or matches this RegExp |
| `has` | `Selector` | Keep elements that have a descendant matching this selector |
| `hasNot` | `Selector` | Exclude elements that have a descendant matching this selector |

### Combining Selectors

#### `elementHandle.and(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy both this and the other handle's selector (intersection). AND binds tighter than OR.

```typescript
const submitButton = device.element(role("button")).and(device.element(text("Submit")));
await submitButton.tap();
```

#### `elementHandle.or(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy either this or the other handle's selector (union).

```typescript
const acceptButton = device.element(text("OK")).or(device.element(text("Accept")));
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
const exists = await device.element(text("Optional banner")).exists();
```

#### `elementHandle.count(): Promise<number>`

Return the number of elements matching the selector.

```typescript
const itemCount = await device.element(role("listitem")).count();
```

#### `elementHandle.all(): Promise<ElementHandle[]>`

Return an array of `ElementHandle` instances, one for each matching element. Useful for iterating over a list of elements.

```typescript
const items = await device.element(role("listitem")).all();
for (const item of items) {
  const info = await item.find();
  console.log(info.text);
}
```

### Actions

#### `elementHandle.tap(): Promise<void>`

Tap this element.

```typescript
await device.element(role("button", "Submit")).tap();
```

#### `elementHandle.doubleTap(): Promise<void>`

Double-tap this element.

```typescript
await device.element(text("Zoom here")).doubleTap();
```

#### `elementHandle.longPress(durationMs?: number): Promise<void>`

Long press this element.

```typescript
await device.element(text("Item 1")).longPress(2000);
```

#### `elementHandle.type(text: string): Promise<void>`

Type text into this element.

```typescript
await device.element(hint("Email")).type("user@example.com");
```

#### `elementHandle.clearAndType(text: string): Promise<void>`

Clear existing text and type new text.

```typescript
await device.element(id("search_box")).clearAndType("new query");
```

#### `elementHandle.clear(): Promise<void>`

Clear the text content of this element.

```typescript
await device.element(id("search_box")).clear();
```

#### `elementHandle.scroll(direction: string, options?: { distance?: number }): Promise<void>`

Scroll this element in the given direction.

```typescript
await device.element(role("list")).scroll("down", { distance: 300 });
```

#### `elementHandle.dragTo(target: ElementHandle): Promise<void>`

Drag this element to a target element.

```typescript
const source = device.element(text("Item 1"));
const target = device.element(text("Drop Zone"));
await source.dragTo(target);
```

#### `elementHandle.setChecked(checked: boolean): Promise<void>`

Ensure a checkbox, switch, or radio button is in the desired state. Idempotent -- only taps if the current state differs from the desired state, and verifies the state changed after tapping.

```typescript
await device.element(role("switch", "Dark Mode")).setChecked(true);
await device.element(role("checkbox", "Remember me")).setChecked(false);
```

#### `elementHandle.selectOption(option: string | { index: number }): Promise<void>`

Select an option from a native spinner or dropdown. Abstracts the tap-spinner, wait-for-popup, tap-option pattern into a single action.

```typescript
await device.element(role("combobox")).selectOption("Option 2");
await device.element(role("combobox")).selectOption({ index: 1 });
```

#### `elementHandle.focus(): Promise<void>`

Programmatically focus this element. For text fields, this shows the keyboard.

```typescript
await device.element(role("textfield", "Email")).focus();
```

#### `elementHandle.blur(): Promise<void>`

Remove focus from this element by tapping outside its bounds.

```typescript
await device.element(role("textfield", "Email")).blur();
```

#### `elementHandle.pinchIn(options?: { scale?: number }): Promise<void>`

Perform a pinch-in (zoom out) gesture on this element.

```typescript
await device.element(text("Map")).pinchIn();
await device.element(text("Map")).pinchIn({ scale: 0.3 });
```

#### `elementHandle.pinchOut(options?: { scale?: number }): Promise<void>`

Perform a pinch-out (zoom in) gesture on this element.

```typescript
await device.element(text("Map")).pinchOut();
await device.element(text("Map")).pinchOut({ scale: 3.0 });
```

#### `elementHandle.highlight(options?: { durationMs?: number }): Promise<void>`

Highlight this element for debugging. Validates that the element exists and is accessible.

```typescript
await device.element(role("button", "Submit")).highlight();
```

#### `elementHandle.screenshot(): Promise<Buffer>`

Capture a screenshot cropped to this element's bounding box. Returns a `Buffer` containing PNG image data.

```typescript
const png = await device.element(role("image", "Profile")).screenshot();
```

### Info Accessors

#### `elementHandle.getText(): Promise<string>`

Get the visible text content of this element.

```typescript
const label = await device.element(id("status_label")).getText();
```

#### `elementHandle.isVisible(): Promise<boolean>`

Check whether this element is visible on screen.

```typescript
const visible = await device.element(text("Error")).isVisible();
```

#### `elementHandle.isEnabled(): Promise<boolean>`

Check whether this element is enabled (interactive).

```typescript
const enabled = await device.element(role("button", "Submit")).isEnabled();
```

#### `elementHandle.isChecked(): Promise<boolean>`

Check whether this checkbox, switch, or radio button is in the checked state.

```typescript
const checked = await device.element(role("switch", "Notifications")).isChecked();
```

#### `elementHandle.inputValue(): Promise<string>`

Get the current value of an input field. On Android, this returns the element's text property.

```typescript
const value = await device.element(role("textfield", "Email")).inputValue();
```

#### `elementHandle.boundingBox(): Promise<BoundingBox | null>`

Get the element's position and dimensions. Returns `null` if the element has no bounds.

```typescript
const box = await device.element(text("Header")).boundingBox();
// Returns: { x: number, y: number, width: number, height: number }
```

---

## Assertions

The `expect()` function creates assertions for an `ElementHandle` or a plain value. Locator assertions auto-wait by polling until the condition is met or the timeout expires.

### `expect(elementHandle: ElementHandle): PilotAssertions`

Create an assertion object for the given element handle.

```typescript
await expect(device.element(text("Hello"))).toBeVisible();
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
expect.soft(device.element(text("Header"))).toBeVisible();
expect.soft(device.element(text("Footer"))).toBeVisible();
// Test continues even if assertions fail

const errors = flushSoftErrors();
// errors contains any failures from soft assertions
```

### `expect.poll(fn: () => unknown | Promise<unknown>, options?: PollOptions): GenericAssertions`

Poll an async function until the assertion passes or the timeout expires. Useful for waiting on values that change over time.

```typescript
await expect.poll(async () => {
  const el = await device.element(role("listitem")).count();
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
await expect(device.element(text("Loading..."))).not.toBeVisible();
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
await expect(device.element(text("Welcome"))).toBeVisible();
await expect(device.element(text("Spinner"))).not.toBeVisible();

// Custom timeout
await expect(device.element(text("Welcome"))).toBeVisible({ timeout: 10000 });
```

#### `.toBeEnabled(options?): Promise<void>`

Assert that the element is enabled (interactive).

```typescript
await expect(device.element(role("button", "Submit"))).toBeEnabled();
await expect(device.element(role("button", "Submit"))).not.toBeEnabled();
```

#### `.toBeDisabled(options?): Promise<void>`

Assert that the element is disabled (not interactive). More expressive than `.not.toBeEnabled()`.

```typescript
await expect(device.element(role("button", "Submit"))).toBeDisabled();
```

#### `.toBeChecked(options?): Promise<void>`

Assert that a checkbox, switch, or radio button is in the checked state.

```typescript
await expect(device.element(role("switch", "Dark Mode"))).toBeChecked();
await expect(device.element(role("checkbox"))).not.toBeChecked();
```

#### `.toBeHidden(options?): Promise<void>`

Assert that the element is not visible on screen (either not in the hierarchy or has visibility=false). More expressive than `.not.toBeVisible()`.

```typescript
await expect(device.element(text("Loading..."))).toBeHidden();
```

#### `.toBeEmpty(options?): Promise<void>`

Assert that the element has no text content or is an empty input field.

```typescript
await expect(device.element(role("textfield", "Search"))).toBeEmpty();
```

#### `.toBeFocused(options?): Promise<void>`

Assert that the element currently has accessibility/input focus.

```typescript
await device.element(role("textfield", "Email")).tap();
await expect(device.element(role("textfield", "Email"))).toBeFocused();
```

#### `.toBeEditable(options?): Promise<void>`

Assert that the element is an editable input field (a text field that is enabled).

```typescript
await expect(device.element(role("textfield", "Name"))).toBeEditable();
await expect(device.element(role("textfield", "ID"))).not.toBeEditable(); // read-only
```

#### `.toBeInViewport(options?): Promise<void>`

Assert that the element is currently within the visible screen area. Different from `toBeVisible()` which checks the visibility property -- this checks if the element's bounds intersect with the screen bounds.

```typescript
await expect(device.element(text("Footer"))).toBeInViewport();
await expect(device.element(text("Footer"))).toBeInViewport({ ratio: 0.5 }); // at least 50% visible
```

#### `.toHaveText(expected: string, options?): Promise<void>`

Assert that the element's text content matches the expected string exactly.

```typescript
await expect(device.element(id("counter"))).toHaveText("42");
```

#### `.toContainText(expected: string | RegExp, options?): Promise<void>`

Assert that the element's text contains the given substring or matches a regex. Unlike `toHaveText()` which requires an exact match, this allows partial matching.

```typescript
await expect(device.element(testId("status"))).toContainText("Success");
await expect(device.element(testId("status"))).toContainText(/\d+ items/);
```

#### `.toHaveCount(count: number, options?): Promise<void>`

Assert that the selector resolves to exactly N elements.

```typescript
await expect(device.element(role("listitem"))).toHaveCount(5);
await expect(device.element(text("Error"))).toHaveCount(0);
```

#### `.toHaveAttribute(name: string, value: unknown, options?): Promise<void>`

Assert that the element has a specific property/attribute value. For Android, this maps to view properties like `className`, `resourceId`, `contentDescription`, `enabled`, `clickable`, `focusable`, `scrollable`, `selected`, etc.

```typescript
await expect(device.element(text("Item"))).toHaveAttribute("selected", true);
await expect(device.element(text("Item"))).toHaveAttribute("className", "android.widget.TextView");
```

#### `.toHaveAccessibleName(name: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible name. On Android, this is the `contentDescription` if set, otherwise the `text` property.

```typescript
await expect(device.element(role("button"))).toHaveAccessibleName("Submit form");
await expect(device.element(role("image"))).toHaveAccessibleName(/Profile/);
```

#### `.toHaveAccessibleDescription(description: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible description. On Android, this maps to the `hint` property.

```typescript
await expect(device.element(role("image"))).toHaveAccessibleDescription("Profile photo");
```

#### `.toHaveRole(role: string, options?): Promise<void>`

Assert that the element has a specific accessibility role.

```typescript
await expect(device.element(text("Submit"))).toHaveRole("button");
await expect(device.element(testId("toggle"))).toHaveRole("switch");
```

#### `.toHaveValue(value: string, options?): Promise<void>`

Assert that an input field contains a specific value.

```typescript
await device.element(role("textfield", "Email")).type("test@example.com");
await expect(device.element(role("textfield", "Email"))).toHaveValue("test@example.com");
```

#### `.toExist(options?): Promise<void>`

Assert that the element exists in the UI hierarchy (regardless of visibility).

```typescript
await expect(device.element(testId("hidden-input"))).toExist();
await expect(device.element(text("Deleted item"))).not.toExist();
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
  await device.tap(text("Sign In"));
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

### `loadConfig(dir?: string): Promise<PilotConfig>`

Load configuration from a `pilot.config.ts`, `pilot.config.js`, or `pilot.config.mjs` file. Falls back to defaults if no config file exists. This is used internally by the CLI.

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

### `FullResult`

```typescript
interface FullResult {
  status: "passed" | "failed";
  duration: number; // milliseconds
  tests: TestResult[]; // flattened list of all test results
  suites: SuiteResult[]; // hierarchical suite tree (one per test file)
}
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

Target a specific device by its ADB serial number.

```bash
npx pilot test --device emulator-5554
```

### `pilot --version` / `pilot -v`

Print the Pilot version.

### `pilot --help` / `pilot -h`

Show help text with available commands and options.
