import { defineConfig } from "tapsmith"

// ─── Multi-device (device group) config, iOS simulator, CI ───
//
// The CI counterpart of tapsmith.config.ios-multi.mjs: same `pair` project,
// but the app comes from e2e/fixtures/ (where the workflow stages the built
// .app) rather than the repo's build output, the agent runs from the
// workflow's prebuilt xctestrun, and the retry / reporter settings match the
// sharded CI configs. Run by the `Multi-device` job of
// .github/workflows/e2e-ios.yml.

export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 30_000,
  typingDelay: 10,
  // Two retries (Playwright's CI convention): runner-scoped outages can
  // outlast a single retry even after the framework's own recovery.
  retries: 2,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    networkHosts: ["jsonplaceholder.typicode.com", "127.0.0.1"],
  },
  video: "on-first-retry",
  workers: 1,
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 16",
  iosXctestrun: process.env.TAPSMITH_IOS_XCTESTRUN || undefined,
  projects: [
    {
      name: "pair",
      testMatch: ["**/multi-device/**/*.test.ts"],
      use: { devices: [{ name: "alice" }, { name: "bob" }] },
    },
  ],
})
