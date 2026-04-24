/**
 * `tapsmith doctor` — system health check for Tapsmith dependencies.
 *
 * Runs a non-interactive checklist of core, platform-specific, and network
 * capture prerequisites. Each check is wrapped in try/catch so one failure
 * doesn't prevent subsequent checks from running.
 *
 * Exit code 0 when all checks pass (warnings are OK), 1 when any hard error.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findDaemonBin } from './daemon-bin.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';

// ─── ANSI helpers ───

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;

// ─── Check result tracking ───

type CheckStatus = 'pass' | 'warn' | 'error';

interface CheckEntry {
  status: CheckStatus;
  label: string;
}

type CheckList = CheckEntry[];

function pass(checks: CheckList, label: string): void {
  checks.push({ status: 'pass', label });
  console.log(`  ${green('✓')} ${label}`);
}

function warn(checks: CheckList, label: string): void {
  checks.push({ status: 'warn', label });
  console.log(`  ${yellow('⚠')} ${label}`);
}

function fail(checks: CheckList, label: string): void {
  checks.push({ status: 'error', label });
  console.log(`  ${red('✗')} ${label}`);
}

// ─── Individual checks ───

function checkNodeVersion(checks: CheckList): void {
  try {
    const version = process.versions.node;
    const major = parseInt(version.split('.')[0], 10);
    if (major >= 18) {
      pass(checks, `Node.js ${version}`);
    } else {
      fail(checks, `Node.js ${version} — requires >= 18`);
    }
  } catch {
    fail(checks, 'Node.js version check failed');
  }
}

function checkDaemonBin(checks: CheckList): void {
  try {
    const bin = findDaemonBin();
    pass(checks, `Tapsmith daemon found ${dim(`(${bin})`)}`);
  } catch {
    fail(checks, 'Tapsmith daemon not found — try reinstalling: npm install tapsmith');
  }
}

function checkConfigFile(checks: CheckList): void {
  try {
    const cwd = process.cwd();
    const tsConfig = path.join(cwd, 'tapsmith.config.ts');
    const mjsConfig = path.join(cwd, 'tapsmith.config.mjs');
    if (fs.existsSync(tsConfig)) {
      pass(checks, `Config file found ${dim(`(tapsmith.config.ts)`)}`);
    } else if (fs.existsSync(mjsConfig)) {
      pass(checks, `Config file found ${dim(`(tapsmith.config.mjs)`)}`);
    } else {
      warn(checks, 'No tapsmith.config.ts found in current directory');
    }
  } catch {
    warn(checks, 'Could not check for config file');
  }
}

// ─── Android checks ───

function checkAdb(checks: CheckList): boolean {
  try {
    const versionOutput = execFileSync('adb', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const versionMatch = versionOutput.match(/Version\s+([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    pass(checks, `ADB ${version}`);
    return true;
  } catch {
    fail(checks, 'ADB not found on PATH');
    return false;
  }
}

function checkAndroidHome(checks: CheckList): void {
  try {
    const androidHome = process.env.ANDROID_HOME;
    if (androidHome) {
      pass(checks, `ANDROID_HOME ${dim(androidHome)}`);
    } else {
      warn(checks, 'ANDROID_HOME not set');
    }
  } catch {
    warn(checks, 'Could not check ANDROID_HOME');
  }
}

function checkConnectedDevices(checks: CheckList): void {
  try {
    const output = execFileSync('adb', ['devices'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = output.trim().split('\n').slice(1);
    const devices = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes('\tdevice'));
    if (devices.length > 0) {
      const serials = devices.map((d) => d.split('\t')[0]).join(', ');
      pass(checks, `${devices.length} device${devices.length === 1 ? '' : 's'} connected ${dim(`(${serials})`)}`);
    } else {
      warn(checks, 'No Android devices connected');
    }
  } catch {
    warn(checks, 'Could not list Android devices');
  }
}

function checkAgentApks(checks: CheckList): void {
  try {
    const apk = findAgentApk();
    const testApk = findAgentTestApk();
    if (apk && testApk) {
      const isBundled = apk.includes('agents/android');
      const source = isBundled ? 'bundled' : 'monorepo build';
      pass(checks, `Android agent ${dim(`(${source})`)}`);
    } else if (apk || testApk) {
      warn(checks, 'Android agent incomplete — rebuild with `./gradlew assembleDebug assembleDebugAndroidTest` in agent/');
    } else {
      warn(checks, 'Android agent not found — build with `./gradlew assembleDebug` in agent/');
    }
  } catch {
    warn(checks, 'Could not locate Android agent');
  }
}

function checkAppApk(checks: CheckList, config: { apk?: string; rootDir?: string } | undefined): void {
  if (!config?.apk) return;
  try {
    const resolvedApk = path.resolve(config.rootDir ?? process.cwd(), config.apk);
    if (fs.existsSync(resolvedApk)) {
      pass(checks, `App APK exists ${dim(`(${path.basename(resolvedApk)})`)}`);
    } else {
      fail(checks, `App APK not found at ${resolvedApk}`);
    }
  } catch {
    warn(checks, 'Could not check app APK path');
  }
}

// ─── iOS checks ───

function checkXcode(checks: CheckList): void {
  try {
    const output = execFileSync('xcodebuild', ['-version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const versionMatch = output.match(/Xcode\s+(\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    pass(checks, `Xcode ${version}`);
  } catch {
    fail(checks, 'Xcode not installed — install from the Mac App Store');
  }
}

function checkSimctl(checks: CheckList): void {
  try {
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pass(checks, 'iOS simulators available');
  } catch {
    fail(checks, 'xcrun simctl not available — install Xcode command-line tools');
  }
}

async function checkSimulatorXctestrun(checks: CheckList): Promise<void> {
  try {
    const { findSimulatorXctestrun } = await import('./ios-device-resolve.js');
    const found = findSimulatorXctestrun();
    if (found) {
      pass(checks, `Simulator xctestrun found ${dim(`(${path.basename(found)})`)}`);
    } else {
      warn(checks, 'No simulator xctestrun found — build with xcodebuild or install @tapsmith/agent-ios-simulator-arm64');
    }
  } catch {
    warn(checks, 'Could not check for simulator xctestrun');
  }
}

// ─── Network Capture checks ───

function checkMitmCa(checks: CheckList): void {
  try {
    const caPath = path.join(os.homedir(), '.tapsmith', 'ca.pem');
    if (fs.existsSync(caPath)) {
      pass(checks, `MITM CA exists ${dim(`(~/.tapsmith/ca.pem)`)}`);
    } else {
      warn(checks, 'MITM CA not found at ~/.tapsmith/ca.pem — run `tapsmith setup-ios` to generate');
    }
  } catch {
    warn(checks, 'Could not check for MITM CA');
  }
}

function checkMitmproxy(checks: CheckList): void {
  try {
    execFileSync('brew', ['list', 'mitmproxy'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pass(checks, 'mitmproxy installed');
  } catch {
    warn(checks, 'mitmproxy not installed — install with `brew install mitmproxy`');
  }
}

function checkNetworkExtension(checks: CheckList): void {
  try {
    const output = execFileSync('systemextensionsctl', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bundleId = 'org.mitmproxy.macos-redirector.network-extension';
    if (output.includes(bundleId) && output.includes('[activated enabled]')) {
      pass(checks, 'Network Extension enabled');
    } else if (output.includes(bundleId)) {
      warn(checks, 'Network Extension found but not fully enabled — check System Settings > Privacy & Security');
    } else {
      warn(checks, 'Network Extension not installed — required for iOS network capture');
    }
  } catch {
    warn(checks, 'Could not check Network Extension status');
  }
}

// ─── Main entry point ───

export async function runDoctor(): Promise<void> {
  const checks: CheckList = [];

  console.log();
  console.log(bold('Tapsmith Doctor'));

  // Try to load config for APK path check
  let config: { apk?: string; rootDir?: string } | undefined;
  try {
    const { loadConfig } = await import('./config.js');
    config = await loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Could not find') || msg.includes('ENOENT')) {
      // No config file — fine, checkConfigFile() will report it
    } else {
      console.log(`  ${yellow('⚠')} Config file has errors: ${msg}`);
    }
  }

  // Detect whether Android platform tools are available or config references an APK
  const hasAndroid = (() => {
    try {
      execFileSync('adb', ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  })() || !!config?.apk;

  // ─── Core ───
  console.log();
  console.log(`  ${bold('Core')}`);
  checkNodeVersion(checks);
  checkDaemonBin(checks);
  checkConfigFile(checks);

  // ─── Android ───
  if (hasAndroid) {
    console.log();
    console.log(`  ${bold('Android')}`);
    const adbOk = checkAdb(checks);
    checkAndroidHome(checks);
    if (adbOk) {
      checkConnectedDevices(checks);
    }
    checkAgentApks(checks);
    checkAppApk(checks, config);
  }

  // ─── iOS ───
  if (process.platform === 'darwin') {
    console.log();
    console.log(`  ${bold('iOS')}`);
    checkXcode(checks);
    checkSimctl(checks);
    await checkSimulatorXctestrun(checks);
  }

  // ─── Network Capture ───
  console.log();
  console.log(`  ${bold('Network Capture')}`);
  checkMitmCa(checks);
  if (process.platform === 'darwin') {
    checkMitmproxy(checks);
    checkNetworkExtension(checks);
  }

  // ─── Summary ───
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const errors = checks.filter((c) => c.status === 'error').length;

  console.log();
  const parts: string[] = [];
  parts.push(green(`${passed} check${passed === 1 ? '' : 's'} passed`));
  if (warnings > 0) parts.push(yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`));
  if (errors > 0) parts.push(red(`${errors} error${errors === 1 ? '' : 's'}`));
  console.log(parts.join(', '));
  console.log();

  if (errors > 0) {
    process.exit(1);
  }
}
