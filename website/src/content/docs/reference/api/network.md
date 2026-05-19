---
title: Network
description: "Intercept, mock, and modify network requests with the Route API."
---

Tapsmith supports Playwright-style network interception. Route handlers let you mock, modify, or abort HTTP/HTTPS requests made by the app under test.

### `device.route(url, handler, options?): Promise<void>`

Intercept network requests matching a URL pattern. Requires network tracing to be enabled (set `trace` to any mode other than `'off'` with `network: true`, which is the default). Without it, the MITM proxy that intercepts traffic is not active and route handlers will never fire.

See also: [`device.unroute()`](#deviceunrouteurl-handler-promisevoid), [`device.unrouteAll()`](#deviceunrouteall-promisevoid).

- `url`: `string | RegExp | ((url: URL) => boolean)` — URL pattern (glob), regex, or predicate
- `handler`: `(route: Route) => Promise<void> | void` — handler that decides how to handle the request
- `options.times?`: `number` — how many times to intercept (then auto-remove)

```ts
await device.route('**/api/posts*', async (route) => {
  await route.fulfill({ json: [{ id: 1, title: 'Mocked' }] })
})
```

### `device.unroute(url, handler?): Promise<void>`

Remove a previously registered route handler. If `handler` is omitted, all handlers for the pattern are removed.

### `device.unrouteAll(): Promise<void>`

Remove all registered route handlers.

### `device.waitForRequest(urlOrPredicate, options?): Promise<TapsmithRequest>`

Wait for a network request matching the pattern. Requires network tracing to be enabled (same prerequisite as `device.route()`).

- `urlOrPredicate`: `string | RegExp | ((request: TapsmithRequest) => boolean)`
- `options.timeout?`: `number` — timeout in ms (default: device timeout)

### `device.waitForResponse(urlOrPredicate, options?): Promise<NetworkResponseEventData>`

Wait for a network response matching the pattern. Requires network tracing to be enabled (same prerequisite as `device.route()`).

### `device.on(event, handler): void`

Subscribe to network events: `'request'` or `'response'`.

```ts
device.on('request', (req) => console.log(req.url))
device.on('response', (resp) => console.log(resp.status))
```

### `device.off(event, handler): void`

Unsubscribe from network events.

## Route

The `Route` object is passed to route handlers. It provides methods to decide how to handle the intercepted request.

### `route.request(): TapsmithRequest`

Returns the intercepted request.

### `route.abort(errorCode?): Promise<void>`

Abort the request. Optional `errorCode`: `'connectionrefused'`, `'connectionreset'`, `'timedout'`.

### `route.continue(overrides?): Promise<void>`

Continue the request to the server with optional modifications.

- `overrides.url?`: `string` — override the request URL. Supports both same-origin path changes (e.g. `/v2/posts`) and cross-origin redirection (e.g. `https://staging.example.com/api/posts`). When the host differs, the `Host` header is automatically updated.
- `overrides.method?`: `string` — override the HTTP method
- `overrides.headers?`: `Record<string, string>` — override headers
- `overrides.postData?`: `string | Buffer` — override request body

### `route.fulfill(options?): Promise<void>`

Return a mock response without contacting the server.

- `options.status?`: `number` — HTTP status code (default: 200)
- `options.headers?`: `Record<string, string>` — response headers
- `options.body?`: `string | Buffer` — response body
- `options.contentType?`: `string` — content-type header
- `options.json?`: `unknown` — convenience: JSON-serializes and sets content-type
- `options.path?`: `string` — read body from a file

### `route.fetch(overrides?): Promise<FetchedAPIResponse>`

Fetch the actual response from the server. Returns a `FetchedAPIResponse` that you can inspect and modify before calling `route.fulfill()`.

- `overrides.url?`: `string` — override the URL to fetch from (supports cross-origin, same as `route.continue()`)
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

## TapsmithRequest

Properties: `method`, `url`, `headers`, `postData`, `isHttps`.

## FetchedAPIResponse

Returned by `route.fetch()`. Properties: `status`, `headers`. Methods: `body()`, `text()`, `json()`.
