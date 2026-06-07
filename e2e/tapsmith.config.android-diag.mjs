import { defineConfig } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "./reset-app-deep-link.mjs"

// Trace-performance diagnostic config (temporary).
//
// The trace setting is chosen by TAPSMITH_DIAG_TRACE so a single CI job can
// run the same workload under several configurations back-to-back on one
// emulator, isolating where tracing overhead comes from:
//   off            — recording disabled (baseline)
//   full           — record everything (screenshots + hierarchy + network + logs)
//   no-screenshots — record everything except screenshots
//   no-snapshots   — record everything except the view-hierarchy dump
//   no-network     — record everything except network capture
//   no-devicelogs  — record everything except device log streaming
const variant = process.env.TAPSMITH_DIAG_TRACE || "full"
const traceByVariant = {
  off: "off",
  full: { mode: "on" },
  "no-screenshots": { mode: "on", screenshots: false },
  "no-snapshots": { mode: "on", snapshots: false },
  "no-network": { mode: "on", network: false },
  "no-devicelogs": { mode: "on", deviceLogs: false },
}
const trace = traceByVariant[variant] ?? { mode: "on" }

export default defineConfig({
  apk: "./fixtures/app-release.apk",
  activity: "dev.tapsmith.testapp.MainActivity",
  package: "dev.tapsmith.testapp",
  resetAppDeepLink: RESET_APP_DEEP_LINK,
  timeout: 15_000,
  // No retries — a retry would record a second trace and skew timing.
  retries: 0,
  reporter: [["list"]],
  workers: 1,
  trace,
  avd: "Tapsmith_Generic_Phone_API_35",
  agentApk: "../agent/app/build/outputs/apk/debug/app-debug.apk",
  agentTestApk:
    "../agent/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  // Self-contained subset (mirrors the android-ci "default" project) so the
  // run needs no auth setup and is deterministic across variants.
  projects: [
    {
      name: "default",
      testMatch: ["**/*.test.ts"],
      testIgnore: ["**/app-state.test.ts", "**/auth-gate.test.ts"],
    },
  ],
})
