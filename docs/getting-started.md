# Getting Started

This guide walks you through installing Pilot, writing your first test, and running it against an Android device or emulator.

## Prerequisites

Before you begin, make sure you have the following installed:

| Requirement | Minimum version | How to check |
|---|---|---|
| Node.js | 18+ | `node --version` |
| ADB (Android Debug Bridge) | Any recent version | `adb --version` |
| Android device or emulator | Android 8.0+ (API 26+) | `adb devices` |

If you are using a single emulator or device, you can start it yourself and let
Pilot detect it automatically. Pilot can also launch emulator instances for you
when configured with `launchEmulators` and `avd`.

## Installation

```bash
npm install pilot
```

This installs the TypeScript SDK, test runner, and the Pilot daemon binary for your platform.

## Create a Configuration File

Create `pilot.config.ts` in your project root:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  timeout: 30_000,
  screenshot: "only-on-failure",
});
```

The only required option is `apk` -- the path to the Android APK you want to test. If you want Pilot to auto-launch the app before tests, also set `package`. `activity` is optional and usually not needed.

See the [Configuration](configuration.md) guide for all available options.

For parallel emulator runs, use:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
});
```

When `avd` is set, Pilot defaults to using that AVD for provisioned emulator
capacity. Set `deviceStrategy: "prefer-connected"` if you want connected
devices to win instead.

## Write Your First Test

Create a file at `tests/smoke.test.ts`:

```typescript
import { test, expect, text, role } from "pilot";

test("app launches and shows welcome screen", async ({ device }) => {
  // Wait for the welcome text to appear
  await expect(device.element(text("Welcome"))).toBeVisible();
});

test("can navigate to settings", async ({ device }) => {
  // Tap a button by its accessibility role and name
  await device.tap(role("button", "Settings"));

  // Verify we arrived at the settings screen
  await expect(device.element(text("Settings"))).toBeVisible();
});
```

A few things to note:

- Tests receive a `device` fixture automatically. This is your primary interface for interacting with the app.
- `text()`, `role()`, and other selector functions create selectors that identify UI elements. See the [Selectors Guide](selectors.md) for the full list.
- `expect()` creates assertions that auto-wait. `toBeVisible()` polls until the element appears or the timeout expires.

## Run Your Tests

```bash
npx pilot test
```

Pilot will:

1. Connect to the Pilot daemon (starting it if needed).
2. Detect your connected device or emulator.
3. Install the APK under test and the Pilot agent.
4. Discover all test files matching `**/*.test.ts` and `**/*.spec.ts`.
5. Run each test sequentially and report results.

For multi-worker runs, Pilot will assign one device per worker. If
`launchEmulators: true` is configured, it will launch additional emulator
instances automatically. If `avd` is set, those instances will use that AVD.

### Run a specific file

```bash
npx pilot test tests/smoke.test.ts
```

### Target a specific device

If you need to debug against one known device, specify which one to use:

```bash
npx pilot test --device emulator-5554
```

For normal parallel runs, prefer `workers + launchEmulators + avd` in config.

## Understanding the Output

Pilot prints results to the terminal with pass/fail status and timing for each test:

```
Found 2 test file(s)

  tests/smoke.test.ts

Results:

  PASS  app launches and shows welcome screen (1204ms)
  PASS  can navigate to settings (2841ms)

Summary: 2 passed | 4.05s
```

When a test fails, Pilot prints the error message, a partial stack trace, and the path to a screenshot captured at the moment of failure:

```
  FAIL  can navigate to settings (30012ms)
        Expected element {"text":"Settings"} to be visible, but it was not
        Screenshot: pilot-results/screenshots/can_navigate_to_settings-1710345600000.png
```

## Organizing Tests

You can use `describe` blocks and hooks to organize your tests:

```typescript
import { test, describe, beforeEach, expect, text, role, id } from "pilot";

describe("Login flow", () => {
  beforeEach(async () => {
    // Reset app state before each test if needed
  });

  test("successful login", async ({ device }) => {
    await device.type(id("email_input"), "user@example.com");
    await device.type(id("password_input"), "password123");
    await device.tap(text("Sign In"));
    await expect(device.element(text("Welcome back"))).toBeVisible();
  });

  test("invalid credentials", async ({ device }) => {
    await device.type(id("email_input"), "bad@example.com");
    await device.type(id("password_input"), "wrong");
    await device.tap(text("Sign In"));
    await expect(device.element(text("Invalid credentials"))).toBeVisible();
  });
});
```

## Next Steps

- Learn about choosing the right selectors in the [Selectors Guide](selectors.md).
- Browse the complete [API Reference](api-reference.md).
- Configure Pilot for your project in the [Configuration](configuration.md) guide.
- Set up automated testing in the [CI Setup](ci-setup.md) guide.
