import { defineConfig } from "pilot"

export default defineConfig({
  apk: "../test-app/android/app/build/outputs/apk/release/app-release.apk",
  activity: "dev.pilot.testapp.MainActivity",
  package: "dev.pilot.testapp",
  timeout: 10_000,
  retries: 0,
  screenshot: "only-on-failure",
  device: "emulator-5554",
  daemonBin: "../packages/pilot-core/target/release/pilot-core",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk: "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
})
