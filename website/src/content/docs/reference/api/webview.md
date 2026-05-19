---
title: WebView
description: "Test hybrid apps with CSS selectors in WebView contexts."
---

Test hybrid apps that embed WebViews (login screens, payment flows, in-app browsers, Cordova/Ionic).

## Prerequisites

- **Android**: The app must enable WebView debugging: `WebView.setWebContentsDebuggingEnabled(true)`. React Native WebView provides a `webviewDebuggingEnabled` prop.
- **iOS**: The WKWebView must set `isInspectable = true` (required since iOS 16.4). React Native WebView provides a `webviewDebuggingEnabled` prop which sets this automatically. Tapsmith connects directly to the simulator's WebKit Inspector — no external tools needed.

## `device.webview(packageName?: string): Promise<WebViewHandle>`

Switch to a WebView context. Discovers available WebViews on the device and connects via CDP (Chrome DevTools Protocol).

```typescript
const webview = await device.webview()
// or target a specific package when multiple WebViews are present
const webview = await device.webview("com.example.myapp")
```

Auto-waits for the WebView to appear up to the device timeout. Throws if no WebView is found.

## `device.native(): Promise<void>`

Switch back to native context, closing the active WebView connection.

```typescript
await device.native()
// Now you can interact with native elements again
await device.getByRole("button", { name: "Continue" }).tap()
```

## WebViewHandle

Returned by `device.webview()`. All methods use CSS selectors and auto-wait for elements.

### `webview.click(selector: string): Promise<void>`

Click an element in the WebView.

```typescript
await webview.click("#login-button")
await webview.click(".submit-btn")
```

### `webview.fill(selector: string, value: string): Promise<void>`

Fill an input element with text. Dispatches `input` and `change` events.

```typescript
await webview.fill("#email", "user@test.com")
await webview.fill("#password", "secret123")
```

### `webview.textContent(selector: string): Promise<string>`

Get the text content of an element.

```typescript
const heading = await webview.textContent("h1")
```

### `webview.innerHTML(selector: string): Promise<string>`

Get the inner HTML of an element.

### `webview.inputValue(selector: string): Promise<string>`

Get the current value of an input element.

### `webview.getAttribute(selector: string, name: string): Promise<string | null>`

Get an attribute value from an element.

### `webview.isVisible(selector: string): Promise<boolean>`

Check if an element is visible (not `display: none`, `visibility: hidden`, or `opacity: 0`).

### `webview.evaluate<T>(expression: string): Promise<T>`

Execute arbitrary JavaScript in the WebView and return the result.

```typescript
const count = await webview.evaluate<number>("document.querySelectorAll('li').length")
const title = await webview.evaluate<string>("document.title")
```

### `webview.goto(url: string): Promise<void>`

Navigate the WebView to a URL.

### `webview.title(): Promise<string>`

Get the document title.

### `webview.url(): Promise<string>`

Get the current URL.

### `webview.locator(cssSelector: string): WebViewLocator`

Create a lazy locator for a CSS selector. Returns a `WebViewLocator` that can be used with `expect()` assertions.

```typescript
const loginBtn = webview.locator("#login-button")
await loginBtn.click()
await expect(loginBtn).toBeVisible()
```

### `webview.close(): Promise<void>`

Close the WebView connection. Usually called via `device.native()` instead.

## WebViewLocator

Lazy reference to a CSS selector within a WebView. Supports actions and assertions.

**Actions:** `click()`, `fill(value)`, `textContent()`, `innerHTML()`, `inputValue()`, `getAttribute(name)`, `isVisible()`

## WebView Assertions

`expect(webview.locator(selector))` returns WebView-specific assertions:

```typescript
await expect(webview.locator(".header")).toBeVisible()
await expect(webview.locator(".header")).toHaveText("Welcome")
await expect(webview.locator(".header")).toContainText("Welc")
await expect(webview.locator(".error")).toBeHidden()
await expect(webview.locator("#email")).toExist()
await expect(webview.locator("#email")).toHaveValue("user@test.com")
await expect(webview.locator("a")).toHaveAttribute("href", "/about")
```

All assertions support `.not` and a `{ timeout }` option:

```typescript
await expect(webview.locator(".spinner")).not.toBeVisible()
await expect(webview.locator(".loaded")).toBeVisible({ timeout: 10_000 })
```

## MCP Server

Tapsmith includes a built-in MCP server that lets AI coding agents interact with devices, run tests, and inspect results. It supports two transport modes:

- **SSE mode** (via `tapsmith test --ui`) -- agent shares the UI session with full test tree, results, watch mode, and mutual exclusion. 16 tools available.
- **Stdio mode** (client-launched `tapsmith mcp-server`) -- standalone agent with its own headless test session, daemon, and device. Includes test discovery, results, watch mode, stop, and session info. 16 tools available.

See the [MCP Server Guide](mcp-server.md) for setup instructions, the full tool reference, and the recommended workflow.
