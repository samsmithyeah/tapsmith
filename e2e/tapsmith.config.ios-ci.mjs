import { defineConfig } from "tapsmith"

export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 15_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: { mode: "retain-on-failure", network: false },
  workers: 1,
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 16",
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
        "**/*.android.test.ts",
        "**/webview*.test.ts",
        // PILOT-TODO: network capture on iOS requires mitmproxy (not available on GHA runners)
        "**/network-capture.test.ts",
        "**/network-mocking.test.ts",
      ],
    },
    {
      // PILOT-TODO: iOS simulator app state restore doesn't work in CI —
      // saveAppState succeeds but the restored data isn't picked up on relaunch.
      // Works locally and on Android CI. Needs investigation.
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
      testIgnore: ["**/*"],
    },
  ],
})
