import { defineConfig } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs"

export default defineConfig({
  platform: "ios",
  app: "./fixtures/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 30_000,
  typingDelay: 10,
  retries: 1,
  reporter: [["list"], ["github"], ["html", { open: "never" }]],
  screenshot: "only-on-failure",
  trace: {
    mode: "retain-on-failure",
    daemonLogs: true,
    networkHosts: ["jsonplaceholder.typicode.com", "127.0.0.1"],
  },
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
