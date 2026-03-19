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
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { DeviceStrategy } from './config.js'

const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const DEVICE_STABILITY_POLL_MS = 2_000
const DEFAULT_DEVICE_STABILITY_TIMEOUT_MS = 20_000
const REQUIRED_STABLE_HEALTH_CHECKS = 2
const POST_BOOT_SETTLE_TIMEOUT_MS = 30_000
const POST_BOOT_SETTLE_POLL_MS = 2_000

// ─── Emulator PID manifest ───
//
// Tracks which emulators Pilot launched so they can be cleaned up on the next
// run if the previous process died without running its cleanup code.

interface EmulatorManifestEntry {
  serial: string
  pid: number
  avd: string
  port: number
  launchedAt: string
}

function manifestPath(): string {
  return path.join(os.tmpdir(), 'pilot-emulators.json')
}

// Note: read/write is not atomic. Concurrent Pilot runs may race on this file.
// In practice this is rare and the worst case is a stale manifest entry that
// gets cleaned up on the next run via reclaimOrphanedEmulators().
function readManifest(): EmulatorManifestEntry[] {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf-8')
    const entries = JSON.parse(raw)
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

function writeManifest(entries: EmulatorManifestEntry[]): void {
  try {
    fs.writeFileSync(manifestPath(), JSON.stringify(entries, null, 2))
  } catch {
    // Best effort — tmp dir might be read-only in exotic setups
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Record launched emulators in the PID manifest so a future run can clean
 * them up if this process dies without running its cleanup code.
 */
export function recordLaunchedEmulators(launched: LaunchedEmulator[]): void {
  const existing = readManifest()
  const newEntries: EmulatorManifestEntry[] = launched.map((emu) => ({
    serial: emu.serial,
    pid: emu.process.pid ?? -1,
    avd: emu.avd,
    port: emu.port,
    launchedAt: new Date().toISOString(),
  }))
  writeManifest([...existing, ...newEntries])
}

/**
 * Remove emulators from the PID manifest (called during normal cleanup).
 */
export function unrecordLaunchedEmulators(launched: LaunchedEmulator[]): void {
  const serials = new Set(launched.map((emu) => emu.serial))
  const existing = readManifest()
  writeManifest(existing.filter((entry) => !serials.has(entry.serial)))
}

export interface ReclaimResult {
  /** Serials of healthy emulators from the manifest that can be reused. */
  reusable: string[]
  /** Serials of emulators that were killed (unhealthy or dead process). */
  killed: string[]
}

/**
 * Reclaim healthy emulators from previous Pilot runs, kill unhealthy ones.
 *
 * Reads the PID manifest and health-checks each entry:
 * - **Healthy + process alive**: keep it running and in the manifest for reuse.
 * - **Unhealthy or process dead**: kill it, clean up ADB transport, remove from manifest.
 *
 * This is what makes back-to-back `npx pilot test` fast — emulators survive
 * between runs and get reused instead of relaunched.
 */
export function reclaimOrphanedEmulators(): ReclaimResult {
  const entries = readManifest()
  if (entries.length === 0) return { reusable: [], killed: [] }

  // Deduplicate entries by serial — the manifest can accumulate duplicates
  // if previous runs crashed between record and unrecord.
  const uniqueBySerial = new Map<string, EmulatorManifestEntry>()
  for (const entry of entries) {
    uniqueBySerial.set(entry.serial, entry)
  }

  const reusable: string[] = []
  const killed: string[] = []
  const surviving: EmulatorManifestEntry[] = []
  const adbDevices = listAdbDevices()
  const adbDeviceMap = new Map(adbDevices.map((d) => [d.serial, d]))

  for (const entry of uniqueBySerial.values()) {
    const processAlive = entry.pid > 0 && isProcessAlive(entry.pid)
    const inAdb = adbDeviceMap.get(entry.serial)

    // Process is dead and not in ADB — nothing to do, drop from manifest
    if (!processAlive && !inAdb) {
      continue
    }

    // Process is dead but serial lingers in ADB — clean up the stale transport
    if (!processAlive && inAdb) {
      process.stderr.write(
        `${YELLOW}Cleaning up stale ADB transport ${entry.serial} (process gone, AVD ${entry.avd}).${RESET}\n`,
      )
      killEmulator(entry.serial)
      killed.push(entry.serial)
      continue
    }

    // Process is alive — health check to decide reuse vs kill
    if (inAdb && inAdb.state === 'device') {
      const health = probeDeviceHealth(entry.serial)
      if (health.healthy) {
        process.stderr.write(
          `${DIM}Reusing emulator ${entry.serial} (AVD ${entry.avd}) from previous run.${RESET}\n`,
        )
        reusable.push(entry.serial)
        surviving.push(entry)
        continue
      }
      process.stderr.write(
        `${YELLOW}Killing unhealthy emulator ${entry.serial} (AVD ${entry.avd}): ${health.reason ?? 'health check failed'}.${RESET}\n`,
      )
    } else {
      process.stderr.write(
        `${YELLOW}Killing unresponsive emulator ${entry.serial} (PID ${entry.pid}, AVD ${entry.avd}).${RESET}\n`,
      )
    }

    // Kill by PID directly — more reliable than ADB when device is unresponsive
    try {
      process.kill(entry.pid, 'SIGTERM')
    } catch {
      // Already dead
    }
    if (inAdb) {
      killEmulator(entry.serial)
    }
    killed.push(entry.serial)
  }

  // Write back only the surviving healthy entries
  writeManifest(surviving)
  return { reusable, killed }
}

type ExecFileSyncLike = typeof execFileSync

export interface AdbDeviceEntry {
  serial: string
  state: string
}

// ─── ADB package queries ───

/**
 * Wait for a freshly installed package to appear in `pm path`.
 *
 * After `adb install`, the package manager may take a moment to index the
 * new app. This polls `pm path` instead of using a fixed sleep.
 */
export async function waitForPackageIndexed(
  serial: string,
  packageName: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isPackageInstalled(serial, packageName)) return
    await sleep(500)
  }
  process.stderr.write(
    `${YELLOW}Warning: package ${packageName} not found by pm after ${Math.round(timeoutMs / 1000)}s — continuing anyway.${RESET}\n`,
  )
}

/**
 * Check whether a package is installed on a device via ADB.
 */
export function isPackageInstalled(serial: string, packageName: string): boolean {
  try {
    const output = execFileSync(
      'adb', ['-s', serial, 'shell', 'pm', 'path', packageName],
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return output.includes('package:')
  } catch {
    return false
  }
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

export interface CleanupStaleResult {
  /** Healthy emulators from previous runs that are ready for reuse. */
  reusable: string[]
  /** Emulators that were killed (unhealthy, dead, or stale). */
  killed: string[]
}

/**
 * Clean up stale emulators and reclaim healthy ones for reuse.
 *
 * Two-phase approach:
 * 1. **Manifest-based**: Health-check emulators recorded by previous Pilot
 *    runs. Reuse healthy ones, kill unhealthy/dead ones.
 * 2. **Heuristic**: Kill emulators matching the target AVD that are in an
 *    offline/unauthorized state, or that fail health checks. This catches
 *    edge cases where the manifest was lost (e.g. first run after upgrade).
 */
export function cleanupStaleEmulators(
  targetAvd?: string,
  resolveAvdName: (serial: string) => string | undefined = getRunningAvdName,
): CleanupStaleResult {
  // Phase 1: manifest-based reclaim/kill (precise)
  const reclaim = reclaimOrphanedEmulators()
  const handled = new Set([...reclaim.reusable, ...reclaim.killed])

  // Phase 2: heuristic cleanup for anything the manifest missed
  const devices = listAdbDevices()
  const killed = [...reclaim.killed]

  for (const device of devices) {
    if (!device.serial.startsWith('emulator-')) continue
    if (handled.has(device.serial)) continue

    // Only target emulators running the requested AVD (or all if none specified)
    if (targetAvd) {
      const avdName = resolveAvdName(device.serial)
      if (avdName && avdName !== targetAvd) continue
    }

    // Offline/unauthorized transports are definitely stale
    if (device.state === 'offline' || device.state === 'unauthorized') {
      killEmulator(device.serial)
      killed.push(device.serial)
      continue
    }

    // For "device" state, run a quick health check
    if (device.state === 'device') {
      const health = probeDeviceHealth(device.serial)
      if (!health.healthy) {
        process.stderr.write(
          `${YELLOW}Killing stale emulator ${device.serial}: ${health.reason ?? 'health check failed'}.${RESET}\n`,
        )
        killEmulator(device.serial)
        killed.push(device.serial)
      }
    }
  }

  // Wait for ADB to settle after kills. `adb emu kill` and process kills are
  // async — the transports linger in `adb devices` for a few seconds. Without
  // this wait, the very next `adb devices` call (in device discovery) will see
  // the dead emulators as "offline" or "device" and waste time on them.
  if (killed.length > 0) {
    waitForAdbSettle(killed)
  }

  return { reusable: reclaim.reusable, killed }
}

/**
 * Dismiss system ANR/crash dialogs via ADB shell commands.
 *
 * This works at the ADB level — no agent or UI framework needed. It uses
 * `input keyevent` to press Enter/Back (which dismisses most system dialogs)
 * and force-stops the Launcher if it's in an ANR state.
 *
 * Call this before starting the Pilot agent on a freshly booted emulator.
 */
export function dismissSystemDialogsViaAdb(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): boolean {
  const hierarchy = readUiHierarchyViaAdb(serial, exec)
  if (!hierarchy) return false

  const blockingDialog = detectBlockingSystemDialog(hierarchy)
  if (!blockingDialog) return false

  const adb = (args: string[]) => {
    try {
      exec('adb', ['-s', serial, ...args], {
        timeout: 5_000,
        stdio: 'ignore',
      })
    } catch {
      // Best effort
    }
  }

  // Try pressing "Wait" or "OK" by sending ENTER keyevent
  adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER'])
  // Small delay to let the dialog dismiss
  try {
    exec('adb', ['-s', serial, 'shell', 'sleep', '1'], {
      timeout: 5_000,
      stdio: 'ignore',
    })
  } catch { /* best effort */ }

  // Force-stop the Launcher to clear any ANR state
  adb(['shell', 'am', 'force-stop', 'com.google.android.apps.nexuslauncher'])
  adb(['shell', 'am', 'force-stop', 'com.android.launcher3'])

  // Press BACK to dismiss any remaining system dialogs
  adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])

  // Press HOME to reset to a clean state
  adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])

  // Verify the dialog is gone
  const afterHierarchy = readUiHierarchyViaAdb(serial, exec)
  if (afterHierarchy && detectBlockingSystemDialog(afterHierarchy)) {
    // Still there — try one more aggressive approach: dismiss ALL crash dialogs
    adb(['shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS'])
    return false
  }

  return true
}

/**
 * Wait for system services to settle after boot.
 *
 * Even after `sys.boot_completed=1`, critical services like the Launcher,
 * package manager, and input system can take several more seconds to
 * stabilize. This function polls for readiness of those services and
 * auto-dismisses any ANR dialogs that appear during settling.
 */
export async function waitForSystemSettle(
  serial: string,
  timeoutMs = POST_BOOT_SETTLE_TIMEOUT_MS,
  exec: ExecFileSyncLike = execFileSync,
): Promise<void> {
  const start = Date.now()

  const adb = (args: string[], timeout = 5_000): string => {
    return String(exec('adb', ['-s', serial, ...args], {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
  }

  while (Date.now() - start < timeoutMs) {
    // Dismiss any ANR dialogs that pop up during boot settling
    dismissSystemDialogsViaAdb(serial, exec)

    let servicesReady = true

    // Check that the launcher is running (not crashed)
    try {
      const launcherState = adb(['shell', 'dumpsys', 'activity', 'activities'], 10_000)
      const hasLauncher = launcherState.includes('com.google.android.apps.nexuslauncher')
        || launcherState.includes('com.android.launcher3')
        || launcherState.includes('Launcher')
      if (!hasLauncher) {
        servicesReady = false
      }
    } catch {
      servicesReady = false
    }

    // Check that the settings provider is available (indicates system is settled)
    try {
      const settingsResult = adb(['shell', 'settings', 'get', 'system', 'screen_brightness'])
      if (!settingsResult.trim() || settingsResult.includes('null')) {
        servicesReady = false
      }
    } catch {
      servicesReady = false
    }

    if (servicesReady) {
      // One final ANR check after services are ready
      const hierarchy = readUiHierarchyViaAdb(serial, exec)
      if (!hierarchy || !detectBlockingSystemDialog(hierarchy)) {
        return
      }
      // Dialog still showing — dismiss and keep waiting
      dismissSystemDialogsViaAdb(serial, exec)
    }

    await sleep(POST_BOOT_SETTLE_POLL_MS)
  }

  // Timeout — still do one last dismissal attempt
  dismissSystemDialogsViaAdb(serial, exec)
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

export interface DevicePrefilterResult extends DeviceSelectionResult {
  candidateSerials: string[]
}

function extractHierarchyXml(raw: string): string {
  const start = raw.indexOf('<')
  return start >= 0 ? raw.slice(start) : ''
}

export function detectBlockingSystemDialog(rawHierarchy: string): string | undefined {
  const hierarchy = rawHierarchy.toLowerCase()

  // Patterns that strongly indicate a system ANR/crash dialog — no ambiguity
  const strongPatterns = [
    /isn(?:’|&apos;|’)t responding/,
    /keeps stopping/,
  ]

  // Patterns that only indicate a system dialog when a strong pattern is also present.
  // "wait" and "close app" can appear in normal app UI, so we require them to
  // co-occur with a system dialog indicator to avoid false positives.
  const weakPatterns = [
    /text="wait"/,
    /close app/,
    /app info/,
  ]

  const hasStrongMatch = strongPatterns.some((pattern) => pattern.test(hierarchy))
  const hasWeakMatch = weakPatterns.some((pattern) => pattern.test(hierarchy))

  if (!hasStrongMatch && !hasWeakMatch) return undefined
  // Weak matches alone are not sufficient — require at least one strong indicator
  if (!hasStrongMatch) return undefined

  const compact = rawHierarchy.replace(/\s+/g, ' ').trim()
  return compact.slice(0, 160) || 'blocking system dialog detected'
}

export function readUiHierarchyViaAdb(
  serial: string,
  exec: ExecFileSyncLike = execFileSync,
): string | undefined {
  try {
    const output = String(exec('adb', ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    const xml = extractHierarchyXml(output)
    return xml.trim() || undefined
  } catch {
    return undefined
  }
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
    '-no-window',
  ], {
    // Detach so emulators survive parent exit — they're expensive to boot and
    // the next run will reuse them. The PID manifest tracks ownership so
    // orphans from crashes get cleaned up on the next startup.
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

  const hierarchy = readUiHierarchyViaAdb(serial, exec)
  if (hierarchy) {
    const blockingDialog = detectBlockingSystemDialog(hierarchy)
    if (blockingDialog) {
      // Attempt ADB-level dismissal before declaring unhealthy
      dismissSystemDialogsViaAdb(serial, exec)

      // Re-check after dismissal
      const afterHierarchy = readUiHierarchyViaAdb(serial, exec)
      if (afterHierarchy) {
        const stillBlocked = detectBlockingSystemDialog(afterHierarchy)
        if (stillBlocked) {
          return { serial, healthy: false, reason: `blocking system dialog detected (${stillBlocked})` }
        }
      }
    }
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

export function prefilterDevicesForStrategy(
  serials: string[],
  strategy: DeviceStrategy,
  avd: string | undefined,
  resolveAvdName: (serial: string) => string | undefined = getRunningAvdName,
): DevicePrefilterResult {
  if (strategy === 'prefer-connected') {
    return { candidateSerials: serials, selectedSerials: serials, skippedDevices: [] }
  }

  if (!avd) {
    throw new Error('deviceStrategy "avd-only" requires `avd` to be set in config')
  }

  const candidateSerials: string[] = []
  const selectedSerials: string[] = []
  const skippedDevices: Array<{ serial: string; reason: string }> = []

  for (const serial of serials) {
    if (!serial.startsWith('emulator-')) {
      skippedDevices.push({
        serial,
        reason: `device is not an emulator instance of requested AVD ${avd}`,
      })
      continue
    }

    const runningAvd = resolveAvdName(serial)
    if (runningAvd === avd) {
      candidateSerials.push(serial)
      selectedSerials.push(serial)
      continue
    }

    if (runningAvd) {
      skippedDevices.push({
        serial,
        reason: `running AVD ${runningAvd} does not match requested AVD ${avd}`,
      })
      continue
    }

    // If we cannot determine the AVD yet, keep the device in play so later
    // health/selection checks can make a more informed decision.
    candidateSerials.push(serial)
  }

  return { candidateSerials, selectedSerials, skippedDevices }
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
        // Boot flag is set — now wait for system services to actually settle.
        // This prevents the "passes health check then stalls" pattern where
        // the launcher/PM are still initializing.
        const remainingMs = Math.max(timeoutMs - (Date.now() - start), 10_000)
        await waitForSystemSettle(serial, remainingMs)
        return
      }
    } catch {
      // Device not ready yet
    }
    await sleep(pollInterval)
  }

  throw new Error(`Emulator ${serial} did not boot within ${timeoutMs / 1000}s`)
}

export async function waitForDeviceStability(
  serial: string,
  timeoutMs = DEFAULT_DEVICE_STABILITY_TIMEOUT_MS,
  probe: (serial: string) => DeviceHealthResult = probeDeviceHealth,
): Promise<DeviceHealthResult> {
  const start = Date.now()
  let consecutiveHealthy = 0
  let lastResult: DeviceHealthResult = {
    serial,
    healthy: false,
    reason: 'device stability checks did not complete',
  }

  while (Date.now() - start < timeoutMs) {
    const result = probe(serial)
    lastResult = result

    if (result.healthy) {
      consecutiveHealthy += 1
      if (consecutiveHealthy >= REQUIRED_STABLE_HEALTH_CHECKS) {
        return result
      }
    } else {
      consecutiveHealthy = 0
    }

    await sleep(DEVICE_STABILITY_POLL_MS)
  }

  return lastResult
}

// ─── Emulator shutdown ───

/**
 * Find the OS PID of an emulator process by its console port.
 *
 * When ADB is unresponsive, `adb emu kill` silently fails. We need to find
 * and kill the process directly. The emulator listens on the console port,
 * so we use `lsof` to find the PID.
 */
export function findEmulatorPid(serial: string): number | undefined {
  const match = serial.match(/^emulator-(\d+)$/)
  if (!match) return undefined

  const port = match[1]
  try {
    const output = execFileSync(
      'lsof',
      ['-ti', `TCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const pid = parseInt(output.trim().split('\n')[0], 10)
    return isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

/**
 * Kill an emulator by serial.
 *
 * Tries `adb emu kill` first (graceful), then falls back to finding and
 * killing the OS process directly. This handles cases where ADB is
 * unresponsive but the emulator process is still alive.
 */
export function killEmulator(serial: string): void {
  // Try graceful shutdown via ADB
  try {
    execFileSync('adb', ['-s', serial, 'emu', 'kill'], {
      timeout: 5_000,
      stdio: 'ignore',
    })
  } catch {
    // ADB may be unresponsive — fall through to process kill
  }

  // Also kill by OS process as a fallback. Even if `emu kill` succeeded,
  // this is harmless and ensures the process is actually gone.
  const pid = findEmulatorPid(serial)
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already dead
    }
  }

  // Disconnect the ADB transport so it doesn't linger as offline/stale
  try {
    execFileSync('adb', ['disconnect', serial], {
      timeout: 5_000,
      stdio: 'ignore',
    })
  } catch {
    // Best effort
  }
}

/**
 * Wait for killed emulator serials to disappear from `adb devices`.
 *
 * After killing emulators, their transports linger in ADB for a few seconds.
 * This function polls until all the specified serials are gone or in a
 * terminal state (offline), with a short timeout so we don't block forever.
 */
function waitForAdbSettle(killedSerials: string[], timeoutMs = 10_000): void {
  const start = Date.now()
  const pending = new Set(killedSerials)

  while (pending.size > 0 && Date.now() - start < timeoutMs) {
    const devices = listAdbDevices()
    const activeSerials = new Set(
      devices
        .filter((d) => d.state === 'device' || d.state === 'unauthorized')
        .map((d) => d.serial),
    )

    for (const serial of [...pending]) {
      if (!activeSerials.has(serial)) {
        pending.delete(serial)
      }
    }

    if (pending.size > 0) {
      sleepSync(1_000)
    }
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
  waitForDeviceStability: (
    serial: string,
    timeoutMs?: number,
    probe?: (serial: string) => DeviceHealthResult,
  ) => Promise<DeviceHealthResult>
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
    waitForDeviceStability: deps.waitForDeviceStability ?? waitForDeviceStability,
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
  const existingCount = existingSerials.length
  const existingNote = existingCount > 0
    ? ` (${existingCount} already connected, need ${workers} total)`
    : ''
  if (avd) {
    process.stderr.write(
      `${DIM}Launching ${needed} emulator(s) using AVD ${avd}${existingNote}...${RESET}\n`,
    )
  } else {
    process.stderr.write(
      `${DIM}Launching ${needed} emulator(s) from available AVDs (${launchCandidates.join(', ')})${existingNote}...${RESET}\n`,
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
        const health = await resolvedDeps.waitForDeviceStability(
          emu.serial,
          DEFAULT_DEVICE_STABILITY_TIMEOUT_MS,
          resolvedDeps.probeDeviceHealth,
        )
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
    recordLaunchedEmulators(launched)
    process.stderr.write(`${DIM}Provisioned ${launched.length} healthy emulator(s).${RESET}\n`)
  }

  const allSerials = [
    ...existingSerials,
    ...launched.map((emu) => emu.serial),
  ].slice(0, workers)

  return { launched, allSerials }
}

/**
 * Normal exit cleanup — leave emulators running for reuse by the next run.
 *
 * Emulators are expensive to boot (30-60s). On normal exit we intentionally
 * keep them alive so the next `npx pilot test` can reuse them instantly.
 * The PID manifest is preserved so the next run knows they're ours.
 *
 * Only ADB port forwards (created by per-worker daemons) are cleaned up,
 * since stale forwards break subsequent runs.
 */
export function preserveEmulatorsForReuse(_launched: LaunchedEmulator[]): void {
  // Intentionally a no-op. Emulators stay alive and in the PID manifest so
  // the next run can reuse them via reclaimOrphanedEmulators().
}

/**
 * Emergency cleanup — kill everything. Used on SIGINT/SIGTERM or fatal errors
 * where we can't guarantee the emulators will be in a usable state.
 */
export function forceCleanupEmulators(launched: LaunchedEmulator[]): void {
  for (const emu of launched) {
    killEmulator(emu.serial)
    try {
      emu.process.kill('SIGTERM')
    } catch {
      // Already dead
    }
  }
  unrecordLaunchedEmulators(launched)
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

  // Same-AVD multi-instance is the normal path — no warning needed.

  return [requestedAvd]
}

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Block the current thread for `ms` milliseconds without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
