import test from "node:test"
import assert from "node:assert/strict"
import {
  checkAndroidAfter,
  checkAndroidBefore,
  checkIosAfter,
  checkIosBefore,
  parseAdbDevices,
  parseEmulatorProcesses,
  parseManifest,
  parseSimctlDevices,
} from "../provisioning-checks.mjs"

// ─── Fixtures ───

const AVD = "Tapsmith_Phone_API_36"
const QEMU = "/usr/local/lib/android/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless"

/** The argv Tapsmith's launchEmulator spawns (headless profile), as `ps -o args=` prints it. */
function tapsmithArgs(port, avd = AVD) {
  return `${QEMU} -avd ${avd} -port ${port} -read-only -no-snapshot-load -no-snapshot-save -no-boot-anim -no-audio -gpu swiftshader_indirect -no-window`
}

/** An emulator a workflow step booted itself: writable, no -read-only. */
function workflowArgs(port, avd = `${AVD}_Primary`) {
  return `${QEMU} -avd ${avd} -port ${port} -no-window -no-audio -no-snapshot-save -gpu swiftshader_indirect`
}

function ps(...lines) {
  return lines.map(([pid, args]) => `${String(pid).padStart(6)} ${args}`).join("\n") + "\n"
}

function adb(...serials) {
  return ["List of devices attached", ...serials.map(([s, state = "device"]) => `${s}\t${state}`), ""].join("\n")
}

function entry(serial, pid, avd = AVD) {
  const port = Number(serial.replace("emulator-", ""))
  return { serial, pid, avd, port, launchedAt: "2026-10-02T00:00:00.000Z" }
}

/** Host state after a clean two-emulator launch, ready for one field to be broken. */
function launchedTwo() {
  return {
    processes: parseEmulatorProcesses(ps([4100, tapsmithArgs(5554)], [4200, tapsmithArgs(5556)])),
    adbDevices: parseAdbDevices(adb(["emulator-5554"], ["emulator-5556"])),
    manifest: { entries: [entry("emulator-5554", 4100), entry("emulator-5556", 4200)] },
    avd: AVD,
    expectLaunched: 2,
  }
}

function sim(name, state, udid, runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-0") {
  return { name, state, udid, isAvailable: true, deviceTypeIdentifier: "x", runtime }
}

function simctlJson(...sims) {
  const devices = {}
  for (const s of sims) {
    devices[s.runtime] ??= []
    const { runtime: _runtime, ...rest } = s
    devices[s.runtime].push(rest)
  }
  return JSON.stringify({ devices })
}

// ─── Parsers ───

test("parseEmulatorProcesses keeps emulator processes and their argv", () => {
  const procs = parseEmulatorProcesses(ps(
    [1, "/sbin/init"],
    [4100, tapsmithArgs(5554)],
    [4300, "/usr/bin/node /home/runner/work/tapsmith/e2e/node_modules/.bin/tapsmith test -avd-like-arg"],
    [4400, "/usr/local/lib/android/sdk/emulator/emulator -list-avds"],
    [4500, "/usr/local/lib/android/sdk/emulator/emulator -avd Other -port 5560"],
  ))
  assert.deepEqual(procs.map((p) => p.pid), [4100, 4500])
  assert.equal(procs[0].port, 5554)
  assert.equal(procs[0].avd, AVD)
  assert.equal(procs[0].readOnly, true)
  assert.equal(procs[1].readOnly, false)
})

test("parseEmulatorProcesses recognises the macOS qemu binary name", () => {
  const procs = parseEmulatorProcesses(ps(
    [77, "/Users/x/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd A -port 5554 -read-only"],
  ))
  assert.equal(procs.length, 1)
})

test("parseAdbDevices reads serials and states, ignoring the header and daemon chatter", () => {
  const devices = parseAdbDevices([
    "* daemon not running; starting now at tcp:5037",
    "* daemon started successfully",
    "List of devices attached",
    "emulator-5554\tdevice",
    "emulator-5556\toffline",
    "",
  ].join("\n"))
  assert.deepEqual(devices, [
    { serial: "emulator-5554", state: "device" },
    { serial: "emulator-5556", state: "offline" },
  ])
})

test("parseManifest treats a missing file as empty and a corrupt one as an error", () => {
  assert.deepEqual(parseManifest(undefined), { entries: [] })
  assert.deepEqual(parseManifest("[]"), { entries: [] })
  assert.equal(parseManifest("[{").error !== undefined, true)
  assert.equal(parseManifest('{"not":"an array"}').error !== undefined, true)
})

test("parseSimctlDevices flattens runtimes and drops unavailable devices", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        { name: "iPhone 17", state: "Shutdown", udid: "A", isAvailable: true },
        { name: "iPhone 16", state: "Shutdown", udid: "B", isAvailable: false },
      ],
    },
  })
  assert.deepEqual(parseSimctlDevices(json), [
    { name: "iPhone 17", state: "Shutdown", udid: "A", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0" },
  ])
})

// ─── Android: before the run ───

test("android before: a bare host passes", () => {
  assert.deepEqual(checkAndroidBefore({ processes: [], adbDevices: [], manifest: { entries: [] } }), [])
})

test("android before: a connected device fails — Tapsmith would adopt it instead of launching", () => {
  const failures = checkAndroidBefore({
    processes: [],
    adbDevices: parseAdbDevices(adb(["emulator-5554"])),
    manifest: { entries: [] },
  })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /emulator-5554/)
})

test("android before: a running emulator process fails even before adb sees it", () => {
  const failures = checkAndroidBefore({
    processes: parseEmulatorProcesses(ps([900, workflowArgs(5554)])),
    adbDevices: [],
    manifest: { entries: [] },
  })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /900/)
})

test("android before: leftover manifest entries fail, and so does a corrupt manifest", () => {
  assert.equal(checkAndroidBefore({ processes: [], adbDevices: [], manifest: { entries: [entry("emulator-5554", 1)] } }).length, 1)
  assert.equal(checkAndroidBefore({ processes: [], adbDevices: [], manifest: { entries: [], error: "bad json" } }).length, 1)
})

// ─── Android: after the run ───

test("android after: two Tapsmith-launched, tracked, online emulators pass", () => {
  assert.deepEqual(checkAndroidAfter(launchedTwo()), [])
})

test("android after: nothing launched fails (the run adopted or used no emulator)", () => {
  const state = { ...launchedTwo(), processes: [], adbDevices: [], manifest: { entries: [] } }
  const failures = checkAndroidAfter(state)
  assert.equal(failures.length, 1)
  assert.match(failures[0], /expected 2.*0/i)
})

test("android after: an emulator process missing from the manifest is an orphan", () => {
  const state = launchedTwo()
  state.processes = parseEmulatorProcesses(ps(
    [4100, tapsmithArgs(5554)], [4200, tapsmithArgs(5556)], [4300, tapsmithArgs(5558)],
  ))
  state.adbDevices = parseAdbDevices(adb(["emulator-5554"], ["emulator-5556"], ["emulator-5558"]))
  const failures = checkAndroidAfter(state)
  assert.ok(failures.some((f) => /4300/.test(f) && /not in the manifest/.test(f)), failures.join("\n"))
})

test("android after: a manifest entry whose process is gone fails", () => {
  const state = launchedTwo()
  state.processes = parseEmulatorProcesses(ps([4100, tapsmithArgs(5554)]))
  state.adbDevices = parseAdbDevices(adb(["emulator-5554"]))
  const failures = checkAndroidAfter(state)
  assert.ok(failures.some((f) => /emulator-5556/.test(f) && /4200/.test(f)), failures.join("\n"))
})

test("android after: a recorded pid that is not Tapsmith's launch (no -read-only, other AVD, other port) fails", () => {
  for (const args of [workflowArgs(5556, AVD), tapsmithArgs(5556, "Other_AVD"), tapsmithArgs(5560)]) {
    const state = launchedTwo()
    state.processes = parseEmulatorProcesses(ps([4100, tapsmithArgs(5554)], [4200, args]))
    const failures = checkAndroidAfter(state)
    assert.ok(failures.some((f) => /emulator-5556/.test(f)), `${args}\n${failures.join("\n")}`)
  }
})

test("android after: an emulator the manifest still marks as booting fails (the run never finished its launch)", () => {
  const state = launchedTwo()
  state.manifest.entries[1] = { ...state.manifest.entries[1], booting: true }
  const failures = checkAndroidAfter(state)
  assert.ok(failures.some((f) => /emulator-5556/.test(f) && /booting/.test(f)), failures.join("\n"))
})

test("android after: a launched emulator that is not online in adb fails", () => {
  const state = launchedTwo()
  state.adbDevices = parseAdbDevices(adb(["emulator-5554"], ["emulator-5556", "offline"]))
  const failures = checkAndroidAfter(state)
  assert.ok(failures.some((f) => /emulator-5556/.test(f) && /offline/.test(f)), failures.join("\n"))
})

test("android after: an adb emulator nobody accounts for fails", () => {
  const state = launchedTwo()
  state.adbDevices = parseAdbDevices(adb(["emulator-5554"], ["emulator-5556"], ["emulator-5562"]))
  const failures = checkAndroidAfter(state)
  assert.ok(failures.some((f) => /emulator-5562/.test(f)), failures.join("\n"))
})

test("android after: duplicate manifest entries fail", () => {
  const state = launchedTwo()
  state.manifest = { entries: [...state.manifest.entries, entry("emulator-5556", 4200)] }
  state.expectLaunched = 3
  const failures = checkAndroidAfter(state)
  assert.ok(failures.some((f) => /more than once/.test(f)), failures.join("\n"))
})

test("android after: a corrupt manifest fails", () => {
  const state = { ...launchedTwo(), manifest: { entries: [], error: "Unexpected end of JSON input" } }
  assert.ok(checkAndroidAfter(state).some((f) => /JSON/.test(f)))
})

test("android after: an external (workflow-booted) emulator is allowed but never counts as launched", () => {
  const base = {
    processes: parseEmulatorProcesses(ps([900, workflowArgs(5554)], [4200, tapsmithArgs(5556)])),
    adbDevices: parseAdbDevices(adb(["emulator-5554"], ["emulator-5556"])),
    manifest: { entries: [entry("emulator-5556", 4200)] },
    avd: AVD,
    expectLaunched: 1,
  }
  assert.deepEqual(checkAndroidAfter({ ...base, external: ["emulator-5554"] }), [])
  // Without the allowance the workflow's emulator is an untracked process.
  assert.ok(checkAndroidAfter(base).some((f) => /900/.test(f)))
  // And if Tapsmith had "launched" the external serial, that is adoption, not a launch.
  const adopted = { ...base, manifest: { entries: [entry("emulator-5554", 900)] }, external: ["emulator-5554"] }
  assert.ok(checkAndroidAfter(adopted).length > 0)
})

test("android after: reuse run — same pids pass, a relaunch fails", () => {
  const first = launchedTwo()
  assert.deepEqual(checkAndroidAfter({ ...first, previous: first.manifest.entries }), [])
  const relaunched = launchedTwo()
  relaunched.processes = parseEmulatorProcesses(ps([4100, tapsmithArgs(5554)], [5200, tapsmithArgs(5556)]))
  relaunched.manifest = { entries: [entry("emulator-5554", 4100), entry("emulator-5556", 5200)] }
  const failures = checkAndroidAfter({ ...relaunched, previous: first.manifest.entries })
  assert.ok(failures.some((f) => /emulator-5556/.test(f) && /reuse/i.test(f)), failures.join("\n"))
})

// ─── iOS ───

const TARGET = "iPhone 17"

test("ios before: every simulator shut down passes", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Shutdown", "A"), sim("iPad Air", "Shutdown", "B")))
  assert.deepEqual(checkIosBefore({ devices, simulator: TARGET }), [])
})

test("ios before: a booted simulator fails — Tapsmith would reuse it instead of booting", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Booted", "A")))
  const failures = checkIosBefore({ devices, simulator: TARGET })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /A/)
})

test("ios before: the target simulator must exist", () => {
  const devices = parseSimctlDevices(simctlJson(sim("iPad Air", "Shutdown", "B")))
  assert.match(checkIosBefore({ devices, simulator: TARGET })[0], /iPhone 17/)
})

test("ios before: a leftover Tapsmith worker clone fails", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Shutdown", "A"), sim(`${TARGET} (Tapsmith Worker 1)`, "Shutdown", "C")))
  assert.ok(checkIosBefore({ devices, simulator: TARGET }).some((f) => /Tapsmith Worker 1/.test(f)))
})

test("ios after: the target booted and nothing else passes", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Booted", "A"), sim("iPad Air", "Shutdown", "B")))
  assert.deepEqual(checkIosAfter({ devices, simulator: TARGET, manifest: { entries: [] } }), [])
})

test("ios after: the target still shut down fails (Tapsmith never booted it)", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Shutdown", "A")))
  assert.ok(checkIosAfter({ devices, simulator: TARGET, manifest: { entries: [] } }).some((f) => /iPhone 17/.test(f)))
})

test("ios after: a second booted simulator fails", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Booted", "A"), sim("iPad Air", "Booted", "B")))
  assert.ok(checkIosAfter({ devices, simulator: TARGET, manifest: { entries: [] } }).some((f) => /iPad Air/.test(f)))
})

test("ios after: a worker clone the manifest does not list is an orphan; a listed one is not", () => {
  const clone = sim(`${TARGET} (Tapsmith Worker 1)`, "Shutdown", "C")
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Booted", "A"), clone))
  assert.ok(checkIosAfter({ devices, simulator: TARGET, manifest: { entries: [] } }).some((f) => /Tapsmith Worker 1/.test(f)))
  const listed = { entries: [{ udid: "C", name: clone.name, sourceName: TARGET, createdAt: "x" }] }
  assert.deepEqual(checkIosAfter({ devices, simulator: TARGET, manifest: listed }), [])
})

test("ios after: a manifest entry whose simulator no longer exists fails, as does a corrupt manifest", () => {
  const devices = parseSimctlDevices(simctlJson(sim(TARGET, "Booted", "A")))
  const stale = { entries: [{ udid: "GONE", name: "x", sourceName: TARGET, createdAt: "x" }] }
  assert.ok(checkIosAfter({ devices, simulator: TARGET, manifest: stale }).some((f) => /GONE/.test(f)))
  assert.ok(checkIosAfter({ devices, simulator: TARGET, manifest: { entries: [], error: "bad" } }).length > 0)
})
