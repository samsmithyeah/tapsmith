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
  projects: [
    {
      name: "authentication",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/app-state.test.ts", "**/auth-gate.test.ts", "**/*.android.test.ts"],
    },
    {
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./tapsmith-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
