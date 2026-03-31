# Selectors Guide

Selectors are how you tell Pilot which UI element to interact with. Pilot provides several types of selectors, organized into a priority hierarchy. The guiding principle: **tests should interact with the app the way users do.**

Selectors that reflect what users see and what assistive technologies read are preferred over selectors that depend on implementation details. This makes your tests more resilient to refactors and ensures your app remains accessible.

## Priority Hierarchy

| Priority | Selectors | When to use |
|---|---|---|
| 1 (preferred) | `role()`, `text()`, `textContains()`, `contentDesc()` | Default choice. Reflects what users see. |
| 2 (acceptable) | `hint()`, `className()` | When Priority 1 selectors don't fit. |
| 3 (escape hatch) | `testId()`, `id()` | When no user-visible attribute works. |
| 4 (discouraged) | `xpath()` | Last resort only. |

## Cross-Platform Considerations

Pilot supports both Android and iOS. Most selectors work identically on both platforms, but there is one important difference to be aware of when writing cross-platform tests.

### Child text inside labeled containers

On iOS, when a component has an explicit `accessibilityLabel`, child text elements are **hidden from the accessibility tree**. The parent becomes a single accessible element with only its label visible. On Android, child text remains individually queryable through UIAutomator.

```tsx
// React Native component
<Pressable accessibilityLabel="Login Form" accessibilityRole="button">
  <Text>Login Form</Text>
  <Text>Text inputs, buttons, focus/blur, keyboard</Text>  {/* ← hidden on iOS */}
</Pressable>
```

On Android, `text("Text inputs, buttons, focus/blur, keyboard")` finds the child `Text` element. On iOS, this text does not exist in the accessibility tree — only the parent with label `"Login Form"` is visible.

**Recommended cross-platform patterns:**

1. **Target the parent by role or label**, not the child text:
   ```typescript
   // Cross-platform: finds the parent element on both platforms
   await device.tap(role("button", "Login Form"))
   await device.tap(contentDesc("Login Form"))
   ```

2. **Use `testId()` for elements that must be individually addressable:**
   ```typescript
   // If you need to verify specific child text, add a testID to it
   await expect(device.element(testId("login-description"))).toBeVisible()
   ```

3. **Use a separately accessible status element** for verifying state changes:
   ```typescript
   // Instead of checking child text inside a labeled container:
   // ✗ await expect(device.element(text("Long pressed!"))).toBeVisible()
   
   // Check a dedicated status element with its own testID:
   // ✓ await expect(device.element(id("last-gesture"))).toHaveText("Last gesture: Long press")
   ```

## Priority 1 -- Accessible Selectors (Preferred)

These selectors match what real users and assistive technologies see. They should be your default choice.

### `role(roleName, name?)`

Find an element by its accessibility role, optionally filtered by its accessible name. This is the **top recommended selector** because it verifies your app is accessible while also being resilient to implementation changes.

```typescript
import { role } from "pilot";

// Find a button labeled "Submit"
await device.tap(role("button", "Submit"));

// Find a text field labeled "Email"
await device.type(role("textfield", "Email"), "user@example.com");

// Find a checkbox
await device.tap(role("checkbox", "Remember me"));

// Find a switch toggle
await device.tap(role("switch", "Dark mode"));
```

Supported roles map to platform-native element types:

| Role | Android classes | iOS types |
|---|---|---|
| `button` | `Button`, `ImageButton`, Material/AppCompat variants | `XCUIElementTypeButton`, `.other` with button trait |
| `textfield` | `EditText` | `XCUIElementTypeTextField`, `XCUIElementTypeSecureTextField` |
| `checkbox` | `CheckBox` | `XCUIElementTypeOther` (React Native) |
| `switch` | `Switch` | `XCUIElementTypeSwitch` |
| `radiobutton` | `RadioButton` | `XCUIElementTypeOther` (React Native) |
| `image` | `ImageView` | `XCUIElementTypeImage` |
| `text` | `TextView` | `XCUIElementTypeStaticText` |
| `progressbar` | `ProgressBar` | `XCUIElementTypeProgressIndicator` |
| `slider` | `SeekBar` | `XCUIElementTypeSlider` |
| `combobox` | `Spinner` | `XCUIElementTypePopUpButton` |
| `togglebutton` | `ToggleButton` | `XCUIElementTypeToggle` |

### `text(exactText)`

Find an element by its exact visible text content.

```typescript
import { text } from "pilot";

// Tap a text-labeled element
await device.tap(text("Sign In"));

// Assert that text is visible on screen
await expect(device.element(text("Welcome back"))).toBeVisible();
```

### `textContains(partial)`

Find an element whose text contains the given substring.

```typescript
import { textContains } from "pilot";

// Match any element containing "Welcome"
await expect(device.element(textContains("Welcome"))).toBeVisible();

// Useful when text includes dynamic content
await expect(device.element(textContains("3 items"))).toBeVisible();
```

### `contentDesc(description)`

Find an element by its accessibility content description. Use this for icon buttons, images, and elements where the accessible label differs from visible text.

```typescript
import { contentDesc } from "pilot";

// Tap an icon button with a content description
await device.tap(contentDesc("Close menu"));

// Verify an image is present
await expect(device.element(contentDesc("Profile photo"))).toBeVisible();
```

## Priority 2 -- Semantic Selectors (Acceptable)

These use Android-specific semantics. They are fine when Priority 1 selectors do not apply.

### `hint(hintText)`

Find an input by its hint text (placeholder). Useful for text fields that do not have a separate visible label.

```typescript
import { hint } from "pilot";

// Type into a field identified by its placeholder
await device.type(hint("Enter your email"), "user@example.com");
await device.type(hint("Password"), "secret123");
```

### `className(name)`

Find an element by its exact Android class name. Use this when the role mapping does not cover a custom widget.

```typescript
import { className } from "pilot";

// Find a custom widget
await device.tap(className("com.myapp.widget.ColorPicker"));
```

> **Tip:** For standard Android widgets, prefer `role()` over `className()`. The ESLint plugin will warn you when `className()` is used for widgets that have well-known roles.

## Priority 3 -- Test IDs (Escape Hatch)

These selectors are invisible to users. Use them only when there is no accessible attribute that uniquely identifies the element.

### `testId(id)`

Find an element by a dedicated test identifier.

```typescript
import { testId } from "pilot";

// When no user-visible attribute uniquely identifies the element
await device.tap(testId("submit-button"));
```

On Android, `testId` maps to the view's tag or a custom content description prefix (e.g., `testid:submit-button`).

### `id(resourceId)`

Find an element by its Android resource ID.

```typescript
import { id } from "pilot";

// Use Android resource IDs as a fallback
await device.type(id("com.myapp:id/email_input"), "user@example.com");

// Short form also works if the package prefix is unambiguous
await device.type(id("email_input"), "user@example.com");
```

> **Warning:** Resource IDs are implementation details. They break when views are refactored, renamed, or replaced. Prefer accessible selectors whenever possible.

## Priority 4 -- XPath (Discouraged)

### `xpath(expression)`

Find an element using an XPath expression on the view hierarchy. This is fragile, verbose, and tightly coupled to the view structure. It exists only as a last resort for edge cases that no other selector can handle.

```typescript
import { xpath } from "pilot";

// Only use xpath when absolutely necessary, and always explain why
// Custom compound view with no accessible attributes
await device.tap(xpath("//android.widget.LinearLayout[@index='2']/android.widget.Button[1]"));
```

> **Warning:** The ESLint plugin requires an explanatory comment on the same or preceding line whenever `xpath()` is used. If you find yourself reaching for XPath, consider whether adding accessibility attributes to the app would be a better long-term solution.

## Chaining and Scoping

Selectors can be scoped within a parent element using `.within()` or by chaining `device.element().element()`. This narrows the search to descendants of the parent.

### Using `device.element().element()`

```typescript
// Find "Item 3" inside a specific list
const item = device.element(role("list", "Shopping cart")).element(text("Item 3"));
await expect(item).toBeVisible();

// Tap the delete button inside a specific row
await device.element(testId("row-5")).element(role("button", "Delete")).tap();
```

### Using `.within()`

```typescript
import { text, role } from "pilot";

// Create a scoped selector
const deleteButton = role("button", "Delete").within(testId("row-5"));
await device.tap(deleteButton);
```

Both approaches produce the same result. Use whichever reads better in context.

## Choosing the Right Selector

Follow this decision process:

1. **Can you identify the element by its role and name?** Use `role()`.
2. **Does the element have unique visible text?** Use `text()` or `textContains()`.
3. **Is it an icon or image with a content description?** Use `contentDesc()`.
4. **Is it a text input with a hint?** Use `hint()`.
5. **Is it a custom widget with no standard role?** Use `className()`.
6. **None of the above work?** Use `testId()` or `id()`.
7. **Nothing else works and you cannot modify the app?** Use `xpath()` with a comment explaining why.

## ESLint Plugin

Pilot includes an ESLint plugin that enforces selector best practices in your test files.

### Setup

Install ESLint if you haven't already, then configure the plugin:

```javascript
// eslint.config.js (flat config)
import { eslintPlugin } from "pilot";

export default [
  {
    plugins: {
      pilot: eslintPlugin,
    },
    rules: {
      "pilot/prefer-role": "warn",
      "pilot/no-bare-xpath": "error",
      "pilot/prefer-accessible-selectors": "warn",
    },
  },
];
```

Or use the recommended configuration:

```javascript
// eslint.config.js
import { eslintPlugin } from "pilot";

export default [
  {
    plugins: {
      pilot: eslintPlugin,
    },
    rules: {
      ...eslintPlugin.configs.recommended.rules,
    },
  },
];
```

### Rules

| Rule | Default | Description |
|---|---|---|
| `pilot/prefer-role` | warn | Suggests `role()` instead of `className()` for standard Android widgets. |
| `pilot/no-bare-xpath` | error | Requires an explanatory comment when using `xpath()`. |
| `pilot/prefer-accessible-selectors` | warn | Suggests accessible selectors instead of `testId()` or `id()`. |
