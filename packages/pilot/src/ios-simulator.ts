/**
 * iOS simulator management utilities.
 *
 * Parallel to `emulator.ts` for Android, this module wraps `xcrun simctl`
 * commands for discovering, booting, and managing iOS simulators.
 *
 * All simctl calls are synchronous (`execFileSync`) because the parallel
 * provisioning loop needs deterministic ordering — clone, boot, and health
 * checks must complete in sequence per simulator. `Atomics.wait` is used for
 * brief sleeps between retries since `setTimeout` requires an async context.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SimulatorInfo {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  runtime: string
  deviceType: string
}

/**
 * List all available iOS simulators.
 * Returns only simulators marked as available by Xcode.
 */
export function listSimulators(): SimulatorInfo[] {
  try {
    const output = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });

    const parsed = JSON.parse(output) as {
      devices: Record<string, Array<{
        udid: string
        name: string
        state: string
        isAvailable: boolean
        deviceTypeIdentifier?: string
      }>>
    };

    const simulators: SimulatorInfo[] = [];
    for (const [runtime, devices] of Object.entries(parsed.devices)) {
      for (const device of devices) {
        if (device.isAvailable) {
          simulators.push({
            udid: device.udid,
            name: device.name,
            state: device.state,
            isAvailable: device.isAvailable,
            runtime,
            deviceType: device.deviceTypeIdentifier ?? '',
          });
        }
      }
    }

    return simulators;
  } catch {
    return [];
  }
}

/**
 * Get the screen scale (device pixel ratio) for an iOS simulator.
 * iPads are @2x, all modern iPhones are @3x.
 * Falls back to 3 if the device is unknown.
 */
export function getSimulatorScreenScale(udid: string): number {
  const sim = listSimulators().find((s) => s.udid === udid);
  if (sim && /iPad/i.test(sim.name)) return 2;
  return 3;
}

/**
 * List booted iOS simulators.
 */
export function listBootedSimulators(): SimulatorInfo[] {
  return listSimulators().filter((s) => s.state === 'Booted');
}

/**
 * List booted simulators compatible with a primary device for multi-worker use.
 *
 * Only returns simulators that share the same iOS runtime as the primary device.
 * This prevents xcodebuild test-without-building failures from runtime mismatches
 * (e.g. an xctestrun built for iOS 26.4 won't work on a simulator running 26.1).
 */
export function listCompatibleBootedSimulators(primaryUdid: string): SimulatorInfo[] {
  const booted = listBootedSimulators();
  const primary = booted.find((s) => s.udid === primaryUdid);
  if (!primary) return [];
  return booted.filter((s) => s.runtime === primary.runtime);
}

/**
 * Boot a simulator by UDID.
 */
export function bootSimulator(udid: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'boot', udid], {
      timeout: 30_000,
    });
  } catch (err) {
    // "Unable to boot device in current state: Booted" is not an error.
    // Check both the error message and stderr output.
    const errObj = err as { message?: string; stderr?: Buffer | string };
    const msg = errObj.message ?? '';
    const stderr = errObj.stderr?.toString() ?? '';
    if (!msg.includes('Booted') && !stderr.includes('Booted')) {
      throw err;
    }
  }
}

/**
 * Shutdown a simulator by UDID.
 */
export function shutdownSimulator(udid: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'shutdown', udid], {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch {
    // Shutting down an already-shutdown simulator is fine
  }
}

/**
 * Reboot a simulator: shutdown then boot. Handles simulators stuck in
 * "Shutting Down" state by waiting for the shutdown to complete before
 * booting.
 */
export function rebootSimulator(udid: string): void {
  shutdownSimulator(udid);

  // Wait for the simulator to fully shut down (up to 15s).
  // Simulators in "Shutting Down" state take a few seconds to transition
  // to "Shutdown" before they can be booted again.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sims = listSimulators();
    const sim = sims.find((s) => s.udid === udid);
    if (!sim || sim.state === 'Shutdown') break;
    if (sim.state === 'Booted') break; // Already booted (shutdown was no-op)
    // Still shutting down — wait (busy-loop with Atomics for sub-second sync sleep)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }

  bootSimulator(udid);

  // Wait for the simulator to be ready (launchd responsive)
  const bootDeadline = Date.now() + 30_000;
  while (Date.now() < bootDeadline) {
    const result = probeSimulatorHealth(udid);
    if (result.healthy) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

/**
 * Install an app bundle on a simulator.
 */
export function installApp(udid: string, appPath: string): void {
  execFileSync('xcrun', ['simctl', 'install', udid, appPath], {
    timeout: 60_000,
    stdio: 'ignore',
  });
}

/**
 * Check whether an app bundle is already installed on a simulator.
 */
export function isAppInstalled(udid: string, bundleId: string): boolean {
  try {
    execFileSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], {
      timeout: 10_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a simulator matching the given name (or UDID).
 * Prefers booted simulators. Returns undefined if no match found.
 */
export function findSimulator(nameOrUdid: string): SimulatorInfo | undefined {
  const all = listSimulators();

  // Try exact UDID match first
  const byUdid = all.find((s) => s.udid === nameOrUdid);
  if (byUdid) return byUdid;

  // Try name match, preferring booted ones
  const byName = all.filter((s) => s.name === nameOrUdid);
  const booted = byName.find((s) => s.state === 'Booted');
  if (booted) return booted;

  return byName[0];
}

/**
 * Provision a simulator for testing: find by name, boot if needed, install app.
 * Returns the UDID of the booted simulator.
 */
export function provisionSimulator(
  simulatorName: string,
  appPath?: string,
): string {
  const sim = findSimulator(simulatorName);
  if (!sim) {
    throw new Error(
      `No iOS simulator found matching '${simulatorName}'. ` +
        `Run 'xcrun simctl list devices' to see available simulators.`,
    );
  }

  if (sim.state !== 'Booted') {
    bootSimulator(sim.udid);
  }

  if (appPath) {
    installApp(sim.udid, appPath);
  }

  return sim.udid;
}

/**
 * Poll until a simulator reaches the expected state.
 */
function waitForSimulatorState(udid: string, expectedState: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sims = listSimulators();
    const sim = sims.find((s) => s.udid === udid);
    if (sim?.state === expectedState) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

// ─── Parallel provisioning ───

export interface ClonedSimulator {
  udid: string
  name: string
  cloned: boolean
}

export interface ProvisionSimulatorsResult {
  /** All simulator UDIDs available for workers (existing booted + newly booted/cloned). */
  allUdids: string[]
  /** Simulators that were cloned and should be cleaned up after the run. */
  clonedSimulators: ClonedSimulator[]
  /** UDIDs that were freshly booted or cloned — need longer init timeouts. */
  freshUdids: Set<string>
}

/**
 * Create a new simulator from a device type and runtime, returning the new UDID.
 */
export function createSimulator(name: string, deviceType: string, runtime: string): string {
  const output = execFileSync('xcrun', ['simctl', 'create', name, deviceType, runtime], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return output.trim();
}

/**
 * Clone a simulator, returning the new UDID.
 */
export function cloneSimulator(sourceUdid: string, newName: string): string {
  const output = execFileSync('xcrun', ['simctl', 'clone', sourceUdid, newName], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  // simctl clone prints the new UDID on stdout
  return output.trim();
}

/**
 * Delete a simulator by UDID.
 */
export function deleteSimulator(udid: string): void {
  try {
    shutdownSimulator(udid);
    execFileSync('xcrun', ['simctl', 'delete', udid], {
      timeout: 30_000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort cleanup
  }
}

// ─── Simulator manifest ───
//
// Tracks which simulators Pilot cloned so they can be reused across runs
// (or cleaned up if the previous process died without cleanup).

interface SimulatorManifestEntry {
  udid: string
  name: string
  sourceName: string
  createdAt: string
}

function simulatorManifestPath(): string {
  return path.join(os.tmpdir(), 'pilot-simulators.json');
}

// Note: read/write is not atomic. Concurrent Pilot runs may race on this file.
// In practice this is rare and the worst case is a stale entry cleaned up next run.
function readSimulatorManifest(): SimulatorManifestEntry[] {
  try {
    const raw = fs.readFileSync(simulatorManifestPath(), 'utf-8');
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeSimulatorManifest(entries: SimulatorManifestEntry[]): void {
  try {
    fs.writeFileSync(simulatorManifestPath(), JSON.stringify(entries, null, 2));
  } catch {
    // Best effort — tmp dir might be read-only in exotic setups
  }
}

/**
 * Record cloned simulators in the manifest so a future run can reuse them.
 */
export function recordClonedSimulators(
  clones: ClonedSimulator[],
  sourceName: string,
): void {
  const existing = readSimulatorManifest();
  const existingUdids = new Set(existing.map((e) => e.udid));
  const newEntries: SimulatorManifestEntry[] = clones
    .filter((c) => !existingUdids.has(c.udid))
    .map((c) => ({
      udid: c.udid,
      name: c.name,
      sourceName,
      createdAt: new Date().toISOString(),
    }));
  writeSimulatorManifest([...existing, ...newEntries]);
}

/**
 * Remove simulators from the manifest (called during force-cleanup).
 */
export function unrecordSimulators(udids: string[]): void {
  const toRemove = new Set(udids);
  const existing = readSimulatorManifest();
  writeSimulatorManifest(existing.filter((e) => !toRemove.has(e.udid)));
}

// ─── Health checks ───

export interface SimulatorHealthResult {
  udid: string
  healthy: boolean
  reason?: string
}

/**
 * Probe whether a simulator is healthy and usable for testing.
 *
 * Checks: exists in simctl list, is booted, launchd is responsive.
 */
export function probeSimulatorHealth(udid: string): SimulatorHealthResult {
  // Check 1: exists and is booted
  const sims = listSimulators();
  const sim = sims.find((s) => s.udid === udid);
  if (!sim) {
    return { udid, healthy: false, reason: 'simulator no longer exists' };
  }
  if (sim.state !== 'Booted') {
    return { udid, healthy: false, reason: `simulator is ${sim.state}, not Booted` };
  }

  // Check 2: launchd is responsive (proves the sim's system services are running)
  try {
    execFileSync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'print', 'system'], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch {
    return { udid, healthy: false, reason: 'simulator launchd is unresponsive' };
  }

  return { udid, healthy: true };
}

/**
 * Batch health-check a list of simulator UDIDs.
 */
export function filterHealthySimulators(
  udids: string[],
): { healthyUdids: string[]; unhealthySimulators: SimulatorHealthResult[] } {
  const healthyUdids: string[] = [];
  const unhealthySimulators: SimulatorHealthResult[] = [];

  for (const udid of udids) {
    const result = probeSimulatorHealth(udid);
    if (result.healthy) {
      healthyUdids.push(udid);
    } else {
      unhealthySimulators.push(result);
    }
  }

  return { healthyUdids, unhealthySimulators };
}

// ─── Stale cleanup ───

export interface CleanupStaleSimulatorsResult {
  /** UDIDs of healthy clones ready for reuse. */
  reusable: string[]
  /** UDIDs of deleted clones. */
  killed: string[]
}

/**
 * Clean up stale simulators from previous runs and identify reusable clones.
 *
 * Phase 1: Manifest-based — health-check tracked clones, reuse healthy ones, delete unhealthy.
 * Phase 2: Heuristic — delete orphaned "Pilot Worker" sims not in manifest.
 * Phase 3: Kill stale xcodebuild processes referencing deleted sims.
 */
export function cleanupStaleSimulators(
  simulatorName: string,
): CleanupStaleSimulatorsResult {
  const reusable: string[] = [];
  const killed: string[] = [];
  const handledUdids = new Set<string>();

  // Phase 1: manifest-based reclamation
  const manifest = readSimulatorManifest();
  const surviving: SimulatorManifestEntry[] = [];

  for (const entry of manifest) {
    // Only reclaim clones matching the current simulator name
    if (entry.sourceName !== simulatorName) {
      surviving.push(entry);
      handledUdids.add(entry.udid);
      continue;
    }

    const health = probeSimulatorHealth(entry.udid);
    handledUdids.add(entry.udid);

    if (health.healthy) {
      reusable.push(entry.udid);
      surviving.push(entry);
    } else if (health.reason === 'simulator no longer exists') {
      // Already gone — just drop from manifest
      killed.push(entry.udid);
    } else {
      // Exists but unhealthy — delete it
      deleteSimulator(entry.udid);
      killed.push(entry.udid);
    }
  }

  writeSimulatorManifest(surviving);

  // Phase 2: heuristic cleanup — delete orphaned "Pilot Worker" sims
  const allSims = listSimulators();
  const pilotWorkerPattern = /\(Pilot Worker \d+\)$/;

  for (const sim of allSims) {
    if (handledUdids.has(sim.udid)) continue;
    if (!pilotWorkerPattern.test(sim.name)) continue;

    deleteSimulator(sim.udid);
    killed.push(sim.udid);
  }

  // Phase 3: kill stale xcodebuild processes for deleted sims
  for (const udid of killed) {
    try {
      execFileSync('pkill', ['-f', `xcodebuild.*test-without-building.*id=${udid}`], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch {
      // No matching process — fine
    }
  }

  return { reusable, killed };
}

// ─── Reuse helpers ───

/**
 * Preserve cloned simulators for reuse by the next run.
 * Intentionally a no-op — clones stay booted and in the manifest.
 */
export function preserveSimulatorsForReuse(_cloned: ClonedSimulator[]): void {
  // No-op. Simulators stay alive and in the manifest so the next run
  // can reuse them via cleanupStaleSimulators().
}

/**
 * Emergency cleanup — delete all cloned simulators and remove from manifest.
 * Used on SIGINT/SIGTERM or fatal errors.
 */
export function forceCleanupSimulators(cloned: ClonedSimulator[]): void {
  const udids: string[] = [];
  for (const sim of cloned) {
    deleteSimulator(sim.udid);
    udids.push(sim.udid);
  }
  unrecordSimulators(udids);
}

/**
 * Provision multiple iOS simulators for parallel test execution.
 *
 * Strategy:
 * 1. Start with already-booted simulators matching the name
 * 2. Boot any shutdown simulators that match the name
 * 3. If still not enough, clone the source simulator to create new instances
 *
 * Returns UDIDs for all provisioned simulators.
 */
export function provisionSimulators(opts: {
  /** Simulator name to match (e.g. "iPhone 16"). */
  simulatorName: string
  /** Number of simulators needed. */
  workers: number
  /** UDIDs already assigned to existing workers — skip these. */
  existingUdids?: string[]
  /** Path to .app bundle — install on freshly booted sims so workers don't have to. */
  appPath?: string
  /** UDIDs of reusable clones from cleanupStaleSimulators() — use before cloning new ones. */
  reusableUdids?: string[]
}): ProvisionSimulatorsResult {
  const { simulatorName, workers, existingUdids = [], reusableUdids = [] } = opts;
  const existingSet = new Set(existingUdids);
  const allUdids = [...existingUdids];
  const clonedSimulators: ClonedSimulator[] = [];
  const freshUdids = new Set<string>();

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids };
  }

  // Determine the primary simulator's runtime so we only reuse/boot
  // simulators on the same OS version. Mismatched runtimes cause
  // xcodebuild test-without-building to fail.
  const allSims = listSimulators();
  const primarySim = existingUdids.length > 0
    ? allSims.find((s) => s.udid === existingUdids[0])
    : undefined;
  const primaryRuntime = primarySim?.runtime;

  // Phase 0a: reuse healthy clones from previous runs (already booted)
  for (const udid of reusableUdids) {
    if (allUdids.length >= workers) break;
    if (existingSet.has(udid)) continue;
    const sim = allSims.find((s) => s.udid === udid);
    if (primaryRuntime && sim?.runtime !== primaryRuntime) {
      // Runtime mismatch — delete the stale clone so it gets re-created
      deleteSimulator(udid);
      continue;
    }
    process.stderr.write(
      `\x1b[2mReusing simulator ${udid} (${sim?.name ?? 'unknown'}) from previous run.\x1b[0m\n`,
    );
    allUdids.push(udid);
    // Track as cloned so callers know to manage them
    if (sim) {
      clonedSimulators.push({ udid, name: sim.name, cloned: true });
    }
  }

  // Prune excess reusable clones beyond what we need
  const unusedReusable = reusableUdids.filter((u) => !allUdids.includes(u));
  if (unusedReusable.length > 0) {
    for (const udid of unusedReusable) {
      deleteSimulator(udid);
    }
    unrecordSimulators(unusedReusable);
  }

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids };
  }

  const matching = allSims.filter((s) =>
    s.name === simulatorName
    && !existingSet.has(s.udid)
    && !allUdids.includes(s.udid)
    && (!primaryRuntime || s.runtime === primaryRuntime),
  );

  // Phase 0b: collect already-booted simulators not yet assigned
  const alreadyBooted = matching.filter((s) => s.state === 'Booted');
  for (const sim of alreadyBooted) {
    if (allUdids.length >= workers) break;
    process.stderr.write(
      `\x1b[2mReusing simulator ${sim.udid} (${sim.name}) from previous run.\x1b[0m\n`,
    );
    allUdids.push(sim.udid);
  }

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids };
  }

  // Phase 1: boot any shutdown simulators that match the name
  const shutdown = matching.filter((s) => s.state === 'Shutdown');
  for (const sim of shutdown) {
    if (allUdids.length >= workers) break;
    bootSimulator(sim.udid);
    if (opts.appPath) {
      try { installApp(sim.udid, opts.appPath); } catch { /* may already be installed */ }
    }
    allUdids.push(sim.udid);
    freshUdids.add(sim.udid);
  }

  if (allUdids.length >= workers) {
    return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids };
  }

  // Phase 2: clone the source simulator to create new instances.
  // simctl clone requires a shutdown source. Prefer a shutdown one; if all
  // matching sims are booted, temporarily shut one down for cloning.
  const refreshed = listSimulators();
  const runtimeMatch = (s: SimulatorInfo) =>
    s.name === simulatorName && (!primaryRuntime || s.runtime === primaryRuntime);
  let source = refreshed.find((s) => runtimeMatch(s) && s.state === 'Shutdown');
  let shutdownForClone = false;
  if (!source) {
    // All matching sims are booted — shut one down temporarily to use as clone source.
    // Never shut down sims in existingUdids — they may have an active agent session.
    const candidate = refreshed.find((s) => runtimeMatch(s) && !existingSet.has(s.udid));
    if (candidate && candidate.state === 'Booted') {
      shutdownSimulator(candidate.udid);
      waitForSimulatorState(candidate.udid, 'Shutdown', 10_000);
      source = candidate;
      shutdownForClone = true;
      const idx = allUdids.indexOf(candidate.udid);
      if (idx >= 0) allUdids.splice(idx, 1);
    }
  }

  if (!source) {
    // No shutdown simulator available for cloning (the only matching sim is
    // in active use). Create new simulators from scratch using the primary's
    // device type and runtime — this doesn't require a shutdown source.
    if (primarySim) {
      while (allUdids.length < workers) {
        const createIndex = allUdids.length;
        const createName = `${simulatorName} (Pilot Worker ${createIndex})`;
        try {
          const newUdid = createSimulator(createName, primarySim.deviceType, primarySim.runtime);
          bootSimulator(newUdid);
          if (opts.appPath) {
            try { installApp(newUdid, opts.appPath); } catch { /* worker will retry */ }
          }
          allUdids.push(newUdid);
          clonedSimulators.push({ udid: newUdid, name: createName, cloned: true });
          freshUdids.add(newUdid);
        } catch (err) {
          process.stderr.write(
            `Failed to create simulator for worker ${createIndex}: ${err instanceof Error ? err.message : err}\n`,
          );
          break;
        }
      }
    }
  } else {
    try {
      while (allUdids.length < workers) {
        const cloneIndex = allUdids.length;
        const cloneName = `${simulatorName} (Pilot Worker ${cloneIndex})`;
        try {
          const newUdid = cloneSimulator(source.udid, cloneName);
          bootSimulator(newUdid);
          if (opts.appPath) {
            try { installApp(newUdid, opts.appPath); } catch { /* worker will retry */ }
          }
          allUdids.push(newUdid);
          clonedSimulators.push({ udid: newUdid, name: cloneName, cloned: true });
          freshUdids.add(newUdid);
        } catch (err) {
          process.stderr.write(
            `Failed to clone simulator for worker ${cloneIndex}: ${err instanceof Error ? err.message : err}\n`,
          );
          break;
        }
      }
    } finally {
      // Re-boot the source if we shut it down for cloning, and re-add to pool
      if (shutdownForClone) {
        bootSimulator(source.udid);
        if (!allUdids.includes(source.udid)) {
          allUdids.unshift(source.udid);
        }
      }
    }
  }

  // Record newly cloned sims in the manifest for reuse by future runs
  const newlyCloned = clonedSimulators.filter((c) => freshUdids.has(c.udid));
  if (newlyCloned.length > 0) {
    recordClonedSimulators(newlyCloned, simulatorName);
  }

  return { allUdids: allUdids.slice(0, workers), clonedSimulators, freshUdids };
}
