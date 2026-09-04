import "dotenv/config"
import { defineConfig } from "tapsmith"

// ─── Multi-device (device group) config, Android ───
//
// Runs the `tests/multi-device/` suite: every test drives two emulators at
// once (PILOT-310). Needs two matching devices — Tapsmith launches a second
// instance of the AVD when only one is connected.
//
//   tapsmith test -c tapsmith.config.android-multi.mjs
//   tapsmith test -c tapsmith.config.android-multi.mjs --ui

export default defineConfig({
  apk: "../test-app/android/app/build/outputs/apk/release/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  package: "dev.tapsmith.testapp",
  timeout: 15_000,
  retries: 0,
  screenshot: "only-on-failure",
  trace: { mode: "retain-on-failure", daemonLogs: true },
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  projects: [
    {
      name: "pair",
      testMatch: ["**/multi-device/**/*.test.ts"],
      use: { devices: [{ name: "alice" }, { name: "bob" }] },
    },
  ],
})
