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

### `device.close(): void`

Close the gRPC connection to the daemon.

---

## ElementHandle

An `ElementHandle` is a lazy reference to a UI element. It is returned by `device.element()` and supports chaining, queries, and actions.

### `elementHandle.element(childSelector: Selector): ElementHandle`

Scope a child selector within this element. Returns a new `ElementHandle`.

```typescript
const list = device.element(role("list", "Shopping cart"));
const item = list.element(text("Item 3"));
await item.tap();
```

### `elementHandle.find(): Promise<ElementInfo>`

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
| `viewportRatio` | `number` | Fraction of element visible in viewport (0.0–1.0) |
| `bounds` | `Bounds` | Element bounding rectangle |

### `elementHandle.exists(): Promise<boolean>`

Returns `true` if the element exists in the current UI hierarchy.

```typescript
const exists = await device.element(text("Optional banner")).exists();
```

### `elementHandle.tap(): Promise<void>`

Tap this element.

```typescript
await device.element(role("button", "Submit")).tap();
```

### `elementHandle.longPress(durationMs?: number): Promise<void>`

Long press this element.

```typescript
await device.element(text("Item 1")).longPress(2000);
```

### `elementHandle.type(text: string): Promise<void>`

Type text into this element.

```typescript
await device.element(hint("Email")).type("user@example.com");
```

### `elementHandle.clearAndType(text: string): Promise<void>`

Clear existing text and type new text.

```typescript
await device.element(id("search_box")).clearAndType("new query");
```

### `elementHandle.clear(): Promise<void>`

Clear the text content of this element.

```typescript
await device.element(id("search_box")).clear();
```

### `elementHandle.scroll(direction: string, options?: { distance?: number }): Promise<void>`

Scroll this element in the given direction.

```typescript
await device.element(role("list")).scroll("down", { distance: 300 });
```

### `elementHandle.getText(): Promise<string>`

Get the visible text content of this element.

```typescript
const label = await device.element(id("status_label")).getText();
```

### `elementHandle.isVisible(): Promise<boolean>`

Check whether this element is visible on screen.

```typescript
const visible = await device.element(text("Error")).isVisible();
```

### `elementHandle.isEnabled(): Promise<boolean>`

Check whether this element is enabled (interactive).

```typescript
const enabled = await device.element(role("button", "Submit")).isEnabled();
```

---

## Assertions

The `expect()` function creates assertions for an `ElementHandle`. All assertions auto-wait by polling until the condition is met or the timeout expires.

### `expect(elementHandle: ElementHandle): PilotAssertions`

Create an assertion object for the given element handle.

```typescript
await expect(device.element(text("Hello"))).toBeVisible();
```

### `.not`

Negate the following assertion.

```typescript
await expect(device.element(text("Loading..."))).not.toBeVisible();
```

### `.toBeVisible(options?): Promise<void>`

Assert that the element is visible on screen. With `.not`, waits for the element to disappear.

```typescript
await expect(device.element(text("Welcome"))).toBeVisible();
await expect(device.element(text("Spinner"))).not.toBeVisible();

// Custom timeout
await expect(device.element(text("Welcome"))).toBeVisible({ timeout: 10000 });
```

### `.toBeEnabled(options?): Promise<void>`

Assert that the element is enabled (interactive).

```typescript
await expect(device.element(role("button", "Submit"))).toBeEnabled();
await expect(device.element(role("button", "Submit"))).not.toBeEnabled();
```

### `.toHaveText(expected: string, options?): Promise<void>`

Assert that the element's text content matches the expected string exactly.

```typescript
await expect(device.element(id("counter"))).toHaveText("42");
```

### `.toExist(options?): Promise<void>`

Assert that the element exists in the UI hierarchy (regardless of visibility).

```typescript
await expect(device.element(testId("hidden-input"))).toExist();
await expect(device.element(text("Deleted item"))).not.toExist();
```

### `.toBeChecked(options?): Promise<void>`

Assert that a checkbox, switch, or radio button is in the checked state.

```typescript
await expect(device.element(role("switch", "Dark Mode"))).toBeChecked();
await expect(device.element(role("checkbox"))).not.toBeChecked();
```

### `.toBeDisabled(options?): Promise<void>`

Assert that the element is disabled (not interactive). More expressive than `.not.toBeEnabled()`.

```typescript
await expect(device.element(role("button", "Submit"))).toBeDisabled();
```

### `.toBeHidden(options?): Promise<void>`

Assert that the element is not visible on screen (either not in the hierarchy or has visibility=false). More expressive than `.not.toBeVisible()`.

```typescript
await expect(device.element(text("Loading..."))).toBeHidden();
```

### `.toBeEmpty(options?): Promise<void>`

Assert that the element has no text content or is an empty input field.

```typescript
await expect(device.element(role("textfield", "Search"))).toBeEmpty();
```

### `.toBeFocused(options?): Promise<void>`

Assert that the element currently has accessibility/input focus.

```typescript
await device.element(role("textfield", "Email")).tap();
await expect(device.element(role("textfield", "Email"))).toBeFocused();
```

### `.toContainText(expected: string | RegExp, options?): Promise<void>`

Assert that the element's text contains the given substring or matches a regex. Unlike `toHaveText()` which requires an exact match, this allows partial matching.

```typescript
await expect(device.element(testId("status"))).toContainText("Success");
await expect(device.element(testId("status"))).toContainText(/\d+ items/);
```

### `.toHaveCount(count: number, options?): Promise<void>`

Assert that the selector resolves to exactly N elements.

```typescript
await expect(device.element(role("listitem"))).toHaveCount(5);
await expect(device.element(text("Error"))).toHaveCount(0);
```

### `.toHaveAttribute(name: string, value: unknown, options?): Promise<void>`

Assert that the element has a specific property/attribute value. For Android, this maps to view properties like `className`, `resourceId`, `contentDescription`, `enabled`, `clickable`, `focusable`, `scrollable`, `selected`, etc.

```typescript
await expect(device.element(text("Item"))).toHaveAttribute("selected", true);
await expect(device.element(text("Item"))).toHaveAttribute("className", "android.widget.TextView");
```

### `.toHaveAccessibleName(name: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible name. On Android, this is the `contentDescription` if set, otherwise the `text` property.

```typescript
await expect(device.element(role("button"))).toHaveAccessibleName("Submit form");
await expect(device.element(role("image"))).toHaveAccessibleName(/Profile/);
```

### `.toHaveAccessibleDescription(description: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible description. On Android, this maps to the `hint` property.

```typescript
await expect(device.element(role("image"))).toHaveAccessibleDescription("Profile photo");
```

### `.toHaveRole(role: string, options?): Promise<void>`

Assert that the element has a specific accessibility role.

```typescript
await expect(device.element(text("Submit"))).toHaveRole("button");
await expect(device.element(testId("toggle"))).toHaveRole("switch");
```

### `.toHaveValue(value: string, options?): Promise<void>`

Assert that an input field contains a specific value.

```typescript
await device.element(role("textfield", "Email")).type("test@example.com");
await expect(device.element(role("textfield", "Email"))).toHaveValue("test@example.com");
```

### `.toBeEditable(options?): Promise<void>`

Assert that the element is an editable input field (a text field that is enabled).

```typescript
await expect(device.element(role("textfield", "Name"))).toBeEditable();
await expect(device.element(role("textfield", "ID"))).not.toBeEditable(); // read-only
```

### `.toBeInViewport(options?): Promise<void>`

Assert that the element is currently within the visible screen area. Different from `toBeVisible()` which checks the visibility property — this checks if the element's bounds intersect with the screen bounds.

```typescript
await expect(device.element(text("Footer"))).toBeInViewport();
await expect(device.element(text("Footer"))).toBeInViewport({ ratio: 0.5 }); // at least 50% visible
```

**Assertion options:**

All assertion methods accept an optional `options` object:

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | Element's timeout (default 30s) | How long to wait for the condition |
| `ratio` | `number` | `0` | (toBeInViewport only) Minimum fraction of element visible in viewport |

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
