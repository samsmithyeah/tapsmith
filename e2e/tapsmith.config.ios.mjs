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
      name: "notifications-denied",
      use: { permissions: { notifications: "denied" } },
      testMatch: ["**/notification-permission-denied.test.ts"],
    },
  ],
})
