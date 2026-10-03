/**
 * Host-state checks for the provisioning lanes (PILOT-483).
 *
 * The provisioning jobs in .github/workflows/e2e-provisioning.yml (and the
 * Android Multi-device job) let Tapsmith launch or boot the device itself.
 * Pass/fail alone cannot tell a launched device from an adopted one, so the
 * workflow snapshots the host before and after the run and these functions
 * judge it:
 *
 * - **before**: nothing is booted, nothing is recorded — so whatever is
 *   running afterwards can only have been started by Tapsmith;
 * - **after**: Tapsmith started exactly what it should have, every emulator
 *   process / worker simulator on the host is one Tapsmith tracks for reuse
 *   (its PID manifest / simulator manifest), and nothing it tracks is dead.
 *
 * Tapsmith deliberately leaves the devices it launches running for the next
 * run (`preserveEmulatorsForReuse`), so "clean teardown" means *tracked*, not
 * *gone*: an emulator the manifest does not know about is the orphan a later
 * run can neither reuse nor reclaim.
 *
 * Pure functions over command output, unit-tested in
 * `__tests__/provisioning-checks.test.mjs`; `verify-provisioning.mjs` gathers
 * the output and exits non-zero on any failure. Each check returns a list of
 * human-readable failures (empty = pass).
 */

// ─── Parsers ───

/** Binaries that are an Android emulator instance (the launcher exec's qemu in place). */
const EMULATOR_BINARY = /(?:^|\/)(?:qemu-system-[\w-]+|emulator(?:64-[\w-]+)?)$/

/**
 * Emulator instances from `ps -A -ww -o pid=,args=` output: processes whose
 * binary is the emulator/qemu and that were started with `-avd` (so
 * `emulator -list-avds` and other tool invocations are not instances).
 */
export function parseEmulatorProcesses(psOutput) {
  const processes = []
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!match) continue
    const argv = match[2].split(/\s+/)
    if (!EMULATOR_BINARY.test(argv[0])) continue
    const valueOf = (flag) => {
      const i = argv.indexOf(flag)
      return i >= 0 ? argv[i + 1] : undefined
    }
    const avd = valueOf("-avd")
    if (avd === undefined) continue
    const port = Number(valueOf("-port"))
    processes.push({
      pid: Number(match[1]),
      avd,
      port: Number.isInteger(port) && port > 0 ? port : undefined,
      readOnly: argv.includes("-read-only"),
      args: match[2],
    })
  }
  return processes
}

/** `adb devices` → `{ serial, state }[]`. */
export function parseAdbDevices(output) {
  const devices = []
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\S+)\t(\S+)$/)
    if (match) devices.push({ serial: match[1], state: match[2] })
  }
  return devices
}

/**
 * A Tapsmith manifest file's text (`undefined` when the file does not
 * exist) → `{ entries }`, or `{ entries: [], error }` when it is unreadable.
 */
export function parseManifest(text) {
  if (text === undefined) return { entries: [] }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return { entries: [], error: "manifest is not a JSON array" }
    return { entries: parsed }
  } catch (err) {
    return { entries: [], error: `manifest is not valid JSON (${err.message})` }
  }
}

/** `xcrun simctl list devices -j` → available simulators, runtime attached. */
export function parseSimctlDevices(json) {
  const { devices } = JSON.parse(json)
  const out = []
  for (const [runtime, list] of Object.entries(devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false) continue
      out.push({ name: d.name, state: d.state, udid: d.udid, runtime })
    }
  }
  return out
}

// ─── Android ───

const serialForPort = (port) => `emulator-${port}`
const isEmulatorSerial = (serial) => /^emulator-\d+$/.test(serial)

function describeProcess(p) {
  return `pid ${p.pid} (AVD ${p.avd}${p.port ? `, port ${p.port}` : ""})`
}

/**
 * Before the run: no device for Tapsmith to adopt, no emulator process, and
 * no manifest entries a run could reclaim instead of launching.
 */
export function checkAndroidBefore({ processes, adbDevices, manifest }) {
  const failures = []
  for (const d of adbDevices) {
    failures.push(`adb already lists ${d.serial} (${d.state}): Tapsmith would use it instead of launching an emulator.`)
  }
  for (const p of processes) {
    failures.push(`An emulator is already running: ${describeProcess(p)}.`)
  }
  if (manifest.error) failures.push(`The emulator manifest is unreadable: ${manifest.error}.`)
  for (const e of manifest.entries) {
    failures.push(`The emulator manifest already records ${e.serial} (pid ${e.pid}): a previous run's state leaked in.`)
  }
  return failures
}

/**
 * After the run.
 *
 * @param {object} state
 * @param {ReturnType<typeof parseEmulatorProcesses>} state.processes
 * @param {ReturnType<typeof parseAdbDevices>} state.adbDevices
 * @param {ReturnType<typeof parseManifest>} state.manifest
 * @param {string} state.avd  the config's `avd`, which Tapsmith launches
 * @param {number} state.expectLaunched  how many emulators Tapsmith must have launched
 * @param {string[]} [state.external]  serials the workflow booted itself (allowed, never "launched")
 * @param {object[]} [state.previous]  manifest entries from an earlier run that must have been reused
 */
export function checkAndroidAfter({ processes, adbDevices, manifest, avd, expectLaunched, external = [], previous }) {
  const failures = []
  if (manifest.error) {
    failures.push(`The emulator manifest is unreadable: ${manifest.error}.`)
  }
  const entries = manifest.entries
  if (entries.length !== expectLaunched) {
    failures.push(
      `Expected ${expectLaunched} Tapsmith-launched emulator(s) in the manifest, found ${entries.length}`
      + (entries.length ? ` (${entries.map((e) => e.serial).join(", ")})` : "")
      + ". Tapsmith did not provision the devices this run used.",
    )
  }

  const bySerial = new Map()
  const byPid = new Map()
  for (const e of entries) {
    if (bySerial.has(e.serial) || byPid.has(e.pid)) {
      failures.push(`The emulator manifest records ${e.serial} (pid ${e.pid}) more than once.`)
    }
    bySerial.set(e.serial, e)
    byPid.set(e.pid, e)
  }

  const processByPid = new Map(processes.map((p) => [p.pid, p]))
  const adbBySerial = new Map(adbDevices.map((d) => [d.serial, d]))

  // Every recorded emulator: alive, Tapsmith's own launch of `avd`, online.
  for (const e of entries) {
    if (external.includes(e.serial)) {
      failures.push(`${e.serial} was booted by the workflow, yet the manifest records it as launched by Tapsmith.`)
      continue
    }
    const proc = processByPid.get(e.pid)
    if (!proc) {
      failures.push(`The manifest records ${e.serial} as pid ${e.pid}, but no emulator process has that pid.`)
    } else if (proc.avd !== avd || proc.port !== e.port || serialForPort(proc.port) !== e.serial || !proc.readOnly) {
      failures.push(
        `The manifest records ${e.serial} as pid ${e.pid}, but that process is not Tapsmith's launch of AVD ${avd} `
        + `on port ${e.port} with -read-only: ${proc.args}`,
      )
    }
    const device = adbBySerial.get(e.serial)
    if (!device) {
      failures.push(`Tapsmith launched ${e.serial}, but adb does not list it.`)
    } else if (device.state !== "device") {
      failures.push(`Tapsmith launched ${e.serial}, but adb reports it ${device.state}.`)
    }
  }

  // Every emulator process: tracked by the manifest, or one the workflow started.
  for (const p of processes) {
    if (byPid.has(p.pid)) continue
    if (p.port !== undefined && external.includes(serialForPort(p.port))) continue
    failures.push(`Untracked emulator left running — ${describeProcess(p)} is not in the manifest: ${p.args}`)
  }

  // Every emulator adb knows: accounted for one way or the other.
  for (const d of adbDevices) {
    if (!isEmulatorSerial(d.serial)) continue
    if (bySerial.has(d.serial) || external.includes(d.serial)) continue
    failures.push(`adb lists ${d.serial} (${d.state}), which neither Tapsmith's manifest nor the workflow accounts for.`)
  }

  // A rerun must have reused what the first run launched, not relaunched it.
  if (previous) {
    for (const before of previous) {
      const now = bySerial.get(before.serial)
      if (!now) {
        failures.push(`Expected the rerun to reuse ${before.serial} (pid ${before.pid}), but it is no longer in the manifest.`)
      } else if (now.pid !== before.pid) {
        failures.push(`Expected the rerun to reuse ${before.serial} (pid ${before.pid}), but it was relaunched as pid ${now.pid}.`)
      }
    }
  }
  return failures
}

// ─── iOS ───

/** The name `provisionSimulators` gives the clones and simulators it creates. */
const WORKER_CLONE = /\(Tapsmith Worker \d+\)$/

/** Before the run: the target exists, nothing is booted, no worker clones linger. */
export function checkIosBefore({ devices, simulator }) {
  const failures = []
  if (!devices.some((d) => d.name === simulator)) {
    failures.push(`No available simulator is named "${simulator}".`)
  }
  for (const d of devices) {
    if (d.state !== "Shutdown") {
      failures.push(`${d.name} (${d.udid}) is already ${d.state}: Tapsmith would reuse it instead of booting one.`)
    }
    if (WORKER_CLONE.test(d.name)) {
      failures.push(`A Tapsmith worker simulator already exists: ${d.name} (${d.udid}).`)
    }
  }
  return failures
}

/**
 * After the run: the target was booted (by Tapsmith — `checkIosBefore` saw
 * it shut down), nothing else was, and every worker clone on the host is one
 * the simulator manifest tracks for reuse, and vice versa.
 */
export function checkIosAfter({ devices, simulator, manifest }) {
  const failures = []
  if (manifest.error) failures.push(`The simulator manifest is unreadable: ${manifest.error}.`)
  const tracked = new Set(manifest.entries.map((e) => e.udid))
  const booted = devices.filter((d) => d.state === "Booted")
  if (!booted.some((d) => d.name === simulator)) {
    failures.push(`No "${simulator}" simulator is booted after the run: Tapsmith did not boot the configured simulator.`)
  }
  for (const d of booted) {
    if (d.name === simulator) continue
    if (WORKER_CLONE.test(d.name) && tracked.has(d.udid)) continue
    failures.push(`${d.name} (${d.udid}) was booted too, but the run only needed "${simulator}".`)
  }
  if (booted.filter((d) => d.name === simulator).length > 1) {
    failures.push(`More than one "${simulator}" simulator is booted.`)
  }
  for (const d of devices) {
    if (WORKER_CLONE.test(d.name) && !tracked.has(d.udid)) {
      failures.push(`Orphaned worker simulator ${d.name} (${d.udid}) is not in the simulator manifest.`)
    }
  }
  const present = new Set(devices.map((d) => d.udid))
  for (const e of manifest.entries) {
    if (!present.has(e.udid)) {
      failures.push(`The simulator manifest records ${e.name} (${e.udid}), which no longer exists.`)
    }
  }
  return failures
}
