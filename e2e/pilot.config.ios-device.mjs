/**
 * E2E config targeting a physical iOS device.
 *
 * Device UDID and xctestrun path are both auto-resolved by Pilot:
 *   - `device` is omitted → Pilot picks the single paired USB iOS device.
 *     Set PILOT_IOS_DEVICE when multiple are connected.
 *   - `iosXctestrun` is omitted → Pilot picks the newest iphoneos xctestrun
 *     under `ios-agent/.build-device/`. Run `pilot build-ios-agent` once
 *     per Pilot upgrade to populate it.
 *
 * Requires:
 *   1. `pilot build-ios-agent` run once to produce the signed xctestrun
 *      (see docs/ios-physical-devices.md).
 *   2. A device-signed build of the test-app accessible as
 *      test-app/ios/build/Build/Products/Release-iphoneos/PilotTestApp.app
 *      (build via `cd test-app && npx expo run:ios --configuration Release --device <udid>`).
 *
 * Mirrors the simulator config's three-project auth-setup flow.
 */
import "dotenv/config"
import { defineConfig } from "pilot"

export default defineConfig({
  platform: "ios",
  app: "../test-app/ios/build/Build/Products/Release-iphoneos/PilotTestApp.app",
  package: "dev.pilot.testapp",
  timeout: 15_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 1,
  trace: {
    mode: "retain-on-failure",
    // Physical iOS captures traffic system-wide (no per-app scoping without
    // MDM). Allowlist the hosts the test app actually calls so traces don't
    // fill up with iOS background services and unrelated apps.
    networkHosts: ["jsonplaceholder.typicode.com"],
  },
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
