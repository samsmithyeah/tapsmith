/**
 * Shared environment scanning for `tapsmith init` and `tapsmith doctor`.
 */

import { execFileSync } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import { scanAvdImageTags, type AvdImageInfo } from './avd-images.js';
import { resolveEmulatorBinary } from './emulator.js';

// ─── Helpers ───

export function tryExec(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

// ─── Environment scanning ───

export interface EnvScan {
  nodeVersion: string;
  daemonBin: string | undefined;
  agentApk: boolean;
  agentTestApk: boolean;
  adbVersion: string | undefined;
  androidHome: string | undefined;
  xcodeVersion: string | undefined;
  simulators: SimulatorInfo[];
  /** AVD names, in `emulator -list-avds` order (empty when the emulator binary is not found). */
  avds: string[];
  /** Each AVD's system image, for judging HTTPS capture (`avdCaptureSupport`). */
  avdImages: AvdImageInfo[];
  isMacOS: boolean;
}

export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSimctlDevicesJson(output: string): SimulatorInfo[] {
  const simulators: SimulatorInfo[] = [];
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return simulators;
  }

  const devices = isRecord(data) ? data['devices'] : undefined;
  if (!isRecord(devices)) return simulators;

  for (const [runtime, devs] of Object.entries(devices)) {
    if (!Array.isArray(devs)) continue;
    for (const device of devs) {
      if (!isRecord(device)) continue;
      const runtimeName = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, ' ');
      simulators.push({
        name: typeof device['name'] === 'string' ? device['name'] : '',
        udid: typeof device['udid'] === 'string' ? device['udid'] : '',
        state: typeof device['state'] === 'string' ? device['state'] : '',
        runtime: runtimeName,
      });
    }
  }
  return simulators;
}

export function scanEnvironment(): EnvScan {
  const isMacOS = process.platform === 'darwin';
  const nodeVersion = process.versions.node;

  let daemonBin: string | undefined;
  try {
    daemonBin = findDaemonBin();
  } catch {
    // not found
  }

  const agentApk = !!findAgentApk();
  const agentTestApk = !!findAgentTestApk();

  let adbVersion: string | undefined;
  const adbOut = tryExec('adb', ['--version']);
  if (adbOut) {
    const match = adbOut.match(/Version\s+([\d.]+)/);
    adbVersion = match?.[1] ?? 'installed';
  }

  const androidHome = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];

  let xcodeVersion: string | undefined;
  if (isMacOS) {
    const xcOut = tryExec('xcodebuild', ['-version']);
    if (xcOut) {
      const match = xcOut.match(/Xcode\s+([\d.]+)/);
      xcodeVersion = match?.[1] ?? 'installed';
    }
  }

  const simulators: SimulatorInfo[] = [];
  if (isMacOS) {
    const simOut = tryExec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    if (simOut) {
      simulators.push(...parseSimctlDevicesJson(simOut));
    }
  }

  let avds: string[] = [];
  const avdOut = tryExec(resolveEmulatorBinary().command, ['-list-avds']);
  if (avdOut) {
    avds = avdOut.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  const avdImages = scanAvdImageTags();

  return { nodeVersion, daemonBin, agentApk, agentTestApk, adbVersion, androidHome, xcodeVersion, simulators, avds, avdImages, isMacOS };
}

/**
 * What to do about an attached Android device adb cannot use, by its
 * `adb devices` state; undefined for a usable (`device`) or unknown state.
 * Shared by `list-devices`, `doctor` and the test-run paths' device errors
 * (`device-advice.ts`) so they all give the same advice.
 */
export function androidStateBlocker(state: string, serial: string): string | undefined {
  // adb surfaces "unauthorized" when the device hasn't accepted the RSA key
  // yet and "offline" when the connection is broken — or, for an emulator,
  // while it is still booting.
  if (state === 'unauthorized') return 'Accept the USB debugging prompt on the device';
  if (state === 'offline' && serial.startsWith('emulator-')) return 'Wait for the emulator to finish booting, or restart it if it stays offline';
  if (state === 'offline') return 'Reconnect cable or run `adb kill-server`';
  // Linux without a udev rule: "no permissions (user … not in the plugdev group …)".
  if (state.startsWith('no permissions')) {
    return 'Give your user USB access to the device: add a udev rule for it and join the plugdev group (https://developer.android.com/studio/run/device)';
  }
  return undefined;
}

/**
 * The fix for an Android device in any adb state but `device`: the specific
 * advice from {@link androidStateBlocker}, or a generic one for states it has
 * none for (`authorizing`, `recovery`, …). Shared by `list-devices` and
 * `doctor`.
 */
export function androidUnusableDeviceFix(state: string, serial: string): string {
  return androidStateBlocker(state, serial)
    ?? `${serial} is "${state}" to adb: reconnect it, or run \`adb kill-server\` and try again`;
}
