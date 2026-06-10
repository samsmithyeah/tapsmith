/**
 * Shared environment scanning for `tapsmith init` and `tapsmith doctor`.
 */

import { execFileSync } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';

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
  avds: string[];
  isMacOS: boolean;
}

export interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
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
      try {
        const data = JSON.parse(simOut);
        const devices = data.devices as Record<string, Array<{ name: string; udid: string; state: string }>>;
        for (const [runtime, devs] of Object.entries(devices)) {
          for (const d of devs) {
            const runtimeName = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, ' ');
            simulators.push({ name: d.name, udid: d.udid, state: d.state, runtime: runtimeName });
          }
        }
      } catch {
        // parse failure
      }
    }
  }

  let avds: string[] = [];
  const avdOut = tryExec('emulator', ['-list-avds']);
  if (avdOut) {
    avds = avdOut.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  return { nodeVersion, daemonBin, agentApk, agentTestApk, adbVersion, androidHome, xcodeVersion, simulators, avds, isMacOS };
}

// ─── ADB device listing ───

export interface AdbDevice {
  serial: string;
  state: string;
}

export function parseAdbDevicesOutput(output: string): AdbDevice[] {
  return output
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes('\t'))
    .map((line) => {
      const [serial, state] = line.split('\t');
      return { serial, state };
    });
}

export function listConnectedAndroidDevices(): AdbDevice[] {
  const output = tryExec('adb', ['devices']);
  if (!output) return [];
  return parseAdbDevicesOutput(output);
}
