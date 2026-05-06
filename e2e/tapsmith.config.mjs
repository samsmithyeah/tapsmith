import "dotenv/config"
import { defineConfig } from "tapsmith"

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
  apk: "./fixtures/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  avd: "Tapsmith_Generic_Phone_API_35",
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
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    networkHosts: ["jsonplaceholder.typicode.com"]
  },
  video: {
    mode: "retain-on-failure",
  },
  projects: [
    // ─── Android ───
    {
      name: "android:auth-setup",
      testMatch: ["**/auth.setup.ts"],
      use: { ...ANDROID_USE, timeout: 30_000 },
    },
    {
      name: "android",
      workers: 2,
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      use: ANDROID_USE,
    },
    {
      name: "android:authenticated",
      dependencies: ["android:auth-setup"],
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      use: { ...ANDROID_USE, appState: "./tapsmith-results/auth-state-android-auth-setup.tar.gz" },
    },

    // ─── iOS ───
    {
      name: "ios:auth-setup",
      testMatch: ["**/auth.setup.ts"],
      use: { ...IOS_USE, timeout: 30_000 },
    },
    {
      name: "ios",
      workers: 2,
      testMatch: ["**/*.test.ts"],
      testIgnore: [
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
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
  ],
})
