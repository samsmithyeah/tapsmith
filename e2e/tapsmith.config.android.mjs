import { defineConfig } from "tapsmith";
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs";

export default defineConfig({
  apk: "../test-app/android/app/build/outputs/apk/release/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  package: "dev.tapsmith.testapp",
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 15_000,
  retries: 0,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  workers: 2,
  trace: { mode: "retain-on-failure", daemonLogs: true },
  avd: "Tapsmith_Phone_API_36",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  // PILOT-291: mirrors the CI configs so local runs exercise the same
  // permissions plumbing (see tapsmith.config.android-ci.mjs).
  permissions: { notifications: "granted" },
  projects: [
    {
      name: "authentication",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: [
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
        "**/notification-permission-denied.test.ts",
        "**/webview*.test.ts",
        "**/*.ios.test.ts",
      ],
    },
    {
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
    {
      name: "notifications-denied",
      use: { permissions: { notifications: "denied" } },
      testMatch: ["**/notification-permission-denied.test.ts"],
    },
  ],
});
