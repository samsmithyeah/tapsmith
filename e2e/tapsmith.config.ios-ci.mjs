import { defineConfig } from "tapsmith"

export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  timeout: 30_000,
  typingDelay: 10,
  retries: 1,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: { mode: "retain-on-failure", network: false },
  video: "retain-on-failure",
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
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
