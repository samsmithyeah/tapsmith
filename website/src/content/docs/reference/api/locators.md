---
title: Locators
description: "Find UI elements with getByText, getByRole, getByDescription, and other locator methods."
---

Locators identify UI elements on the device. They are exposed as Playwright-style `getBy*` methods on `Device` and `ElementHandle`. Each method returns an `ElementHandle` — a lazy reference that resolves when an action or assertion runs against it.

See the [Selectors Guide](/guides/selectors/) for a deeper discussion of when to use each one.

### `device.getByText(text: string, options?: { exact?: boolean }): ElementHandle`

Locate an element by its visible text. **Substring match by default**, like Playwright. Pass `{ exact: true }` for an exact match.

```typescript
device.getByText("Welcome")                          // substring
device.getByText("Sign In", { exact: true })         // exact
```

### `device.getByRole(role: string, options?): ElementHandle`

Locate an element by its accessibility role, optionally filtered by accessible name or state.

```typescript
device.getByRole("button", { name: "Submit" })
device.getByRole("textfield", { name: "Email" })
device.getByRole("checkbox")
device.getByRole("switch", { name: "Dark Mode", checked: true })
device.getByRole("button", { name: "Submit", disabled: true })
device.getByRole("tab", { name: "Settings", selected: true })
device.getByRole("button", { name: "Details", expanded: true })
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Filter by accessible name |
| `checked` | `boolean` | Filter by checked state (checkbox, switch, radio) |
| `disabled` | `boolean` | Filter by disabled state |
| `selected` | `boolean` | Filter by selected state (tab, option) |
| `expanded` | `boolean` | Filter by expanded state (accordion, dropdown) |

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

### `device.getByLabel(text: string): ElementHandle`

Locate an input element by its associated label text. Finds form controls (text fields, checkboxes, switches, etc.) whose accessible name matches the label.

- **Android**: matches inputs whose `contentDescription` equals the text, or inputs linked via `labelFor`/`labeledBy`.
- **iOS**: matches input elements (text fields, switches, sliders, etc.) whose `accessibilityLabel` equals the text.

```typescript
device.getByLabel("Email")           // finds the email text field
device.getByLabel("Dark Mode")       // finds the Dark Mode switch
device.getByLabel("Volume")          // finds the Volume slider
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

> The `getBy*` methods and `locator()` are also available on every `ElementHandle`. Calling them on a parent locator scopes the search to its descendants. See [ElementHandle Scoping](./element-handle/#scoping).

> **iOS wrapper suppression.** When traversing the iOS accessibility tree, Tapsmith drops a matching `XCUIElementTypeOther` container if a descendant *also* matches the same selector and shares the wrapper's `accessibilityIdentifier` (or, when the wrapper's identifier is empty, its `accessibilityLabel`). This collapses the redundant wrappers React Native (and SwiftUI in some configurations) emit around interactive elements, so a `getByText("Submit")` resolves to the actual control rather than the surrounding container. The visible text of the wrapper and descendant is *not* compared — identifier/label match alone is enough. If your native iOS app deliberately exposes an `.other` container with the same identifier as a child you also want addressable, the outer wrapper will be silently suppressed in favour of the child — give the wrapper a unique `accessibilityIdentifier` (or use `device.locator({ id: ... })`) to address it directly.
