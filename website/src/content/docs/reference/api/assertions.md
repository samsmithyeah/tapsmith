---
title: Assertions
description: "Auto-waiting assertions for locators and generic value assertions."
---

The `expect()` function creates assertions for an `ElementHandle` or a plain value. Locator assertions auto-wait by polling until the condition is met or the timeout expires.

### `expect(elementHandle: ElementHandle): TapsmithAssertions`

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

### `expect.soft(elementHandle: ElementHandle): TapsmithAssertions`

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

## Locator Assertions

All locator assertions accept an optional `options` object:

| Option | Type | Default | Description |
|---|---|---|---|
| `timeout` | `number` | Element's timeout (default 30s) | How long to wait for the condition |
| `ratio` | `number` | `0` | (toBeInViewport only) Minimum fraction of element visible in viewport |

### `.toBeVisible(options?): Promise<void>`

Assert that the element is visible on screen. With `.not`, waits for the element to disappear.

```typescript
await expect(device.getByText("Welcome", { exact: true })).toBeVisible();
await expect(device.getByText("Spinner", { exact: true })).not.toBeVisible();

// Custom timeout
await expect(device.getByText("Welcome", { exact: true })).toBeVisible({ timeout: 10000 });
```

### `.toBeEnabled(options?): Promise<void>`

Assert that the element is enabled (interactive).

```typescript
await expect(device.getByRole("button", { name: "Submit" })).toBeEnabled();
await expect(device.getByRole("button", { name: "Submit" })).not.toBeEnabled();
```

### `.toBeDisabled(options?): Promise<void>`

Assert that the element is disabled (not interactive). More expressive than `.not.toBeEnabled()`.

```typescript
await expect(device.getByRole("button", { name: "Submit" })).toBeDisabled();
```

### `.toBeChecked(options?): Promise<void>`

Assert that a checkbox, switch, or radio button is in the checked state.

```typescript
await expect(device.getByRole("switch", { name: "Dark Mode" })).toBeChecked();
await expect(device.getByRole("checkbox")).not.toBeChecked();
```

### `.toBeHidden(options?): Promise<void>`

Assert that the element is not visible on screen (either not in the hierarchy or has visibility=false). More expressive than `.not.toBeVisible()`.

```typescript
await expect(device.getByText("Loading...", { exact: true })).toBeHidden();
```

### `.toBeEmpty(options?): Promise<void>`

Assert that the element has no text content or is an empty input field. The agents normalize text-input fields so a placeholder/hint is not reported as text — `toBeEmpty()` after `clear()` passes even when the placeholder is still drawn.

> **Android API < 26 limitation.** The precise placeholder-vs-value distinction uses `AccessibilityNodeInfo.isShowingHintText()` and `getHintText()`, both of which are only available from API 26 (Android 8.0). On API 21–25 we cannot tell whether a textfield is displaying its placeholder or a real typed value, so `toBeEmpty()` after `clear()` may incorrectly report the field as non-empty (it sees the placeholder text). Bump `minSdk` to 26 if your tests rely on this behavior. iOS is unaffected.

```typescript
await expect(device.getByRole("textfield", { name: "Search" })).toBeEmpty();
```

### `.toBeFocused(options?): Promise<void>`

Assert that the element currently has accessibility/input focus.

```typescript
await device.getByRole("textfield", { name: "Email" }).tap();
await expect(device.getByRole("textfield", { name: "Email" })).toBeFocused();
```

### `.toBeEditable(options?): Promise<void>`

Assert that the element is an editable input field (a text field that is enabled).

```typescript
await expect(device.getByRole("textfield", { name: "Name" })).toBeEditable();
await expect(device.getByRole("textfield", { name: "ID" })).not.toBeEditable(); // read-only
```

### `.toBeInViewport(options?): Promise<void>`

Assert that the element is currently within the visible screen area. Different from `toBeVisible()` which checks the visibility property -- this checks if the element's bounds intersect with the screen bounds.

```typescript
await expect(device.getByText("Footer", { exact: true })).toBeInViewport();
await expect(device.getByText("Footer", { exact: true })).toBeInViewport({ ratio: 0.5 }); // at least 50% visible
```

### `.toHaveText(expected: string, options?): Promise<void>`

Assert that the element's text content matches the expected string exactly.

```typescript
await expect(device.locator({ id: "counter" })).toHaveText("42");
```

### `.toContainText(expected: string | RegExp, options?): Promise<void>`

Assert that the element's text contains the given substring or matches a regex. Unlike `toHaveText()` which requires an exact match, this allows partial matching.

When the matched element has no own text (e.g. a wrapping `View` around `<Text>` children, common in React Native), the agents aggregate descendant text/labels so the assertion sees the visible string.

```typescript
await expect(device.getByTestId("status")).toContainText("Success");
await expect(device.getByTestId("status")).toContainText(/\d+ items/);
```

### `.toHaveCount(count: number, options?): Promise<void>`

Assert that the selector resolves to exactly N elements.

```typescript
await expect(device.getByRole("listitem")).toHaveCount(5);
await expect(device.getByText("Error", { exact: true })).toHaveCount(0);
```

### `.toHaveAttribute(name: string, value: unknown, options?): Promise<void>`

Assert that the element has a specific property/attribute value. For Android, this maps to view properties like `className`, `resourceId`, `contentDescription`, `enabled`, `clickable`, `focusable`, `scrollable`, `selected`, etc.

```typescript
await expect(device.getByText("Item", { exact: true })).toHaveAttribute("selected", true);
await expect(device.getByText("Item", { exact: true })).toHaveAttribute("className", "android.widget.TextView");
```

### `.toHaveAccessibleName(name: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible name. On Android, this is the `contentDescription` if set, otherwise the `text` property.

```typescript
await expect(device.getByRole("button")).toHaveAccessibleName("Submit form");
await expect(device.getByRole("image")).toHaveAccessibleName(/Profile/);
```

### `.toHaveAccessibleDescription(description: string | RegExp, options?): Promise<void>`

Assert that the element has the given accessible description. On Android, this maps to the `hint` property.

```typescript
await expect(device.getByRole("image")).toHaveAccessibleDescription("Profile photo");
```

### `.toHaveRole(role: string, options?): Promise<void>`

Assert that the element has a specific accessibility role.

The role is derived from a framework-set role description first (React Native's `accessibilityRole`, the `isHeading` flag, the `UIAccessibilityTraitHeader` trait, etc.) and falls back to the platform's class/element-type mapping. `"header"` and `"heading"` are accepted as aliases on both platforms.

```typescript
await expect(device.getByText("Submit", { exact: true })).toHaveRole("button");
await expect(device.getByTestId("toggle")).toHaveRole("switch");
await expect(device.getByText("Section title", { exact: true })).toHaveRole("heading");
```

### `.toHaveValue(value: string, options?): Promise<void>`

Assert that an input field contains a specific value.

```typescript
await device.getByRole("textfield", { name: "Email" }).type("test@example.com");
await expect(device.getByRole("textfield", { name: "Email" })).toHaveValue("test@example.com");
```

### `.toExist(options?): Promise<void>`

Assert that the element exists in the UI hierarchy (regardless of visibility).

```typescript
await expect(device.getByTestId("hidden-input")).toExist();
await expect(device.getByText("Deleted item", { exact: true })).not.toExist();
```

## Generic Value Assertions

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
