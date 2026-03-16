import { defineConfig } from "../packages/pilot/dist/config.js"

export default defineConfig({
  timeout: 30_000,
  retries: 0,
  screenshot: "only-on-failure",
  device: "emulator-5554",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk: "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
})
