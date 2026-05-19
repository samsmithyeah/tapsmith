---
title: Test Runner
description: "Define tests, describe blocks, hooks, fixtures, projects, and configuration."
---

Tapsmith includes a built-in test runner with an API inspired by Jest and Playwright.

### `test(name: string, fn: (fixtures: TestFixtures) => Promise<void>): void`

Register a test. The test function receives a `fixtures` object containing a `device` instance.

```typescript
test("user can log in", async ({ device }) => {
  await device.getByText("Sign In", { exact: true }).tap();
});
```

### `test.only(name, fn)`

Run only this test (and other tests marked with `.only`). All other tests are skipped.

```typescript
test.only("focused test", async ({ device }) => {
  // Only this test will run
});
```

### `test.skip(name, fn)`

Skip this test.

```typescript
test.skip("broken test", async ({ device }) => {
  // This test will not run
});
```

### `test.use(options: UseOptions): void`

Override configuration options for all tests in the current describe scope. Overrides cascade — inner describe blocks inherit and can further override outer ones.

```typescript
describe("slow animations screen", () => {
  test.use({ timeout: 60000 })

  test("animation completes", async ({ device }) => {
    // runs with 60s timeout instead of the default
  })
})
```

Multiple calls in the same scope merge together:

```typescript
describe("custom config", () => {
  test.use({ timeout: 60000 })
  test.use({ screenshot: "always" })
  // equivalent to: test.use({ timeout: 60000, screenshot: "always" })
})
```

**`UseOptions`**

| Option       | Type                                        | Description                                  |
| ------------ | ------------------------------------------- | -------------------------------------------- |
| `timeout`    | `number`                                    | Action/assertion timeout (ms)                |
| `screenshot` | `'always' \| 'only-on-failure' \| 'never'` | Screenshot capture mode                      |
| `retries`    | `number`                                    | Retry count for failed tests                 |
| `trace`      | `TraceMode \| Partial<TraceConfig>`         | Trace recording configuration. See [configuration](/reference/configuration/) for the full `TraceConfig` shape (includes `network`, `networkHosts`, `networkIgnoreHosts`, `screenshots`, etc.). |
| `video`      | `VideoMode \| Partial<VideoConfig>`         | Video recording configuration. See the [Video recording](./cli/#video-recording) section. |
| `appState`   | `string`                                    | Path to saved app state archive to restore   |

The following device-shaping fields may **only** be set on a project's
`use` block (not via `test.use()`), since the device is bound to the
worker before any test runs:

| Option            | Type                                  | Description                              |
| ----------------- | ------------------------------------- | ---------------------------------------- |
| `platform`        | `'android' \| 'ios'`                  | Target platform for this project         |
| `device`          | `string`                              | Explicit device serial / iOS UDID        |
| `avd`             | `string`                              | Android AVD name to launch               |
| `simulator`       | `string`                              | iOS simulator name or UDID               |
| `apk`             | `string`                              | Path to Android APK under test           |
| `app`             | `string`                              | Path to iOS .app bundle under test       |
| `package`         | `string`                              | Android package name / iOS bundle ID     |
| `activity`        | `string`                              | Optional Android launcher activity       |
| `agentApk`        | `string`                              | Override path to the Android agent APK   |
| `agentTestApk`    | `string`                              | Override path to the Android agent test APK |
| `iosXctestrun`    | `string`                              | Override path to the iOS .xctestrun file |
| `deviceStrategy`  | `'prefer-connected' \| 'avd-only'`    | Device selection strategy (Android)      |
| `launchEmulators` | `boolean`                             | Auto-launch emulators (Android)          |
| `resetAppDeepLink`| `string`                              | Soft-reset deep link between files       |
| `resetAppWaitMs`  | `number`                              | Wait after the reset deep link           |

**Reusable auth state** — mirrors Playwright's `storageState`:

```typescript
// Setup: authenticate once and save state
test("authenticate", async ({ device }) => {
  await device.launchApp("com.example.myapp");
  // ... perform login flow ...
  await device.saveAppState("com.example.myapp", "./auth-state.tar.gz");
});

// Tests: restore state instead of logging in
describe("authenticated tests", () => {
  test.use({ appState: "./auth-state.tar.gz" });

  test("shows profile", async ({ device }) => {
    // Already logged in — no login flow needed
  });
});
```

### `TestFixtures`

The fixtures object passed to every test function. Destructure the fields you need:

```typescript
test("example", async ({ device, request, projectName, platform }) => {
  // device — the primary interface for interacting with the mobile device
  // request — HTTP client for API calls (seeding data, fetching tokens, etc.)
  // projectName — current project name (when using multi-project config), or undefined
  // platform — resolved platform: "android" or "ios"
});
```

| Fixture | Type | Description |
|---|---|---|
| `device` | `Device` | Primary interface for interacting with the mobile device |
| `request` | `APIRequestContext` | HTTP client for API calls. See [API Request Fixture](./request/). |
| `projectName` | `string \| undefined` | Name of the current project (from `projects` config). `undefined` when no projects are configured. |
| `platform` | `'android' \| 'ios'` | Resolved target platform for the current worker. |

### `test.extend<T>(definitions): TestFn`

Create a new test function with additional custom fixtures. Follows the same pattern as Playwright's `test.extend()`.

Each fixture definition is a function that receives all other fixtures and a `use` callback. The fixture sets up its value, passes it to `use()`, and optionally cleans up after `use()` resolves.

```typescript
import { test as base, expect } from "tapsmith";

// Define a custom fixture that seeds a todo item via the API before each test
const test = base.extend<{ todoId: string }>({
  todoId: async ({ request }, use) => {
    // Setup: create a todo item via the API
    const res = await request.post("https://api.example.com/todos", {
      data: { title: "Buy groceries", completed: false },
    });
    const { id } = await res.json() as { id: string };

    // Provide the fixture value to the test
    await use(id);

    // Teardown: clean up after the test (runs even if the test fails)
    await request.delete(`https://api.example.com/todos/${id}`);
  },
});

test("can mark todo as complete", async ({ device, todoId, request }) => {
  await device.getByText("Refresh").tap();
  await device.getByText("Buy groceries").tap();
  await expect(device.getByRole("checkbox")).toBeChecked();

  // Verify the change persisted via the API
  const res = await request.get(`https://api.example.com/todos/${todoId}`);
  const todo = await res.json() as { completed: boolean };
  expect(todo.completed).toBe(true);
});
```

> **For authentication**, prefer setup projects with `device.saveAppState()` and `test.use({ appState })` instead of custom fixtures. This mirrors Playwright's `storageState` pattern — authenticate once, save to a file, and restore across all tests. See the [auth state example](#reusable-auth-state) above and the Authentication patterns section in the Writing Tests guide.

**Fixture scopes:**

By default, fixtures have `test` scope (created and torn down for each test). Use a tuple to specify `worker` scope (created once per worker, shared across tests):

```typescript
const test = base.extend<{ apiToken: string }>({
  apiToken: [async ({ request }, use) => {
    const res = await request.post("https://api.example.com/auth/service-token", {
      data: { clientId: process.env.API_CLIENT_ID },
    });
    const { token } = await res.json() as { token: string };
    await use(token);
  }, { scope: "worker" }],
});
```

| Scope | Lifecycle | Use for |
|---|---|---|
| `test` (default) | Created before each test, torn down after | Per-test data (seeded records, temp files) |
| `worker` | Created once when the worker starts, torn down when it ends | Expensive setup (API tokens, database connections) |

Custom fixtures can depend on other custom fixtures — they're resolved in dependency order automatically.

### `describe(name: string, fn: () => void): void`

Group tests into a suite.

```typescript
describe("Login flow", () => {
  test("valid credentials", async ({ device }) => { /* ... */ });
  test("invalid credentials", async ({ device }) => { /* ... */ });
});
```

### `describe.only(name, fn)` / `describe.skip(name, fn)`

Focus or skip an entire suite.

### `beforeAll(fn: (fixtures) => void | Promise<void>): void`

Run a function once before all tests in the current suite. Receives `{ device, projectName }`.

```typescript
beforeAll(async ({ device }) => {
  // One-time setup for the suite
  await device.launchApp("com.example.myapp", { clearData: true });
});
```

### `afterAll(fn: (fixtures) => void | Promise<void>): void`

Run a function once after all tests in the current suite. Receives `{ device, projectName }`.

### `beforeEach(fn: (fixtures) => void | Promise<void>): void`

Run a function before each test in the current suite. Hooks are inherited by nested suites. Receives `{ device, projectName }`.

```typescript
beforeEach(async ({ device }) => {
  await device.restartApp("com.example.myapp");
});
```

### `afterEach(fn: (fixtures) => void | Promise<void>): void`

Run a function after each test in the current suite. Runs even if the test fails. Receives `{ device, projectName }`.

> **Note:** Hooks receive `device` and `projectName` only. The `request` fixture is test-scoped and only available inside `test()` callbacks. `platform` is not currently passed to hooks — if you need the platform in a hook, read it from the config or use `projectName` to infer it.
