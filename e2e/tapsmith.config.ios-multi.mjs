import "dotenv/config"
import { defineConfig } from "tapsmith"

// ─── Multi-device (device group) config, iOS simulator ───
//
// Runs the `tests/multi-device/` suite: every test drives two simulators at
// once (PILOT-310). Tapsmith clones a second simulator of the configured type
// when only one is booted.
//
//   tapsmith test -c tapsmith.config.ios-multi.mjs
//   tapsmith test -c tapsmith.config.ios-multi.mjs --ui

export default defineConfig({
  platform: "ios",
  app: "../test-app/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
  package: "dev.tapsmith.testapp",
  simulator: process.env.TAPSMITH_IOS_SIMULATOR || "iPhone 17",
  timeout: 15_000,
  // Same as the -ci sibling: without a per-character delay the simulator drops
  // keystrokes under load (`type("bob")` has landed as "bb").
  typingDelay: 10,
  retries: 0,
  screenshot: "only-on-failure",
  trace: { mode: "retain-on-failure", daemonLogs: true },
  projects: [
    {
      name: "pair",
      testMatch: ["**/multi-device/**/*.test.ts"],
      use: { devices: [{ name: "alice" }, { name: "bob" }] },
    },
  ],
})
