/**
 * E2E config targeting a physical iOS device.
 *
 * Requires:
 *   1. `pilot build-ios-agent` run once to produce the signed xctestrun under
 *      ios-agent/.build-device/ (see docs/ios-physical-devices.md).
 *   2. A device-signed build of the test-app accessible as
 *      test-app/build/Build/Products/Release-iphoneos/PilotTestApp.app
 *      (build via `cd test-app && npx expo run:ios --configuration Release --device <udid>`).
 *   3. PILOT_IOS_DEVICE env var set to the device UDID (run `pilot setup-ios-device`
 *      to find it).
 *
 * Several test files are excluded because they use iOS APIs that aren't yet
 * supported on physical devices (openDeepLink, clearAppData,
 * save/restoreAppState). These will be re-enabled as the daemon grows
 * agent-routed equivalents.
 */
import "dotenv/config"
import { statSync } from "node:fs"
import { join, resolve } from "node:path"
import { defineConfig } from "pilot"
import { globSync } from "tinyglobby"

const deviceUdid = process.env.PILOT_IOS_DEVICE
if (!deviceUdid) {
  throw new Error(
    "PILOT_IOS_DEVICE is not set. Run `pilot setup-ios-device` to find your device UDID, " +
      "then export PILOT_IOS_DEVICE=<udid>.",
  )
}

function findDeviceXctestrun() {
  const pattern = resolve(
    join(import.meta.dirname, "..", "ios-agent", ".build-device", "Build", "Products", "*iphoneos*.xctestrun"),
  )
  const matches = globSync(pattern, { absolute: true }).filter(
    (p) => !p.endsWith(".patched.xctestrun"),
  )
  if (matches.length === 0) {
    throw new Error(
      `No device xctestrun found at ${pattern}.\n` +
        `Run \`pilot build-ios-agent\` first. See docs/ios-physical-devices.md.`,
    )
  }
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

export default defineConfig({
  platform: "ios",
  app: "../test-app/ios/build/Build/Products/Release-iphoneos/PilotTestApp.app",
  package: "dev.pilot.testapp",
  timeout: 15_000,
  retries: 0,
  screenshot: "only-on-failure",
  workers: 1,
  trace: "retain-on-failure",
  device: deviceUdid,
  daemonBin: "../packages/pilot-core/target/release/pilot-core",
  iosXctestrun: process.env.PILOT_IOS_XCTESTRUN || findDeviceXctestrun(),
  projects: [
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: [
        // Unsupported on physical iOS (see docs/ios-physical-devices.md):
        "**/app-state.test.ts",
        "**/auth-gate.test.ts",
        "**/device-management.test.ts",
        "**/*.android.test.ts",
      ],
    },
  ],
})
