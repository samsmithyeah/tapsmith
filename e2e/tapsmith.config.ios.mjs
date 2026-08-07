import "dotenv/config"
import { defineConfig } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs"

export default defineConfig({
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 2,
  trace: { mode: "retain-on-failure", daemonLogs: true },
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 17",
  // PILOT-291: mirrors the CI configs so local runs exercise the same
  // permissions plumbing (see tapsmith.config.ios-ci.mjs). workers: 2 above
  // additionally covers the parallel-dispatcher serialization path.
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
        "**/*.android.test.ts",
      ],
    },
    {
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
    // Must run after every project that assumes the root's "granted"
    // policy: notification permission is device-global per package, so a
    // session that flips it to "denied" while those tests are still running
    // changes state out from under them. `dependencies` is what actually
    // enforces that ordering — without it this project is scheduled in the
    // first wave and races them on a shared device.
    {
      name: "notifications-denied",
      dependencies: ["default", "authenticated"],
      use: { permissions: { notifications: "denied" } },
      testMatch: ["**/notification-permission-denied.test.ts"],
    },
  ],
})
