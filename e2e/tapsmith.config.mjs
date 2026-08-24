import "dotenv/config"
import { defineConfig } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs"

// ─── Multi-device config ───
//
// Demonstrates the device-per-project feature: one `tapsmith test` invocation
// runs the suite on both Android and iOS in parallel. Each project has its
// own device target via `use:`.
//
// Usage:
//   tapsmith test                     # uses each project's explicit `workers` count
//   tapsmith test --workers 1         # global=1; explicit per-project workers still apply
//   tapsmith test --ui                # UI mode shows both project trees + per-device mirrors
//
// To run only one platform, use the dedicated single-device configs:
//   tapsmith test -c tapsmith.config.android.mjs
//   tapsmith test -c tapsmith.config.ios.mjs
//
// Authentication-dependent tests (`app-state.test.ts`, `auth-gate.test.ts`)
// are intentionally excluded here — they require a per-platform auth state
// path which `auth.setup.ts` does not yet differentiate. Run those via the
// platform-specific configs.

const ANDROID_USE = {
  platform: "android",
  apk: "../test-app/android/app/build/outputs/apk/release/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
}

const IOS_USE = {
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 17",
}

export default defineConfig({
  package: "dev.tapsmith.testapp",
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    networkHosts: ["jsonplaceholder.typicode.com", "127.0.0.1"]
  },
  video: {
    mode: "retain-on-failure",
  },
  // PILOT-291: mirrors the CI configs so multi-device runs exercise the
  // permissions plumbing on both platforms at once.
  permissions: { notifications: "granted" },
  projects: [
    // ─── Android ───
    {
      name: "android:auth-setup",
      testMatch: ["**/auth.setup.ts"],
      use: { ...ANDROID_USE, timeout: 30_000 },
    },
    {
      name: "android",
      workers: 1,
      testMatch: ["**/*.test.ts"],
      testIgnore: [
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
        "**/notification-permission-denied.test.ts",
        "**/*.ios.test.ts",
      ],
      use: ANDROID_USE,
    },
    {
      name: "android:authenticated",
      dependencies: ["android:auth-setup"],
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      use: { ...ANDROID_USE, appState: "./tapsmith-results/auth-state-android-auth-setup.tar.gz" },
    },
    // Isolation from the "granted" projects comes from device-pool
    // serialization, not `dependencies`: this project has a different
    // deviceSignature, so it becomes its own bucket, and the dispatcher runs
    // same-pool buckets in sequential rounds (round order follows config
    // order, so this one runs last).
    //
    // Do NOT add `dependencies` here to express that ordering. Sharding
    // treats any depended-on project as an unsharded setup project, so
    // depending on `default` would make every shard run the entire suite
    // and starve the rest — shard 1 went from 11 files to 42 when this was
    // tried.
    {
      name: "android:notifications-denied",
      testMatch: ["**/notification-permission-denied.test.ts"],
      use: { ...ANDROID_USE, permissions: { notifications: "denied" } },
    },

    // ─── iOS ───
    {
      name: "ios:auth-setup",
      testMatch: ["**/auth.setup.ts"],
      use: { ...IOS_USE, timeout: 30_000 },
    },
    {
      name: "ios",
      workers: 1,
      testMatch: ["**/*.test.ts"],
      testIgnore: [
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
        "**/notification-permission-denied.test.ts",
        "**/*.android.test.ts",
      ],
      use: IOS_USE,
    },
    {
      name: "ios:authenticated",
      dependencies: ["ios:auth-setup"],
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      use: { ...IOS_USE, appState: "./tapsmith-results/auth-state-ios-auth-setup.tar.gz" },
    },
    // Isolation from the "granted" projects comes from device-pool
    // serialization, not `dependencies`: this project has a different
    // deviceSignature, so it becomes its own bucket, and the dispatcher runs
    // same-pool buckets in sequential rounds (round order follows config
    // order, so this one runs last).
    //
    // Do NOT add `dependencies` here to express that ordering. Sharding
    // treats any depended-on project as an unsharded setup project, so
    // depending on `default` would make every shard run the entire suite
    // and starve the rest — shard 1 went from 11 files to 42 when this was
    // tried.
    {
      name: "ios:notifications-denied",
      testMatch: ["**/notification-permission-denied.test.ts"],
      use: { ...IOS_USE, permissions: { notifications: "denied" } },
    },
  ],
})
