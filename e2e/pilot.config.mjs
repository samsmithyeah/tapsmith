import { defineConfig } from "pilot";

export default defineConfig({
  apk: "../test-app/android/app/build/outputs/apk/release/app-release.apk",
  activity: "dev.pilot.testapp.MainActivity",
  package: "dev.pilot.testapp",
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 1,
  trace: "retain-on-failure",
  launchEmulators: true,
  avd: "Pilot_Generic_Phone_API_35",
  daemonBin: "../packages/pilot-core/target/release/pilot-core",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  projects: [
    {
      name: "setup",
      testMatch: ["**/auth.setup.ts"],
    },
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/app-state.test.ts"],
      dependencies: ["setup"],
    },
    {
      name: "authenticated",
      dependencies: ["setup"],
      use: { appState: "./pilot-results/auth-state.tar.gz" },
      testMatch: ["**/app-state.test.ts"],
    },
  ],
});
