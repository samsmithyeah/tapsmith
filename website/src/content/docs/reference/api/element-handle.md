---
title: ElementHandle
description: "Tap, type, scroll, drag, and query elements with the lazy locator API."
---

An `ElementHandle` is a lazy reference to a UI element. It is returned by every `device.getBy*()` and `device.locator()` call, and supports chaining, queries, actions, and positional selection.

## Scoping

`ElementHandle` exposes the same `getBy*` methods and `locator()` as `Device`. Calling any of them on an existing handle scopes the search to its descendants — exactly like Playwright's `locator.locator(...)`.

| Method | Description |
|---|---|
| `getByText(text, options?)` | Substring (default) or exact text match within the parent. |
| `getByRole(role, options?)` | Accessibility role within the parent. |
| `getByDescription(text)` | Accessibility description within the parent. |
| `getByPlaceholder(text)` | Placeholder / hint text within the parent. |
| `getByTestId(id)` | Test identifier within the parent. |
| `getByLabel(text)` | Input element by associated label text within the parent. |
| `locator(options)` | Native id / xpath / className within the parent. |

Cannot be called on modified handles (e.g. after `.first()`, `.filter()`, `.and()`).

```typescript
const list = device.getByRole("list", { name: "Shopping cart" });
const item = list.getByText("Item 3", { exact: true });
await item.tap();

// Tap a delete button inside a specific row
await device.getByTestId("row-5").getByRole("button", { name: "Delete" }).tap();
```

## Positional Selection

### `elementHandle.first(): ElementHandle`

Return a new handle targeting the first match. The handle is lazy -- it does not resolve until an action or assertion is performed.

```typescript
await device.getByRole("listitem").first().tap();
```

### `elementHandle.last(): ElementHandle`

Return a new handle targeting the last match.

```typescript
await device.getByRole("listitem").last().tap();
```

### `elementHandle.nth(index: number): ElementHandle`

Return a new handle targeting the match at the given 0-based index. Negative indices count from the end.

```typescript
await device.getByRole("listitem").nth(2).tap();
await device.getByRole("listitem").nth(-1).tap(); // last item
```

## Filtering

### `elementHandle.filter(criteria: FilterOptions): ElementHandle`

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

## Combining Selectors

### `elementHandle.and(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy both this and the other handle's selector (intersection). AND binds tighter than OR.

```typescript
const submitButton = device.getByRole("button").and(device.getByText("Submit", { exact: true }));
await submitButton.tap();
```

### `elementHandle.or(other: ElementHandle): ElementHandle`

Return a handle matching elements that satisfy either this or the other handle's selector (union).

```typescript
const acceptButton = device.getByText("OK", { exact: true }).or(device.getByText("Accept", { exact: true }));
await acceptButton.tap();
```

## Queries

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
| `viewportRatio` | `number` | Fraction of element visible in viewport (0.0-1.0) |
| `bounds` | `Bounds` | Element bounding rectangle |

### `elementHandle.exists(): Promise<boolean>`

Returns `true` if the element exists in the current UI hierarchy.

```typescript
const exists = await device.getByText("Optional banner", { exact: true }).exists();
```

### `elementHandle.count(): Promise<number>`

Return the number of elements matching the selector.

```typescript
const itemCount = await device.getByRole("listitem").count();
```

### `elementHandle.all(): Promise<ElementHandle[]>`

Return an array of `ElementHandle` instances, one for each matching element. Useful for iterating over a list of elements.

```typescript
const items = await device.getByRole("listitem").all();
for (const item of items) {
  const info = await item.find();
  console.log(info.text);
}
```

## Waiting

### `elementHandle.waitFor(options?): Promise<void>`

Wait until the element reaches the specified state. Polls the UI hierarchy until the condition is met or the timeout expires.

```typescript
// Wait for a loading spinner to disappear
await device.getByRole("progressbar").waitFor({ state: "hidden" });

// Wait for an element to appear (default state is 'visible')
await device.getByText("Welcome").waitFor();

// Wait for element to be removed from the hierarchy entirely
await device.getByText("Toast message").waitFor({ state: "detached" });

// Wait for element to exist (even if not visible, e.g. off-screen)
await device.getByTestId("lazy-section").waitFor({ state: "attached" });
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `state` | `'visible' \| 'hidden' \| 'attached' \| 'detached'` | `'visible'` | Target state to wait for |
| `timeout` | `number` | Device timeout (30s) | Maximum time to wait in milliseconds |

**States:**

| State | Condition |
|-------|-----------|
| `visible` | Element exists in the hierarchy AND is visible |
| `hidden` | Element doesn't exist OR exists with `visible === false` |
| `attached` | Element exists in the hierarchy (regardless of visibility) |
| `detached` | Element does not exist in the hierarchy |

## Actions

### `elementHandle.tap(): Promise<void>`

Tap this element.

```typescript
await device.getByRole("button", { name: "Submit" }).tap();
```

### `elementHandle.doubleTap(options?: { intervalMs?: number }): Promise<void>`

Double-tap this element.

- `options.intervalMs?`: `number` — interval in milliseconds between the two taps. Overrides the global `doubleTapInterval` config for this call. Defaults to `100`. On iOS, the interval is used for the coordinate-based EventSynthesizer path; the XCUIElement path handles timing internally.

```typescript
await device.getByText("Zoom here", { exact: true }).doubleTap();

// Custom interval for specific timing needs
await device.getByText("Zoom here").doubleTap({ intervalMs: 150 });
```

### `elementHandle.longPress(durationMs?: number): Promise<void>`

Long press this element.

```typescript
await device.getByText("Item 1", { exact: true }).longPress(2000);
```

### `elementHandle.type(text: string, options?: { delay?: number }): Promise<void>`

Type text into this element.

- `options.delay?`: `number` — delay in milliseconds between keystrokes. Overrides the global `typingDelay` config for this call. Defaults to `0` (no delay).

```typescript
await device.getByPlaceholder("Email").type("user@example.com");
await device.getByPlaceholder("OTP").type("123456", { delay: 50 });
```

> **Control characters.** `\n`, `\t`, and `\b` are dispatched as
> `KEYCODE_ENTER` / `KEYCODE_TAB` / `KEYCODE_DEL` key events on Android
> and the equivalent key events on iOS. Notably `\b` is **destructive**
> — `type("foo\bbar")` deletes the `o` and types `bar`, ending with
> `fobar`. CR (`\r`) is dropped (Android keyboards send `\n` for the
> Enter key). Other ASCII control codes below `0x20` are dropped with
> a one-shot warning log.

### `elementHandle.clearAndType(text: string, options?: { delay?: number }): Promise<void>`

Clear existing text and type new text.

- `options.delay?`: `number` — delay in milliseconds between keystrokes. Same as `type()`.

```typescript
await device.locator({ id: "search_box" }).clearAndType("new query");
```

### `elementHandle.clear(): Promise<void>`

Clear the text content of this element.

```typescript
await device.locator({ id: "search_box" }).clear();
```

> **iOS very-long-field ceiling.** On iOS, `clear()` first attempts
> Cmd+A + Delete; if that misses (common on React Native wrapped
> controls), it falls back to a per-character backspace loop capped at
> 16 iterations x 256 keystrokes = 4096 backspaces. A field with more
> than ~4000 grapheme clusters of content will throw `actionFailed`
> rather than partially clearing. The cap exists so a misbehaving
> field can't hang the agent. Android uses the native `UiObject2.clear()`
> API and isn't subject to this limit.

### `elementHandle.scroll(direction: string, options?: { distance?: number }): Promise<void>`

Scroll this element in the given direction.

```typescript
await device.getByRole("list").scroll("down", { distance: 300 });
```

### `elementHandle.scrollIntoView(options?: { direction?: string; maxScrolls?: number; speed?: number }): Promise<void>`

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

### `elementHandle.dragTo(target: ElementHandle): Promise<void>`

Drag this element to a target element.

```typescript
const source = device.getByText("Item 1", { exact: true });
const target = device.getByText("Drop Zone", { exact: true });
await source.dragTo(target);
```

### `elementHandle.setChecked(checked: boolean): Promise<void>`

Ensure a checkbox, switch, or radio button is in the desired state. Idempotent -- only taps if the current state differs from the desired state, and verifies the state changed after tapping.

```typescript
await device.getByRole("switch", { name: "Dark Mode" }).setChecked(true);
await device.getByRole("checkbox", { name: "Remember me" }).setChecked(false);
```

### `elementHandle.selectOption(option: string | { index: number }): Promise<void>`

Select an option from a native spinner or dropdown. Abstracts the tap-spinner, wait-for-popup, tap-option pattern into a single action.

```typescript
await device.getByRole("combobox").selectOption("Option 2");
await device.getByRole("combobox").selectOption({ index: 1 });
```

### `elementHandle.focus(): Promise<void>`

Programmatically focus this element. For text fields, this shows the keyboard.

```typescript
await device.getByRole("textfield", { name: "Email" }).focus();
```

### `elementHandle.blur(): Promise<void>`

Remove focus from this element by tapping outside its bounds.

```typescript
await device.getByRole("textfield", { name: "Email" }).blur();
```

### `elementHandle.pinchIn(options?: { scale?: number }): Promise<void>`

Perform a pinch-in (zoom out) gesture on this element.

```typescript
await device.getByText("Map", { exact: true }).pinchIn();
await device.getByText("Map", { exact: true }).pinchIn({ scale: 0.3 });
```

### `elementHandle.pinchOut(options?: { scale?: number }): Promise<void>`

Perform a pinch-out (zoom in) gesture on this element.

```typescript
await device.getByText("Map", { exact: true }).pinchOut();
await device.getByText("Map", { exact: true }).pinchOut({ scale: 3.0 });
```

### `elementHandle.highlight(options?: { durationMs?: number }): Promise<void>`

Highlight this element for debugging. Validates that the element exists and is accessible.

```typescript
await device.getByRole("button", { name: "Submit" }).highlight();
```

### `elementHandle.screenshot(): Promise<Buffer>`

Capture a screenshot cropped to this element's bounding box. Returns a `Buffer` containing PNG image data.

```typescript
const png = await device.getByRole("image", { name: "Profile" }).screenshot();
```

## Info Accessors

### `elementHandle.getText(): Promise<string>`

Get the visible text content of this element.

```typescript
const label = await device.locator({ id: "status_label" }).getText();
```

### `elementHandle.isVisible(): Promise<boolean>`

Check whether this element is visible on screen.

```typescript
const visible = await device.getByText("Error", { exact: true }).isVisible();
```

### `elementHandle.isEnabled(): Promise<boolean>`

Check whether this element is enabled (interactive).

```typescript
const enabled = await device.getByRole("button", { name: "Submit" }).isEnabled();
```

### `elementHandle.isChecked(): Promise<boolean>`

Check whether this checkbox, switch, or radio button is in the checked state.

```typescript
const checked = await device.getByRole("switch", { name: "Notifications" }).isChecked();
```

### `elementHandle.isEditable(): Promise<boolean>`

Check whether this element is an editable input field (text field role and enabled).

```typescript
const editable = await device.getByRole("textfield", { name: "Email" }).isEditable();
```

### `elementHandle.inputValue(): Promise<string>`

Get the current value of an input field. On Android, this returns the element's text property.

```typescript
const value = await device.getByRole("textfield", { name: "Email" }).inputValue();
```

### `elementHandle.boundingBox(): Promise<BoundingBox | null>`

Get the element's position and dimensions. Returns `null` if the element has no bounds.

```typescript
const box = await device.getByText("Header", { exact: true }).boundingBox();
// Returns: { x: number, y: number, width: number, height: number }
```
