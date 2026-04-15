import "dotenv/config"
import { defineConfig } from "pilot"

export default defineConfig({
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/PilotTestApp.app",
  package: "dev.pilot.testapp",
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 4,
  trace: "retain-on-failure",
  simulator: process.env.PILOT_IOS_SIMULATOR || "iPhone 17",
  daemonBin: "../packages/pilot-core/target/release/pilot-core",
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
      use: { appState: "./pilot-results/auth-state-authentication.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
