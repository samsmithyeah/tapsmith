/**
 * Emulator lifecycle management for parallel test execution.
 *
 * Provides utilities to discover AVDs, launch emulators on specific ports,
 * wait for boot, and clean up on exit. Used by the dispatcher when
 * `launchEmulators: true` to auto-provision devices for workers.
 *
 * @see PILOT-106
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import type { DeviceStrategy } from './config.js'

const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

type ExecFileSyncLike = typeof execFileSync

export interface AdbDeviceEntry {
  serial: string
  state: string
}

// ─── Emulator discovery ───

/**
 * List devices known to ADB, including offline transports.
 */
export function listAdbDevices(): AdbDeviceEntry[] {
  try {
    const output = execFileSync('adb', ['devices'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('List of devices attached'))
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map((parts) => ({ serial: parts[0], state: parts[1] }))
  } catch {
    return []
  }
}

/**
 * Clear stale offline emulator transports from ADB.
 *
 * Interrupted runs can leave emulator serials stuck in `offline` even after
 * the underlying process is gone. `adb reconnect offline` clears those stale
 * transports so future provisioning starts from a cleaner inventory.
 */
export function clearOfflineEmulatorTransports(): string[] {
  const offlineEmulators = listAdbDevices()
    .filter((device) => device.state === 'offline' && device.serial.startsWith('emulator-'))
    .map((device) => device.serial)

  if (offlineEmulators.length === 0) {
    return []
  }

  try {
    execFileSync('adb', ['reconnect', 'offline'], {
      timeout: 10_000,
      stdio: 'ignore',
    })
  } catch {
    // Best effort
  }

  return offlineEmulators
}

/**
 * List available Android Virtual Devices (AVDs).
 * Runs `emulator -list-avds` and returns the AVD names.
 */
export function listAvds(): string[] {
  try {
    const output = execFileSync('emulator', ['-list-avds'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/**
 * Get the AVD name of a running emulator by its serial.
 * Runs `adb -s <serial> emu avd name`.
 */
export function getRunningAvdName(serial: string): string | undefined {
  try {
    const output = execFileSync('adb', ['-s', serial, 'emu', 'avd', 'name'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Output is "AVD_NAME\nOK\n"
    const lines = output.trim().split('\n')
    return lines[0]?.trim() || undefined
  } catch {
    return undefined
  }
}

// ─── Emulator port management ───

/** Base port for emulator console (even ports: 5554, 5556, 5558, ...) */
const BASE_EMULATOR_PORT = 5554

/**
 * Find the next available emulator console port.
 * Emulator ports must be even numbers. The ADB serial will be `emulator-{port}`.
 */
export function findAvailablePort(usedPorts: Set<number>): number {
  let port = BASE_EMULATOR_PORT
  while (usedPorts.has(port)) {
    port += 2
  }
  return port
}

/**
 * Get the serial for a given emulator console port.
 */
export function serialForPort(port: number): string {
  return `emulator-${port}`
}

// ─── Emulator launch ───

export interface LaunchedEmulator {
  process: ChildProcess
  port: number
  serial: string
  avd: string
}

export interface DeviceHealthResult {
  serial: string
  healthy: boolean
  reason?: string
}

export interface DeviceSelectionResult {
  selectedSerials: string[]
  skippedDevices: Array<{ serial: string; reason: string }>
}

/**
 * Launch an emulator instance for the given AVD on the specified port.
 * Returns immediately — use `waitForBoot` to wait until the device is ready.
 */
export function launchEmulator(avd: string, port: number): LaunchedEmulator {
  const serial = serialForPort(port)

  const proc = spawn('emulator', [
    '-avd', avd,
    '-port', String(port),
    '-read-only',
    '-no-snapshot-load',
    '-no-snapshot-save',
    '-no-boot-anim',
    '-no-audio',
    '-gpu', 'swiftshader_indirect',
  ], {
    detached: true,
    stdio: 'ignore',
  })

  proc.unref()

  proc.on('error', () => {
    // Handled by waitForBoot timeout
  })

  return { process: proc, port, serial, avd }
}

/**
 * Probe whether a device is healthy enough to be assigned to a worker.
 *
 * Checks:
 * - ADB shell is responsive
 * - Emulators report boot completed
 * - Android package manager is responding
 */
export function probeDeviceHealth(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): DeviceHealthResult {
  const adb = (args: string[], timeout: number): string =>
    String(exec('adb', ['-s', serial, ...args], {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))

  try {
    const echo = adb(['shell', 'echo', '__pilot_health_ok__'], 5_000)
    if (!echo.includes('__pilot_health_ok__')) {
      return { serial, healthy: false, reason: 'ADB shell did not respond correctly' }
    }
  } catch {
    return { serial, healthy: false, reason: 'ADB shell is unresponsive' }
  }

  if (serial.startsWith('emulator-')) {
    try {
      const bootCompleted = adb(['shell', 'getprop', 'sys.boot_completed'], 5_000).trim()
      if (bootCompleted !== '1') {
        return { serial, healthy: false, reason: 'emulator is not fully booted' }
      }
    } catch {
      return { serial, healthy: false, reason: 'emulator boot status could not be read' }
    }
  }

  try {
    const packageManager = adb(['shell', 'pm', 'path', 'android'], 10_000)
    if (!packageManager.includes('package:')) {
      return { serial, healthy: false, reason: 'package manager is not ready' }
    }
  } catch {
    return { serial, healthy: false, reason: 'package manager is unresponsive' }
  }

  return { serial, healthy: true }
}

/**
 * Filter a device list down to healthy candidates, returning probe results
 * for any devices that should be excluded from worker assignment.
 */
export function filterHealthyDevices(
  serials: string[],
  exec: ExecFileSyncLike = execFileSync,
): { healthySerials: string[]; unhealthyDevices: DeviceHealthResult[] } {
  const healthySerials: string[] = []
  const unhealthyDevices: DeviceHealthResult[] = []

  for (const serial of serials) {
    const result = probeDeviceHealth(serial, exec)
    if (result.healthy) {
      healthySerials.push(serial)
    } else {
      unhealthyDevices.push(result)
    }
  }

  return { healthySerials, unhealthyDevices }
}

export function selectDevicesForStrategy(
  serials: string[],
  strategy: DeviceStrategy,
  avd: string | undefined,
  resolveAvdName: (serial: string) => string | undefined = getRunningAvdName,
): DeviceSelectionResult {
  if (strategy === 'prefer-connected') {
    return { selectedSerials: serials, skippedDevices: [] }
  }

  if (!avd) {
    throw new Error('deviceStrategy "avd-only" requires `avd` to be set in config')
  }

  const selectedSerials: string[] = []
  const skippedDevices: Array<{ serial: string; reason: string }> = []

  for (const serial of serials) {
    const runningAvd = serial.startsWith('emulator-') ? resolveAvdName(serial) : undefined
    if (runningAvd === avd) {
      selectedSerials.push(serial)
      continue
    }

    skippedDevices.push({
      serial,
      reason: serial.startsWith('emulator-')
        ? `running AVD ${runningAvd ?? 'unknown'} does not match requested AVD ${avd}`
        : `device is not an emulator instance of requested AVD ${avd}`,
    })
  }

  return { selectedSerials, skippedDevices }
}

/**
 * Wait for an emulator to finish booting.
 * Polls `adb -s <serial> shell getprop sys.boot_completed` until it returns "1".
 */
export async function waitForBoot(serial: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  const pollInterval = 2_000

  // First wait for the device to appear in ADB
  while (Date.now() - start < timeoutMs) {
    try {
      execFileSync('adb', ['-s', serial, 'wait-for-device'], {
        timeout: 10_000,
        stdio: 'ignore',
      })
      break
    } catch {
      await sleep(pollInterval)
    }
  }

  // Then wait for boot_completed
  while (Date.now() - start < timeoutMs) {
    try {
      const result = execFileSync(
        'adb',
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      if (result.trim() === '1') {
        return
      }
    } catch {
      // Device not ready yet
    }
    await sleep(pollInterval)
  }

  throw new Error(`Emulator ${serial} did not boot within ${timeoutMs / 1000}s`)
}

// ─── Emulator shutdown ───

/**
 * Kill an emulator by serial.
 */
export function killEmulator(serial: string): void {
  try {
    execFileSync('adb', ['-s', serial, 'emu', 'kill'], {
      timeout: 10_000,
      stdio: 'ignore',
    })
  } catch {
    // Best effort — emulator may already be dead
  }
}

// ─── High-level orchestration ───

export interface ProvisionResult {
  launched: LaunchedEmulator[]
  allSerials: string[]
}

interface ProvisionDeps {
  listAvds: () => string[]
  getRunningAvdName: (serial: string) => string | undefined
  launchEmulator: (avd: string, port: number) => LaunchedEmulator
  waitForBoot: (serial: string, timeoutMs?: number) => Promise<void>
  probeDeviceHealth: (serial: string) => DeviceHealthResult
  killEmulator: (serial: string) => void
}

/**
 * Ensure enough emulators are running to satisfy the requested worker count.
 *
 * - Discovers already-running devices from the provided list
 * - Launches additional emulators if `launchEmulators` is true and an `avd` is specified
 * - Returns the full list of device serials and handles to launched emulators (for cleanup)
 */
export async function provisionEmulators(opts: {
  existingSerials: string[]
  occupiedSerials?: string[]
  workers: number
  avd?: string
}, deps: Partial<ProvisionDeps> = {}): Promise<ProvisionResult> {
  const { existingSerials, occupiedSerials = existingSerials, workers, avd } = opts
  const resolvedDeps: ProvisionDeps = {
    listAvds: deps.listAvds ?? listAvds,
    getRunningAvdName: deps.getRunningAvdName ?? getRunningAvdName,
    launchEmulator: deps.launchEmulator ?? launchEmulator,
    waitForBoot: deps.waitForBoot ?? waitForBoot,
    probeDeviceHealth: deps.probeDeviceHealth ?? probeDeviceHealth,
    killEmulator: deps.killEmulator ?? killEmulator,
  }
  const needed = workers - existingSerials.length

  if (needed <= 0) {
    return { launched: [], allSerials: existingSerials.slice(0, workers) }
  }

  const avds = resolvedDeps.listAvds()
  if (avds.length === 0) {
    throw new Error(
      `Need ${needed} more emulator(s) but no AVDs found. ` +
      'Create an AVD with Android Studio or `avdmanager`, or set the `avd` config option.',
    )
  }

  // Track which AVDs are already running. We still prefer the requested AVD
  // even when it is already in use, because Pilot launches new instances with
  // -read-only and should treat "N workers on N instances of the same AVD"
  // as the primary supported path.
  const runningAvds = new Set<string>()
  for (const serial of occupiedSerials) {
    if (serial.startsWith('emulator-')) {
      const name = resolvedDeps.getRunningAvdName(serial)
      if (name) runningAvds.add(name)
    }
  }

  const launchCandidates = resolveLaunchCandidates(avds, avd, runningAvds)

  // Determine which ports are already in use
  const usedPorts = new Set<number>()
  for (const serial of occupiedSerials) {
    const match = serial.match(/^emulator-(\d+)$/)
    if (match) {
      usedPorts.add(parseInt(match[1], 10))
    }
  }

  // Launch emulators
  const launched: LaunchedEmulator[] = []
  const badAvds = new Set<string>()
  if (avd) {
    process.stderr.write(
      `${DIM}Launching ${needed} emulator(s) using AVD ${avd}...${RESET}\n`,
    )
  } else {
    process.stderr.write(
      `${DIM}Launching ${needed} emulator(s) from available AVDs (${launchCandidates.join(', ')})...${RESET}\n`,
    )
  }

  for (let i = 0; i < needed; i++) {
    let launchedEmulator: LaunchedEmulator | undefined

    for (const candidateAvd of launchCandidates) {
      if (badAvds.has(candidateAvd)) continue

      const port = findAvailablePort(usedPorts)
      usedPorts.add(port)
      const emu = resolvedDeps.launchEmulator(candidateAvd, port)
      process.stderr.write(
        `${DIM}  Starting ${emu.serial} (port ${port}, AVD ${candidateAvd})${RESET}\n`,
      )

      try {
        await resolvedDeps.waitForBoot(emu.serial)
        const health = resolvedDeps.probeDeviceHealth(emu.serial)
        if (!health.healthy) {
          throw new Error(health.reason ?? 'device health probe failed')
        }
        launchedEmulator = emu
        launched.push(emu)
        break
      } catch (err) {
        badAvds.add(candidateAvd)
        process.stderr.write(
          `${YELLOW}Skipping launched emulator ${emu.serial} (${candidateAvd}): ${err instanceof Error ? err.message : err}.${RESET}\n`,
        )
        resolvedDeps.killEmulator(emu.serial)
        try {
          emu.process.kill()
        } catch {
          // Already dead
        }
      }
    }

    if (!launchedEmulator) {
      process.stderr.write(
        `${YELLOW}Unable to provision additional emulator ${i + 1}/${needed}; ${avd ? `AVD ${avd}` : 'all candidate AVDs'} failed health checks.${RESET}\n`,
      )
      break
    }
  }

  if (launched.length > 0) {
    process.stderr.write(`${DIM}Provisioned ${launched.length} healthy emulator(s).${RESET}\n`)
  }

  const allSerials = [
    ...existingSerials,
    ...launched.map((emu) => emu.serial),
  ].slice(0, workers)

  return { launched, allSerials }
}

/**
 * Shut down all emulators that were launched by `provisionEmulators`.
 */
export function cleanupEmulators(launched: LaunchedEmulator[]): void {
  for (const emu of launched) {
    killEmulator(emu.serial)
    try {
      emu.process.kill()
    } catch {
      // Already dead
    }
  }
}

function resolveLaunchCandidates(
  avds: string[],
  requestedAvd: string | undefined,
  runningAvds: Set<string>,
): string[] {
  if (!requestedAvd) {
    const available = avds.filter((avd) => !runningAvds.has(avd))
    if (available.length === 0) {
      throw new Error(
        'No launchable AVDs are available. All discovered AVDs are already running.',
      )
    }
    process.stderr.write(
      `${YELLOW}No avd specified in config. Use the 'avd' config option to control which AVD is launched.${RESET}\n`,
    )
    return available
  }

  if (!avds.includes(requestedAvd)) {
    throw new Error(
      `AVD "${requestedAvd}" not found. Available AVDs: ${avds.join(', ') || '(none)'}`,
    )
  }

  if (runningAvds.has(requestedAvd)) {
    process.stderr.write(
      `${YELLOW}AVD "${requestedAvd}" is already running. Pilot will still try additional read-only instances of that AVD first.${RESET}\n`,
    )
  }

  return [requestedAvd]
}

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
