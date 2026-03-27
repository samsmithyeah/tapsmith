/**
 * iOS simulator management utilities.
 *
 * Parallel to `emulator.ts` for Android, this module wraps `xcrun simctl`
 * commands for discovering, booting, and managing iOS simulators.
 */

import { execFileSync } from 'node:child_process';

export interface SimulatorInfo {
  udid: string
  name: string
  state: string
  isAvailable: boolean
  runtime: string
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
 * List booted iOS simulators.
 */
export function listBootedSimulators(): SimulatorInfo[] {
  return listSimulators().filter((s) => s.state === 'Booted');
}

/**
 * Boot a simulator by UDID.
 */
export function bootSimulator(udid: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'boot', udid], {
      timeout: 30_000,
      stdio: 'ignore',
    });
  } catch (err) {
    // "Unable to boot device in current state: Booted" is not an error
    const msg = (err as Error).message ?? '';
    if (!msg.includes('Booted')) {
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
 * Install an app bundle on a simulator.
 */
export function installApp(udid: string, appPath: string): void {
  execFileSync('xcrun', ['simctl', 'install', udid, appPath], {
    timeout: 60_000,
    stdio: 'ignore',
  });
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
