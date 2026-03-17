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

## All Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apk` | `string` | `undefined` | Path to the APK under test. |
| `timeout` | `number` | `30000` | Default timeout in milliseconds for actions and assertions. |
| `retries` | `number` | `0` | Number of times to retry a failed test. |
| `screenshot` | `ScreenshotMode` | `"only-on-failure"` | When to capture screenshots: `"always"`, `"only-on-failure"`, or `"never"`. |
| `testMatch` | `string[]` | `["**/*.test.ts", "**/*.spec.ts"]` | Glob patterns for discovering test files. |
| `daemonAddress` | `string` | `"localhost:50051"` | Address of the Pilot daemon (host:port). |
| `daemonBin` | `string` | `undefined` | Path to the `pilot-core` binary. Defaults to `"pilot-core"` (must be on `PATH`). Set this if the binary is not on your PATH. |
| `device` | `string` | `undefined` | Target device serial. If unset, the daemon picks the first available device. |
| `rootDir` | `string` | `process.cwd()` | Working directory for test discovery. |
| `outputDir` | `string` | `"pilot-results"` | Directory for screenshots and other artifacts. |

### `ScreenshotMode`

```typescript
type ScreenshotMode = "always" | "only-on-failure" | "never";
```

- `"always"` -- Capture a screenshot after every test, pass or fail.
- `"only-on-failure"` -- Capture a screenshot only when a test fails. This is the default.
- `"never"` -- Never capture screenshots.

## Example Configurations

### Minimal

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
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

### CI Configuration

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  timeout: 60_000, // Longer timeout for slower CI emulators
  retries: 2, // Retry failed tests up to 2 times
  screenshot: "always", // Capture screenshots for every test
  outputDir: "test-artifacts", // CI-friendly output directory
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

### Multiple Devices

If you need to target a specific device, set the `device` option or use the `--device` CLI flag:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  device: "emulator-5554", // Always target this emulator
});
```

The CLI flag takes precedence over the config file:

```bash
# Overrides the device from config
npx pilot test --device R5CR10XXXXX
```

### Custom Daemon Address

If you are running the Pilot daemon on a different host or port:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  daemonAddress: "192.168.1.100:50051",
});
```

## Config File Resolution

Pilot searches for configuration files in this order:

1. `pilot.config.ts`
2. `pilot.config.js`
3. `pilot.config.mjs`

If no config file is found, Pilot uses the default values for all options.

For `.ts` config files, Pilot relies on `tsx` or `ts-node` being available in your environment. If you installed Pilot via npm, this should work out of the box.
