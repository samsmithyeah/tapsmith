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
  await device.tap(text("Add to Cart"));
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
- **Errors** — Error message, stack trace, and assertion expected/actual values

## Trace Archive Format

Traces are stored as `.zip` files containing:

```
trace.zip/
  metadata.json      # Device, test, version info
  trace.json         # NDJSON event log
  screenshots/       # PNGs (action-003-before.png, action-003-after.png)
  hierarchy/         # View hierarchy XML snapshots
  sources/           # Test source files
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
