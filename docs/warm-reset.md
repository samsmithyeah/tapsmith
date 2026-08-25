# Warm App Reset

Tapsmith resets your app to a known state before tests (see [Test isolation](writing-tests.md#test-isolation)). By default that means wiping app data and cold-launching — fully hermetic, but 7–13 seconds per file on an iOS simulator and a couple of seconds on Android. A **warm reset** asks the running app to reset *itself*, in-process, and acknowledges completion — well under a second. It also lets Tapsmith isolate **every test** instead of every file, because it can finally afford to.

## Add the in-app hooks

Install `@tapsmith/react-native` in your app and mount it once at the root:

```bash
npm install @tapsmith/react-native
```

```tsx
// app/_layout.tsx (Expo Router) — or your root component
import AsyncStorage from "@react-native-async-storage/async-storage"
import * as Linking from "expo-linking"
import { TapsmithTestHooks } from "@tapsmith/react-native"

export default function RootLayout() {
  return (
    <>
      <Stack />
      <TapsmithTestHooks urlPrefix={Linking.createURL("/")} clear={[AsyncStorage]} />
    </>
  )
}
```

That is the whole integration. **No Tapsmith config changes**: `appReset: 'auto'` detects the hooks in the app's accessibility tree and switches to `warm · per test`. Scopes with `beforeAll` hooks are the exception: they share setup between tests, so they are reset once on entry (set `appResetScope: 'test'` to override). Your existing `beforeEach` resets keep working (the lint rule `tapsmith/prefer-app-reset-option` will point out the ones that are now redundant).

| Prop | Purpose |
|---|---|
| `clear` | Stores to wipe on every reset — anything with `clear()` or `clearAll()`: AsyncStorage, MMKV, … |
| `onReset` | Your own reset: sign out, drop in-memory caches, reset navigation. Receives `{ target, nonce }`. |
| `urlPrefix` / `scheme` | How Tapsmith builds reset links into your app. Expo: `Linking.createURL("/")` (works in Expo Go and standalone builds). Bare React Native: `scheme="myapp"`. |
| `enabled` | Defaults to `__DEV__` **or** the build-time flag `EXPO_PUBLIC_TAPSMITH_HOOKS=1`. Production builds without the flag render nothing and register nothing. |

`registerTapsmithReset(fn)` registers a handler from non-React code.

### Release builds for e2e

Release builds strip `__DEV__`. Set `EXPO_PUBLIC_TAPSMITH_HOOKS=1` in the environment of the build that your tests run against (the repo's own e2e workflows do this). Never ship a build with the flag to users: a reset link can clear local storage and navigate the app.

## How a warm reset works

1. The component renders a tiny marker in the accessibility tree — `tapsmith-hooks:1;epoch=<n>;url=<prefix>` — that Tapsmith reads once after launch (that is the detection) and again after every reset.
2. To reset, Tapsmith opens `<prefix><route>?__tapsmith_reset=1&nonce=…` — a normal deep link, so your router lands on `route` while the hooks clear the stores and run `onReset`.
3. The hooks bump `epoch`. Tapsmith waits for the epoch to advance — that is the **acknowledgement**; no fixed sleeps. If your handler throws, the epoch still advances and the marker carries `err=…`, so Tapsmith reports the failure and falls back instead of hanging.

The whole ladder — warm → restart → clear — runs in the daemon (`ResetApp`), and the trace records which rung ran and why: *"warm reset via @tapsmith/react-native (epoch 4→5), 0.4s"*, or *"warm reset via in-app hooks failed (…); fell back to restart"*.

### Bounding the warm window on iOS simulators

Long all-warm sessions on a simulator can drift from a fresh launch (accessibility trees stop being flattened, element ids go stale). Tapsmith therefore relaunches cold every `appResetColdEvery` warm resets (default 10), on every retry attempt, and after two warm resets in a row fail to verify. The trace says so: *"cold relaunch: warm-window bound reached (10 resets)"*. Set `appResetColdEvery: 0` to disable the valve.

## Without the module

Everything still works: `appReset: 'auto'` resolves to `clear · per file`. The legacy `resetAppDeepLink` option (a route your app handles by resetting itself) also still gives you `warm · per file`, without acknowledgement — Tapsmith waits `resetAppWaitMs` after opening it.

## Calling it yourself

`device.resetApp()` runs the same ladder from inside a test and returns what actually happened:

```typescript
const result = await device.resetApp({ target: "/settings" })
// result.modeUsed === 'warm', result.hooksDetected === true, result.durationMs ≈ 400
```

See [`device.resetApp`](api-reference.md#deviceresetappoptions-promiseappresetresult).
