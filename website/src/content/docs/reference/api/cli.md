---
title: CLI
description: "Command-line interface, flags, and video recording."
---

## Commands

### `tapsmith test [files...]`

Run test files. If no files are specified, discovers tests using the `testMatch` patterns from your config.

```bash
npx tapsmith test
npx tapsmith test tests/login.test.ts tests/signup.test.ts
```

### `tapsmith test --device <serial>` / `tapsmith test -d <serial>`

Target a specific device by its ADB serial number. This is mainly useful for
single-device debugging or reproducing an issue on one known device.

```bash
npx tapsmith test --device emulator-5554
```

For multi-worker emulator runs, prefer config-based provisioning with
`workers`, `launchEmulators`, and `avd`.

### `tapsmith test --workers <n>` / `tapsmith test -j <n>`

Run tests in parallel across `n` devices. Each worker gets its own device/emulator and daemon instance. Tests are distributed via a work-stealing queue for natural load balancing.

```bash
npx tapsmith test --workers 4
npx tapsmith test -j 2
```

Overrides the `workers` config option. Requires enough connected devices or `launchEmulators: true` with an `avd` configured. In parallel mode, each test result includes a `workerIndex` field and console reporters show `[worker N]` tags.

### `tapsmith test --shard=x/y`

Split the test suite deterministically across `y` machines, running only shard `x`. Shards are assigned by file index (`file_index % total === current - 1`).

```bash
# In a CI matrix with 4 jobs:
npx tapsmith test --shard=1/4
npx tapsmith test --shard=2/4
npx tapsmith test --shard=3/4
npx tapsmith test --shard=4/4
```

When sharding is active, the `blob` reporter is automatically added so results can be merged later with `tapsmith merge-reports`.

### `tapsmith test --grep <pattern>` / `tapsmith test -g <pattern>`

Run only the tests whose fullName (`describe > test`) matches the given regular expression. Mirrors Playwright's `--grep`.

```bash
npx tapsmith test --grep checkout            # Only tests with "checkout" in their fullName
npx tapsmith test -g "^login > "             # Only tests inside the top-level "login" describe
npx tapsmith test --grep "@smoke|@critical"  # Run smoke + critical tests by tag-style suffixes
```

The pattern is compiled as a JavaScript `RegExp`. Combine with `--grep-invert` to further narrow the selection.

The same filter can be set in `tapsmith.config.ts`:

```ts
export default defineConfig({
  grep: /checkout/,                  // single pattern
})

// Or match any of several patterns:
export default defineConfig({
  grep: [/login/, /signup/],         // any pattern matches
})
```

Per-project filters are intersected with the root filter (a test must match both):

```ts
export default defineConfig({
  grep: /smoke/,
  projects: [
    { name: 'android', grep: /android/ }, // runs tests matching BOTH /smoke/ and /android/
  ],
})
```

### `tapsmith test --grep-invert <pattern>`

Skip tests whose fullName matches the given regular expression. Mirrors Playwright's `--grep-invert`.

```bash
npx tapsmith test --grep-invert slow          # Run everything except "slow" tests
npx tapsmith test -g checkout --grep-invert wip  # Checkout tests, excluding work-in-progress
```

Also configurable in `tapsmith.config.ts` as `grepInvert: RegExp | RegExp[]`, with per-project entries unioned with the root entry.

### `tapsmith test --watch` / `tapsmith test -w`

Watch test files for changes and re-run them automatically. The daemon, device, and agent are kept alive across re-runs, so only the app reset + test execution cost is paid (~1-2s per re-run).

```bash
npx tapsmith test --watch
npx tapsmith test -w tests/login.test.ts   # Watch a specific file
```

See [Watch and UI Mode](watch-and-ui-mode.md) for details.

### `tapsmith test --ui`

Open the interactive UI mode in the browser. Provides a web-based test runner with a test tree, click-to-run, live progress, and an MCP endpoint for AI agent integration.

```bash
npx tapsmith test --ui
npx tapsmith test --ui --ui-port 8080   # Use a specific port
```

See [Watch and UI Mode](watch-and-ui-mode.md) for details.

### `tapsmith test --config <path>` / `tapsmith test -c <path>`

Use a specific config file instead of the default `tapsmith.config.ts`:

```bash
npx tapsmith test -c tapsmith.config.ci.ts
npx tapsmith test --config=./configs/ios.config.mjs
```

### `tapsmith test --force-install`

Force reinstall the APK/app and agent on every run, even if they're already installed. Useful when the app has been updated outside of Tapsmith, or when troubleshooting agent issues.

```bash
npx tapsmith test --force-install
```

Without this flag, Tapsmith checks if the package is already installed and skips the install step to save time.

### `tapsmith init`

Run the interactive setup wizard. Detects your environment (ADB, Xcode, simulators, emulators), walks you through platform and app configuration, and generates a `tapsmith.config.ts` file and an example test.

```bash
npx tapsmith init
```

### `tapsmith doctor`

Run a non-interactive system health check. Verifies all prerequisites: Node.js version, daemon binary, ADB (Android), agent APKs, Xcode (iOS), simulators, and iOS network capture dependencies. Exits with code 0 if all checks pass, 1 if any hard errors.

```bash
npx tapsmith doctor
```

### `tapsmith list-devices [--json]`

Print a table of every device Tapsmith can target: Android (ADB), iOS simulators (simctl), and iOS physical devices (devicectl). Each row shows a one-line status (`Ready` or an imperative fix). `--json` emits machine-readable JSON.

```bash
npx tapsmith list-devices
npx tapsmith list-devices --json
```

### `tapsmith show-trace <file.zip>`

Open the trace viewer in the default browser to inspect a recorded trace.

```bash
npx tapsmith show-trace test-results/traces/trace-my_test.zip
```

The trace viewer shows:
- **Actions panel** — chronological list of actions with icons, selectors, and durations
- **Timeline filmstrip** — screenshot thumbnails for quick navigation
- **Screenshot panel** — before/after screenshots with tap coordinate overlays
- **Detail tabs** — Call info, Console output, Source code, View hierarchy, Network requests, Errors
- **Keyboard navigation** — Arrow keys or j/k to move between actions

### `tapsmith test --trace <mode>`

Record traces during test execution. Overrides the `trace` config option.

```bash
npx tapsmith test --trace on                    # Record all tests
npx tapsmith test --trace retain-on-failure     # Only keep traces for failures
```

### `tapsmith test --video <mode>`

Record an MP4 of the device screen for the lifetime of each test. Mirrors
Playwright's `video` flag and overrides the `video` config option. Accepts
the same mode set as `--trace`. See [Video recording](#video-recording).

```bash
npx tapsmith test --video on                    # Record every test
npx tapsmith test --video retain-on-failure     # Only keep videos for failed tests
```

### `tapsmith test --network` / `tapsmith test --no-network`

Enable or disable network capture when tracing. By default, network capture is enabled whenever tracing is active. Use `--no-network` to disable it.

```bash
npx tapsmith test --trace on --no-network      # Trace without network capture
```

### `tapsmith merge-reports [dir]`

Merge blob reports from sharded CI runs into a single HTML report.

```bash
# After collecting all shard blob-report/ directories:
npx tapsmith merge-reports           # reads from blob-report/
npx tapsmith merge-reports ./blobs   # custom directory
```

### `tapsmith show-report [dir]`

Open the HTML test report in the default browser.

```bash
npx tapsmith show-report               # opens tapsmith-report/index.html
npx tapsmith show-report ./my-report   # custom directory
```

### iOS physical-device commands

These commands support running tests on USB-attached iPhones/iPads. See
[docs/ios-physical-devices.md](./ios-physical-devices.md) for the full
setup walkthrough.

#### `tapsmith list-devices [--json]`

Print a table of every device Tapsmith can target right now — Android (ADB),
iOS simulators (simctl), and iOS physical (devicectl) — with a one-line
status (`Ready` or an imperative fix). `--json` emits the row model for
scripting.

#### `tapsmith setup-ios-device [udid]`

Run the per-device preflight checklist for a physical iOS device: pairing,
Developer Mode, Developer Disk Image, USB transport, built agent cache,
firewall stealth mode, and the Xcode 26 CoreDevice sudo prompt probe.
Prints per-check `ok`/`fix` output and exits non-zero if anything blocks
`tapsmith test`. With no UDID, auto-selects the single attached device.

#### `tapsmith build-ios-agent [--team <id>] [--device|--simulator]`

Build the signed `TapsmithAgent` XCUITest bundle for the current device /
provisioning profile. Auto-detects the Apple Developer team ID from Xcode's
preferences (or keychain) if `--team` is omitted. The resulting
`.xctestrun` is cached under `~/.tapsmith/` and picked up automatically by
`tapsmith test`.

#### `tapsmith configure-ios-network <udid> [--ssid <name>] [--device-name <name>]`

Generate a `.mobileconfig` profile that routes the physical device's Wi-Fi
traffic through Tapsmith's MITM proxy for decrypted HTTPS capture, and reveal
it in Finder so you can AirDrop it to the device. `--ssid` targets a
specific Wi-Fi network (defaults to the host's current SSID); `--device-name`
sets the profile's `PayloadDisplayName`.

#### `tapsmith refresh-ios-network <udid>`

Regenerate the profile for a device whose host IP or Wi-Fi SSID has
changed since the last run. Same shape as `configure-ios-network` — the
difference is only wording in the output.

#### `tapsmith verify-ios-network <udid>`

End-to-end sanity check that the installed profile plus the trusted CA
actually produce decrypted HTTPS capture. Starts the proxy, asks you to
load an HTTPS page in Safari on the device, then reports whether Tapsmith
saw the request and could decrypt the body. Exits non-zero on failure
with fix-it hints for each failure mode.

### `tapsmith --version` / `tapsmith -v`

Print the Tapsmith version.

### `tapsmith --help` / `tapsmith -h`

Show help text with available commands and options.

## Video recording

Tapsmith records continuous screen video over the duration of each test,
mirroring Playwright's `video` config (PILOT-114). Retained videos land in
`<outputDir>/videos/` as `<safe-test-name>-<timestamp>.mp4` and are surfaced
on `TestResult.videoPath`. The HTML reporter embeds an inline `<video>`
element and a download link in each test's detail panel.

### Modes

```typescript
import { defineConfig } from 'tapsmith'

export default defineConfig({
  use: {
    video: 'retain-on-failure', // mode shorthand
    // — or —
    video: {
      mode: 'on',
      size: { width: 1280, height: 720 }, // Android only
    },
  },
})
```

The supported modes are the same as `trace`:

| Mode                        | Behaviour                                              |
| --------------------------- | ------------------------------------------------------ |
| `off`                       | No recording (default).                                |
| `on`                        | Record every test, retain every video.                 |
| `retain-on-failure`         | Record every test; keep videos only for failed tests.  |
| `retain-on-first-failure`   | Like `retain-on-failure` but limited to attempt 0.     |
| `on-first-retry`            | Record only on the first retry attempt.                |
| `on-all-retries`            | Record on every retry attempt (skips the first run).   |

### Implementation

| Platform              | Recorder                                                   |
| --------------------- | ---------------------------------------------------------- |
| Android               | `adb shell screenrecord` (3-min hard cap per recording).   |
| iOS Simulator         | `xcrun simctl io <udid> recordVideo --codec h264`.         |
| iOS physical device   | `ffmpeg -f avfoundation` — requires `ffmpeg` on `PATH`.    |

**Android 3-minute cap**: `screenrecord` truncates at 180 seconds. Recordings
of longer tests are truncated by the device-side encoder; the daemon emits
a one-time warning per test that exceeds the cap. Chained-segment recording
is on the roadmap.

**iOS physical devices**: ffmpeg's AVFoundation backend captures the
iPhone's screen via the CoreMediaIO video device that appears on macOS once
the device is paired in Xcode and you have accepted the "Trust This
Computer" prompt. The daemon resolves the device by friendly name; if
multiple iPhones are connected, name conflicts can cause the wrong device
to be recorded. See [ios-physical-devices.md](./ios-physical-devices.md).

**`size` option**: honoured on Android only (passed through as
`screenrecord --size WxH`). On iOS the daemon emits a one-time warning and
records at native resolution.
