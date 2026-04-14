# Trace Viewer

Pilot's trace viewer records screenshots, view hierarchy snapshots, console output, and logcat at each test step, then lets you scrub through a timeline to debug failures. It's the mobile-native equivalent of Playwright's Trace Viewer.

## Recording Traces

### Via configuration

Add `trace` to your `pilot.config.ts`:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  trace: "on", // Record every test
});
```

### Via CLI

Override the config with the `--trace` flag:

```bash
npx pilot test --trace on
npx pilot test --trace retain-on-failure
```

### Via programmatic API

Control tracing within your tests:

```typescript
import { test } from "pilot";

test("checkout flow", async ({ device }) => {
  await device.tracing.start();

  device.tracing.group("Add to cart");
  await device.getByText("Add to Cart", { exact: true }).tap();
  device.tracing.groupEnd();

  await device.tracing.stop({ path: "traces/checkout.zip" });
});
```

## Trace Modes

| Mode | Records on | Keeps trace when |
|------|-----------|-----------------|
| `off` | Never | — |
| `on` | Every attempt | Always |
| `on-first-retry` | First retry only | Always (when recorded) |
| `on-all-retries` | All retries | Always (when recorded) |
| `retain-on-failure` | Every attempt | Test fails |
| `retain-on-first-failure` | Every attempt | First attempt fails |

**Recommended for CI:** `retain-on-failure` — minimal overhead on passing tests, full diagnostics on failures.

## Viewing Traces

### Local viewer

```bash
npx pilot show-trace test-results/traces/trace-my_test.zip
```

This starts a local server and opens the trace viewer in your browser.

### Drag and drop

Open the trace viewer without a file, then drag a `.zip` trace file onto the page.

## Trace Viewer Panels

### Actions Panel (left)

Chronological list of all actions and assertions. Each entry shows:
- Action icon and name (tap, type, swipe, etc.)
- Selector used
- Duration in milliseconds
- Pass/fail status (red highlight for failures)

Groups from `device.tracing.group()` appear as collapsible sections.

**Keyboard navigation:** Use arrow keys or `j`/`k` to move between actions.

### Timeline Filmstrip (top)

Horizontal strip of screenshot thumbnails. Click to jump to an action. Failed actions have a red border.

### Screenshot Panel (center)

Shows before/after screenshots for the selected action:
- **Before** — screenshot taken before the action executed
- **Action** — before screenshot with tap/swipe coordinate overlay
- **After** — screenshot taken after the action completed

### Detail Tabs (right)

- **Call** — Action type, selector, bounds, duration, wait time, retry count
- **Console** — Test code `console.log/warn/error` and device logcat output, color-coded by level
- **Source** — Test source code with the relevant line highlighted
- **Hierarchy** — Android view hierarchy XML with searchable tree view
- **Network** — HTTP requests captured during the test (see [Network Capture](#network-capture) below)
- **Errors** — Error message, stack trace, and assertion expected/actual values

## Network Capture

Pilot can capture HTTP/HTTPS traffic from the device during test execution. Network requests are recorded alongside other trace data and displayed in the trace viewer's Network tab.

### Enabling network capture

Network capture is enabled by default when tracing is active. Control it with the `network` field in `TraceConfig`:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  trace: {
    mode: "retain-on-failure",
    network: true, // default — capture HTTP traffic
  },
});
```

To disable network capture while keeping other trace features:

```typescript
trace: {
  mode: "on",
  network: false,
}
```

### How it works

When network capture is enabled, the Rust daemon starts a local MITM proxy and routes the device's traffic through it. Each request and response is recorded with method, URL, headers, status code, timing, and body data.

**Android** — the daemon uses `adb reverse` to forward the proxy port to the device and configures the device's HTTP proxy setting via `adb shell settings put global http_proxy`.

**iOS simulator** — the daemon spawns the `Mitmproxy Redirector.app` launcher (from a local `brew install mitmproxy`), which triggers the macOS Network Extension that ships with mitmproxy. The NE intercepts TCP flows from the simulator's process tree on a per-PID basis and redirects them into Pilot's MITM proxy over a per-worker Unix socket. Parallel iOS workers each get their own isolated session. See [iOS network capture](./ios-network-capture.md) for first-run setup (one-time System Extension approval) and troubleshooting.

**iOS physical device** — not yet supported; follow-up work.

**HTTPS support:** The proxy auto-generates a CA certificate and installs it on the device so it can decrypt TLS traffic. For simulators this happens transparently via `xcrun simctl keychain add-root-cert`; for Android it is pushed via `adb`. The client's TLS ClientHello SNI is extracted at MITM time so the upstream TLS handshake uses the real hostname (critical for CDN-hosted endpoints).

### Network tab in the trace viewer

The Network tab shows a sortable table of all captured requests:

| Column | Description |
|---|---|
| **Method** | HTTP method (GET, POST, PUT, etc.) |
| **URL** | Full request URL |
| **Status** | HTTP status code, color-coded (green for 2xx, blue for 3xx, yellow for 4xx, red for 5xx) |
| **Type** | Shortened content type (json, html, text, etc.) |
| **Duration** | Time from request start to response end |
| **Size** | Response body size |

Click a row to expand it and see full details:
- **Request headers** and **response headers**
- **Request body** and **response body** (JSON bodies are pretty-printed)

Use the filter bar to search by URL and the status buttons (All / 2XX / 3XX / 4XX / 5XX) to narrow results. Click column headers to sort.

## Trace Archive Format

Traces are stored as `.zip` files containing:

```
trace.zip/
  metadata.json      # Device, test, version info
  trace.json         # NDJSON event log
  screenshots/       # PNGs (action-003-before.png, action-003-after.png)
  hierarchy/         # View hierarchy XML snapshots
  sources/           # Test source files
  network.json       # NDJSON network request log (when network capture is enabled)
  network/           # Large request/response body files
```

The format uses `version: 1` for forward compatibility.

## CI Integration

### Capturing traces in GitHub Actions

```yaml
- name: Run tests
  run: npx pilot test --trace retain-on-failure

- name: Upload traces
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: pilot-traces
    path: pilot-results/traces/
    retention-days: 30
```

### Viewing CI traces

Download the trace artifact from your CI run and open it:

```bash
npx pilot show-trace pilot-results/traces/trace-login_test.zip
```

## Deep Linking

The trace viewer supports URL parameters for sharing specific views:

- `?trace=/path/to/trace.zip` — load a trace file
- `?action=5` — jump to the 5th action
