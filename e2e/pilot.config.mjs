import "dotenv/config"
import { defineConfig } from "pilot"

// ─── Multi-device config ───
//
// Demonstrates the device-per-project feature: one `pilot test` invocation
// runs the suite on both Android and iOS in parallel. Each project has its
// own device target via `use:`.
//
// Usage:
//   pilot test                     # uses each project's explicit `workers` count
//   pilot test --workers 1         # global=1; explicit per-project workers still apply
//   pilot test --ui                # UI mode shows both project trees + per-device mirrors
//
// To run only one platform, use the dedicated single-device configs:
//   pilot test -c pilot.config.android.mjs
//   pilot test -c pilot.config.ios.mjs
//
// Authentication-dependent tests (`app-state.test.ts`, `auth-gate.test.ts`)
// are intentionally excluded here — they require a per-platform auth state
// path which `auth.setup.ts` does not yet differentiate. Run those via the
// platform-specific configs.

const ANDROID_USE = {
  platform: "android",
  apk: "../test-app/android/app/build/outputs/apk/release/app-release.apk",
  activity: "dev.pilot.testapp.MainActivity",
  avd: "Pilot_Generic_Phone_API_35",
  launchEmulators: true,
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
}

const IOS_USE = {
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/PilotTestApp.app",
  simulator: process.env.PILOT_IOS_SIMULATOR || "iPhone 17",
}

export default defineConfig({
  package: "dev.pilot.testapp",
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    networkHosts: ["jsonplaceholder.typicode.com"]
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
      use: { ...ANDROID_USE, appState: "./pilot-results/auth-state-android-auth-setup.tar.gz" },
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
      use: { ...IOS_USE, appState: "./pilot-results/auth-state-ios-auth-setup.tar.gz" },
    },
  ],
})
