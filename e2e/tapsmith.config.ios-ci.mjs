import { defineConfig } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs"

export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 30_000,
  typingDelay: 10,
  // Two retries (Playwright's CI convention): runner-scoped outages
  // (compositor stalls, input-injection drops) can outlast a single retry
  // even after the framework's own recovery escalations.
  retries: 2,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    networkHosts: ["jsonplaceholder.typicode.com", "127.0.0.1"],
  },
  // on-first-retry: no encoder runs on healthy tests (PILOT-240); a failed
  // test's retry is recorded, so flake investigations still get a video.
  video: "on-first-retry",
  workers: 1,
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 16",
  iosXctestrun: process.env.TAPSMITH_IOS_XCTESTRUN || undefined,
  // PILOT-291: applied at the root so EVERY session in this suite exercises
  // the permissions plumbing (config serialization to workers, agent policy
  // handshake, BulletinBoard conflict reset) — not just the dedicated test.
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
    // Runs last: flipping the policy on the same device forces the full
    // conflict-reset path (recorded granted → uninstall/reinstall → agent
    // declines the prompt) plus a per-project session re-establishment.
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
