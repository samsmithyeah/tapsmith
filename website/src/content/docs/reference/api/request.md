---
title: Request Fixture
description: "Make HTTP requests from tests with the request fixture."
---

The `request` fixture provides HTTP request methods for making API calls during tests. Useful for seeding test data, fetching auth tokens, or verifying backend state without going through the UI. Modeled after Playwright's `APIRequestContext`.

## Usage

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

## Methods

### `request.get(url, options?)`
### `request.post(url, options?)`
### `request.put(url, options?)`
### `request.patch(url, options?)`
### `request.delete(url, options?)`
### `request.head(url, options?)`

Send an HTTP request. Returns a `TapsmithAPIResponse`. **Does not throw on non-2xx responses** (matching Playwright's behavior) — check `.ok` or `.status` instead.

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

## TapsmithAPIResponse

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

## Configuration

Set `baseURL` and `extraHTTPHeaders` in your config or via `test.use()`:

```typescript
import { defineConfig } from "tapsmith";

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

## Trace Integration

When tracing is enabled (`--trace on`), each `request.*()` call:
- Appears as an action event in the trace viewer's actions panel
- Generates a network entry visible in the Network tab (alongside device network traffic)

This gives full visibility into test-level API calls alongside device interactions.
