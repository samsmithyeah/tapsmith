#!/usr/bin/env node
// Snapshot the host's devices around a Tapsmith run that provisions its own
// emulator/simulator, and fail when the run adopted a device instead of
// launching one, or left one behind that Tapsmith does not track (PILOT-483).
//
//   node verify-provisioning.mjs android-before
//   node verify-provisioning.mjs android-after --avd <name> --expect-launched <n>
//        [--external <serial,...>] [--save <file>] [--reuse-of <file>]
//   node verify-provisioning.mjs ios-before --simulator <name>
//   node verify-provisioning.mjs ios-after --simulator <name>
//
// `--external` names emulators the workflow booted itself (allowed, never
// counted as launched). `--save` writes the manifest after a run, and
// `--reuse-of` checks a later run reused exactly those emulators.
//
// The judging lives in utils/provisioning-checks.mjs (unit-tested); this file
// only gathers the host state. Run by .github/workflows/e2e-provisioning.yml
// and the Multi-device job of e2e-android.yml.

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"
import {
  checkAndroidAfter,
  checkAndroidBefore,
  checkIosAfter,
  checkIosBefore,
  parseAdbDevices,
  parseEmulatorProcesses,
  parseManifest,
  parseSimctlDevices,
} from "./utils/provisioning-checks.mjs"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    avd: { type: "string" },
    "expect-launched": { type: "string" },
    external: { type: "string" },
    save: { type: "string" },
    "reuse-of": { type: "string" },
    simulator: { type: "string" },
  },
})

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000 })

function readOptional(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") return undefined
    throw err
  }
}

function required(name) {
  const value = values[name]
  if (!value) fail([`--${name} is required for ${positionals[0]}`])
  return value
}

function fail(failures) {
  for (const f of failures) console.log(`::error::${f}`)
  process.exit(1)
}

// Same paths the SDK uses (emulator.ts manifestPath, ios-simulator.ts simulatorManifestPath).
const emulatorManifestPath = () => path.join(os.tmpdir(), "tapsmith-emulators.json")
function simulatorManifestPath() {
  let username
  try {
    username = os.userInfo().username
  } catch {
    username = String(process.getuid?.() ?? "shared")
  }
  return path.join(os.tmpdir(), `tapsmith-simulators-${username.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`)
}

function androidState() {
  const state = {
    processes: parseEmulatorProcesses(run("ps", ["-A", "-ww", "-o", "pid=,args="])),
    adbDevices: parseAdbDevices(run("adb", ["devices"])),
    manifest: parseManifest(readOptional(emulatorManifestPath())),
  }
  console.log(`Emulator processes: ${state.processes.map((p) => `${p.pid} ${p.avd}:${p.port}${p.readOnly ? " (read-only)" : ""}`).join(", ") || "none"}`)
  console.log(`adb devices: ${state.adbDevices.map((d) => `${d.serial} ${d.state}`).join(", ") || "none"}`)
  console.log(`Manifest (${emulatorManifestPath()}): ${state.manifest.entries.map((e) => `${e.serial} pid ${e.pid}`).join(", ") || "empty"}`)
  return state
}

function iosState() {
  const devices = parseSimctlDevices(run("xcrun", ["simctl", "list", "devices", "-j"]))
  const manifest = parseManifest(readOptional(simulatorManifestPath()))
  const booted = devices.filter((d) => d.state !== "Shutdown")
  console.log(`Simulators not shut down: ${booted.map((d) => `${d.name} ${d.udid} ${d.state}`).join(", ") || "none"}`)
  console.log(`Simulator manifest (${simulatorManifestPath()}): ${manifest.entries.map((e) => `${e.name} ${e.udid}`).join(", ") || "empty"}`)
  return { devices, manifest }
}

let failures
switch (positionals[0]) {
  case "android-before":
    failures = checkAndroidBefore(androidState())
    break
  case "android-after": {
    const state = androidState()
    const reuseOf = values["reuse-of"]
    failures = checkAndroidAfter({
      ...state,
      avd: required("avd"),
      expectLaunched: Number(required("expect-launched")),
      external: values.external ? values.external.split(",").map((s) => s.trim()).filter(Boolean) : [],
      previous: reuseOf ? JSON.parse(fs.readFileSync(reuseOf, "utf8")) : undefined,
    })
    if (values.save) fs.writeFileSync(values.save, JSON.stringify(state.manifest.entries, null, 2))
    break
  }
  case "ios-before":
    failures = checkIosBefore({ ...iosState(), simulator: required("simulator") })
    break
  case "ios-after":
    failures = checkIosAfter({ ...iosState(), simulator: required("simulator") })
    break
  default:
    fail([`Unknown or missing check "${positionals[0] ?? ""}": use android-before, android-after, ios-before or ios-after.`])
}

if (failures.length > 0) fail(failures)
console.log(`${positionals[0]}: OK`)
