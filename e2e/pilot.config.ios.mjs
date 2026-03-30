import { defineConfig } from "pilot"

export default defineConfig({
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/PilotTestApp.app",
  package: "dev.pilot.testapp",
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 1,
  trace: "retain-on-failure",
  simulator: "iPhone 17",
  daemonBin: "../packages/pilot-core/target/release/pilot-core",
  // xctestrun path lives in Xcode DerivedData — find yours with:
  //   ls ~/Library/Developer/Xcode/DerivedData/PilotAgent-*/Build/Products/*.xctestrun
  iosXctestrun:
    process.env.PILOT_IOS_XCTESTRUN ||
    `${process.env.HOME}/Library/Developer/Xcode/DerivedData/PilotAgent-fdcquzhwxdmuhlhilgaqynruawga/Build/Products/PilotAgentUITests_PilotAgentUITests_iphonesimulator26.4-arm64.xctestrun`,
  projects: [
    {
      name: "authentication",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
    {
      name: "authenticated",
      dependencies: ["authentication"],
      use: { appState: "./pilot-results/auth-state.tar.gz" },
      testMatch: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
