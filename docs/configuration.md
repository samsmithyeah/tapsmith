# Configuration

Pilot is configured through a `pilot.config.ts` file in your project root. All options have sensible defaults, so a minimal config is just a few lines.

## Basic Setup

Create `pilot.config.ts` in your project root:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
});
```

Pilot also supports `pilot.config.js` and `pilot.config.mjs` if you prefer plain JavaScript.

For clean emulators or CI devices, `apk` is the important setting because it lets
Pilot install the app under test itself. `activity` is optional and mainly
useful as a stability hint when you want Pilot to launch a specific activity.
For emulator-managed runs, the recommended path is `launchEmulators + avd`.

## All Options

| Option | Type | Default | Description |
|---|---|---|---|
| `platform` | `"android" \| "ios"` | auto-detected | Target platform. Auto-detected from `apk` (Android) or `app` (iOS). |
| `apk` | `string` | `undefined` | Path to the APK under test (Android). |
| `app` | `string` | `undefined` | Path to the .app bundle under test (iOS simulator). |
| `package` | `string` | `undefined` | Package name (Android) or bundle identifier (iOS) of the app under test. When set, Pilot launches the app before tests. |
| `activity` | `string` | `undefined` | Optional activity name to launch (Android only). Usually not needed; Pilot will try the default launcher activity automatically. |
| `timeout` | `number` | `30000` | Default timeout in milliseconds for actions and assertions. |
| `retries` | `number` | `0` | Number of times to retry a failed test. |
| `screenshot` | `ScreenshotMode` | `"only-on-failure"` | When to capture screenshots: `"always"`, `"only-on-failure"`, or `"never"`. |
| `testMatch` | `string[]` | `["**/*.test.ts", "**/*.spec.ts"]` | Glob patterns for discovering test files. |
| `daemonAddress` | `string` | `"localhost:50051"` | Address of the Pilot daemon (host:port). |
| `daemonBin` | `string` | `undefined` | Path to the `pilot-core` binary. Defaults to `"pilot-core"` (must be on `PATH`). Set this if the binary is not on your PATH. |
| `device` | `string` | `undefined` | Explicit single-device override. Useful for debugging or forcing one specific physical device/emulator/simulator. |
| `deviceStrategy` | `"prefer-connected" \| "avd-only"` | contextual | Optional override for device selection (Android). Defaults to `"avd-only"` when `avd` is set, otherwise `"prefer-connected"`. |
| `rootDir` | `string` | `process.cwd()` | Working directory for test discovery. |
| `outputDir` | `string` | `"pilot-results"` | Directory for screenshots and other artifacts. |
| `agentApk` | `string` | `undefined` | Path to the Pilot agent APK (Android). |
| `agentTestApk` | `string` | `undefined` | Path to the Pilot agent test APK (Android). |
| `iosXctestrun` | `string` | `undefined` | Path to the iOS agent `.xctestrun` file. |
| `simulator` | `string` | `undefined` | iOS simulator name or UDID. Run `xcrun simctl list devices` to see available simulators. |
| `reporter` | `ReporterConfig` | auto-detected | Reporter output configuration. Defaults to `list` locally and `dot` in CI. |
| `workers` | `number` | `1` | Number of parallel workers. Each worker needs its own device/emulator/simulator. |
| `shard` | `{ current: number; total: number }` | `undefined` | Shard specification for splitting a run across multiple machines. Usually set via `--shard=x/y`. |
| `launchEmulators` | `boolean` | `false` | Automatically launch Android emulators to fill the requested worker count. |
| `avd` | `string` | `undefined` | AVD name to use for `launchEmulators` (Android). When set, Pilot launches repeated instances of this AVD. |
| `trace` | `TraceMode \| Partial<TraceConfig>` | `"off"` | Trace recording mode. See [TraceMode](#tracemode) below. |

### `ScreenshotMode`

```typescript
type ScreenshotMode = "always" | "only-on-failure" | "never";
```

- `"always"` -- Capture a screenshot after every test, pass or fail.
- `"only-on-failure"` -- Capture a screenshot only when a test fails. This is the default.
- `"never"` -- Never capture screenshots.

### `ReporterConfig`

```typescript
type ReporterDescription = string | [string, Record<string, unknown>];
type ReporterConfig = ReporterDescription | ReporterDescription[];
```

Built-in reporter names are:

- `"list"`
- `"line"`
- `"dot"`
- `"json"`
- `"junit"`
- `"html"`
- `"github"`
- `"blob"`

Examples:

```typescript
reporter: "list"
reporter: ["json", { outputFile: "pilot-report.json" }]
reporter: [["html", { outputFolder: "pilot-report" }], "list"]
```

### `TraceMode`

```typescript
type TraceMode = "off" | "on" | "on-first-retry" | "on-all-retries" | "retain-on-failure" | "retain-on-first-failure";
```

- `"off"` -- No tracing.
- `"on"` -- Record and keep traces for every test.
- `"on-first-retry"` -- Record traces only on the first retry of a failed test.
- `"on-all-retries"` -- Record traces on every retry.
- `"retain-on-failure"` -- Always record, but delete the trace zip if the test passes.
- `"retain-on-first-failure"` -- Always record, but only keep traces for the first failure (attempt 0).

### `TraceConfig`

For fine-grained control, pass an object instead of a mode string:

```typescript
interface TraceConfig {
  mode: TraceMode;       // Recording mode (default: "off")
  screenshots: boolean;  // Capture before/after screenshots (default: true)
  snapshots: boolean;    // Capture view hierarchy XML (default: true)
  sources: boolean;      // Include test source files (default: true)
  attachments: boolean;  // Include user attachments (default: true)
  network: boolean;      // Capture HTTP/HTTPS traffic via proxy (default: true)
}
```

When `network` is enabled, the Rust daemon starts an HTTP proxy and configures the device to route traffic through it. HTTPS traffic is decrypted using an auto-generated CA certificate installed on the device.

Example:

```typescript
trace: {
  mode: "retain-on-failure",
  screenshots: true,
  snapshots: true,
  sources: false,
  network: true,
}
```

## Example Configurations

### Minimal (Android)

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
});
```

### Minimal (iOS)

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  app: "./build/MyApp.app",
});
```

### Custom Timeout

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  timeout: 15_000, // 15 seconds instead of 30
});
```

### Auto-Launch The App

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-release.apk",
  package: "com.example.myapp",
});
```

If your app has an unusual launcher setup, you can also provide `activity`, but
most apps do not need it:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-release.apk",
  package: "com.example.myapp",
  activity: ".MainActivity", // Optional
});
```

### CI Configuration (Android)

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  timeout: 60_000, // Longer timeout for slower CI emulators
  retries: 2, // Retry failed tests up to 2 times
  screenshot: "always", // Capture screenshots for every test
  outputDir: "test-artifacts", // CI-friendly output directory
  reporter: ["junit", { outputFile: "pilot-junit.xml" }],
});
```

### CI Configuration (iOS)

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  app: "./build/MyApp.app",
  package: "com.example.myapp",
  simulator: "iPhone 17",
  timeout: 60_000,
  retries: 2,
  screenshot: "always",
  outputDir: "test-artifacts",
  reporter: ["junit", { outputFile: "pilot-junit.xml" }],
});
```

### Custom Test Patterns

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  testMatch: [
    "e2e/**/*.test.ts",
    "integration/**/*.spec.ts",
  ],
});
```

### Parallel Emulator Configuration

This is the recommended setup for parallel local or CI runs when you want Pilot
to manage emulator instances for you:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-release.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
});
```

With this setup, Pilot will try to launch repeated read-only instances of the
same AVD for all workers.

If you want the opposite behavior, set `deviceStrategy: "prefer-connected"` to
let Pilot reuse unrelated healthy connected devices first even when `avd` is
configured.

### Explicit Device Override

If you need to reproduce an issue on one known device, set `device` or use the
`--device` CLI flag:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  device: "emulator-5554",
});
```

The CLI flag takes precedence over the config file:

```bash
# Overrides the device from config
npx pilot test --device R5CR10XXXXX
```

For multi-worker runs, prefer `launchEmulators + avd` instead of `device`.

### Custom Daemon Address

If you are running the Pilot daemon on a different host or port:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  daemonAddress: "192.168.1.100:50051",
});
```

### Custom Agent APK Paths

If you build the Pilot agent artifacts outside the default location, point Pilot
at them explicitly:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk: "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
});
```

### Projects with Per-Device Targeting

Mirroring Playwright's `projects` concept, you can define named groups of test
files that each target their own device. This is the canonical way to run the
same suite against Android and iOS in a single `pilot test` invocation.

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  // Top-level fields are inherited by every project as defaults.
  package: "com.example.app",
  timeout: 30_000,

  projects: [
    {
      name: "Pixel 6",
      use: {
        platform: "android",
        avd: "Pixel_6_API_34",
        apk: "./android/app-debug.apk",
        launchEmulators: true,
      },
    },
    {
      name: "iPhone 16",
      use: {
        platform: "ios",
        simulator: "iPhone 16",
        app: "./ios/MyApp.app",
        iosXctestrun: "./ios-agent/PilotAgent.xctestrun",
      },
    },
  ],
});
```

Each project provisions its own device, daemon, and agent. There are two ways
to control parallelism:

**Global budget** (Playwright-style): the top-level `workers` field is split
across projects proportionally to file count, with at least 1 per project.

```typescript
export default defineConfig({
  workers: 4,
  projects: [
    { name: "Pixel 6", use: { /* ... */ } },
    { name: "iPhone 16", use: { /* ... */ } },
  ],
});
```

**Explicit per-project workers** (recommended for multi-device configs):
each project sets its own `workers` count. These are **additive** — they do
not consume from the global budget — so you can mix explicit and unset
projects in the same config.

```typescript
export default defineConfig({
  projects: [
    { name: "Pixel 6",   workers: 2, use: { /* ... */ } },
    { name: "iPhone 16", workers: 1, use: { /* ... */ } },
  ],
});
```

With `pilot test`, the Android project runs on 2 devices and the iOS project
runs on 1 — concurrently. The total worker count (3) is computed automatically.

If the total comes out to 1 (e.g. global `workers: 1` and no per-project
overrides), Pilot runs the projects sequentially, tearing down and
re-provisioning the device between each — useful when you only have one
machine and want to exercise both platforms in CI.

The same configuration also works with `--ui` and `--watch`. UI mode shows
each project's tests grouped under its name, and routes file execution to
the matching device. Watch mode re-runs only the affected project's files
on its own device when you edit a test.

Inside a project, the `use` field accepts the same device-shaping fields
as the top-level config (`platform`, `avd`, `simulator`, `app`, `apk`,
`package`, `iosXctestrun`, `launchEmulators`, etc.) plus the existing
`timeout`, `screenshot`, `retries`, `trace`, and `appState` overrides.

> **Note:** A single project must not mix Android (`avd`/`apk`) and iOS
> (`simulator`/`app`) fields. Pilot validates this at startup.

### Sharded Runs

Use sharding when you want to split a suite across multiple CI jobs:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  shard: { current: 1, total: 4 },
});
```

In practice, most users set this via the CLI instead:

```bash
npx pilot test --shard=1/4
```

## Config File Resolution

Pilot searches for configuration files in this order:

1. `pilot.config.ts`
2. `pilot.config.js`
3. `pilot.config.mjs`

If no config file is found, Pilot uses the default values for all options.

For `.ts` config files, Pilot relies on `tsx` or `ts-node` being available in your environment. If you installed Pilot via npm, this should work out of the box.
