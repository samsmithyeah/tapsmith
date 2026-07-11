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

type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckEntry {
  id: string;
  status: CheckStatus;
  label: string;
  detail?: string;
  fix?: string;
}

export type CheckList = CheckEntry[];

export interface DoctorInventory {
  avds: string[];
  simulators: Array<{ name: string; udid: string; state: string; runtime: string }>;
  connectedDevices: Array<{ serial: string; state: string }>;
}

export interface DoctorJson {
  ok: boolean;
  checks: CheckEntry[];
  inventory: DoctorInventory;
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

function plainCheck(check: CheckEntry): CheckEntry {
  const plain: CheckEntry = {
    ...check,
    label: stripAnsi(check.label),
  };
  if (check.detail !== undefined) plain.detail = stripAnsi(check.detail);
  if (check.fix !== undefined) plain.fix = stripAnsi(check.fix);
  return plain;
}

export function buildDoctorJson(checks: CheckList, inventory: DoctorInventory): DoctorJson {
  return {
    ok: !checks.some((c) => c.status === 'fail'),
    checks: checks.map(plainCheck),
    inventory,
  };
}

// Bundles the accumulating check list with whether to echo each check to
// stdout (suppressed in --json mode so stdout stays machine-clean). Passed
// explicitly rather than via module state so runDoctor is reentrant —
// concurrent or sequential invocations never share print state.
interface Reporter {
  checks: CheckList;
  print: boolean;
}

function pass(report: Reporter, id: string, label: string): void {
  report.checks.push({ status: 'pass', id, label });
  if (report.print) console.log(`  ${green('✓')} ${label}`);
}

function warn(report: Reporter, id: string, label: string, fix?: string): void {
  report.checks.push({ status: 'warn', id, label, fix });
  if (report.print) console.log(`  ${yellow('⚠')} ${label}`);
}

function fail(report: Reporter, id: string, label: string, fix?: string): void {
  report.checks.push({ status: 'fail', id, label, fix });
  if (report.print) console.log(`  ${red('✗')} ${label}`);
}

// ─── Individual checks ───

export function isSupportedNodeVersion(version: string): boolean {
  const major = parseInt(version.split('.')[0], 10);
  return major >= 22;
}

function checkNodeVersion(report: Reporter): void {
  try {
    const version = process.versions.node;
    if (isSupportedNodeVersion(version)) {
      pass(report, 'node', `Node.js ${version}`);
    } else {
      fail(report, 'node', `Node.js ${version} — requires >= 22`, 'Install Node.js 22 or newer (https://nodejs.org)');
    }
  } catch {
    fail(report, 'node', 'Node.js version check failed', 'Install Node.js 22 or newer (https://nodejs.org)');
  }
}

function checkDaemonBin(report: Reporter): void {
  try {
    const bin = findDaemonBin();
    pass(report, 'daemon', `Tapsmith daemon found ${dim(`(${bin})`)}`);
  } catch {
    fail(report, 'daemon', 'Tapsmith daemon not found — try reinstalling: npm install tapsmith', 'Reinstall tapsmith: npm install tapsmith (or set TAPSMITH_DAEMON_BIN)');
  }
}

function checkConfigFile(report: Reporter): void {
  try {
    const cwd = process.cwd();
    const tsConfig = path.join(cwd, 'tapsmith.config.ts');
    const mjsConfig = path.join(cwd, 'tapsmith.config.mjs');
    if (fs.existsSync(tsConfig)) {
      pass(report, 'config', `Config file found ${dim(`(tapsmith.config.ts)`)}`);
    } else if (fs.existsSync(mjsConfig)) {
      pass(report, 'config', `Config file found ${dim(`(tapsmith.config.mjs)`)}`);
    } else {
      warn(report, 'config', 'No tapsmith.config.ts found in current directory', 'Run: npx tapsmith init --yes (or npx tapsmith init for the wizard)');
    }
  } catch {
    warn(report, 'config', 'Could not check for config file');
  }
}

// ─── Android checks ───

function checkAdb(report: Reporter): boolean {
  try {
    const versionOutput = execFileSync('adb', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const versionMatch = versionOutput.match(/Version\s+([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    pass(report, 'adb', `ADB ${version}`);
    return true;
  } catch {
    fail(report, 'adb', 'ADB not found on PATH', 'Install Android platform-tools and ensure adb is on PATH');
    return false;
  }
}

function checkAndroidHome(report: Reporter): void {
  try {
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (androidHome) {
      pass(report, 'android-home', `ANDROID_HOME ${dim(androidHome)}`);
    } else {
      warn(report, 'android-home', 'ANDROID_HOME not set', 'Set ANDROID_HOME to your Android SDK location');
    }
  } catch {
    warn(report, 'android-home', 'Could not check ANDROID_HOME');
  }
}

function checkConnectedDevices(report: Reporter): void {
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
      pass(report, 'android-devices', `${devices.length} device${devices.length === 1 ? '' : 's'} connected ${dim(`(${serials})`)}`);
    } else {
      warn(report, 'android-devices', 'No Android devices connected', 'Start an emulator or connect a device with USB debugging enabled');
    }
  } catch {
    warn(report, 'android-devices', 'Could not list Android devices');
  }
}

function checkAgentApks(report: Reporter): void {
  try {
    const apk = findAgentApk();
    const testApk = findAgentTestApk();
    if (apk && testApk) {
      pass(report, 'android-agent', `Android agent ${dim(`(${apk.includes(path.join('@tapsmith', 'agent-android')) ? '@tapsmith/agent-android' : 'monorepo build'})`)}`);
    } else if (apk || testApk) {
      warn(report, 'android-agent', 'Android agent incomplete — one APK found but not both', 'npm install @tapsmith/agent-android');
    } else {
      warn(report, 'android-agent', 'Android agent not found — install @tapsmith/agent-android or build from source in agent/', 'npm install @tapsmith/agent-android');
    }
  } catch {
    warn(report, 'android-agent', 'Could not locate Android agent');
  }
}

function checkAppApk(report: Reporter, config: { apk?: string; rootDir?: string } | undefined): void {
  if (!config?.apk) return;
  try {
    const resolvedApk = path.resolve(config.rootDir ?? process.cwd(), config.apk);
    if (fs.existsSync(resolvedApk)) {
      pass(report, 'app-apk', `App APK exists ${dim(`(${path.basename(resolvedApk)})`)}`);
    } else {
      fail(report, 'app-apk', `App APK not found at ${resolvedApk}`, 'Build your app APK or fix the apk path in tapsmith.config.ts');
    }
  } catch {
    warn(report, 'app-apk', 'Could not check app APK path');
  }
}

// ─── AVD system image check ───

/**
 * Extract the system image tag (`tag.id`) from an AVD's `config.ini`.
 * `google_apis_playstore` images are production builds without `adb root`,
 * so Tapsmith cannot install its CA cert or iptables redirect on them —
 * HTTPS traffic is never captured.
 */
export function parseAvdImageTag(configIni: string): string | undefined {
  const match = configIni.match(/^tag\.id\s*=\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

export interface AvdImageInfo {
  name: string;
  tagId?: string;
}

/**
 * Scan the AVD home directory (`$ANDROID_AVD_HOME` or `~/.android/avd`) and
 * return each AVD with its system image tag. Each `<name>.ini` points at the
 * `.avd` data directory via its `path=` key; the tag lives in that
 * directory's `config.ini`.
 */
export function scanAvdImageTags(avdHome?: string): AvdImageInfo[] {
  const home = avdHome ?? process.env.ANDROID_AVD_HOME ?? path.join(os.homedir(), '.android', 'avd');
  let entries: string[];
  try {
    entries = fs.readdirSync(home);
  } catch {
    return [];
  }

  const avds: AvdImageInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ini')) continue;
    const name = entry.slice(0, -'.ini'.length);
    try {
      const ini = fs.readFileSync(path.join(home, entry), 'utf-8');
      const pathMatch = ini.match(/^path\s*=\s*(.+)$/m);
      const avdDir = pathMatch ? pathMatch[1].trim() : path.join(home, `${name}.avd`);
      const configIni = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf-8');
      avds.push({ name, tagId: parseAvdImageTag(configIni) });
    } catch {
      avds.push({ name });
    }
  }
  return avds;
}

export interface AvdImageSummary {
  status: 'pass' | 'warn';
  label: string;
  fix?: string;
}

/**
 * Judge the scanned AVDs for HTTPS-capture capability.
 *
 * When the tapsmith config names an `avd`, that AVD is what test runs will
 * actually boot, so the verdict follows it: a capture-capable configured AVD
 * passes even if unrelated Play-image AVDs exist on the machine (they're
 * mentioned as context, not warned about). Without a configured AVD, any
 * Play-image AVD produces a warning since Tapsmith may pick up a matching
 * running emulator.
 */
export function summarizeAvdImages(avds: AvdImageInfo[], configuredAvd?: string | string[]): AvdImageSummary | undefined {
  if (avds.length === 0) return undefined;

  const playStore = avds.filter((a) => a.tagId === 'google_apis_playstore');
  const unreadable = avds.filter((a) => a.tagId === undefined);
  const fix = 'Recreate with a Google APIs image: npx tapsmith create-avd';

  const configuredNames = (Array.isArray(configuredAvd) ? configuredAvd : configuredAvd ? [configuredAvd] : [])
    .filter((name, i, arr) => arr.indexOf(name) === i);
  if (configuredNames.length > 0) {
    const missing = configuredNames.filter((name) => !avds.some((a) => a.name === name));
    const configured = avds.filter((a) => configuredNames.includes(a.name));
    const issues: string[] = [
      ...missing.map((name) => `Configured AVD ${name} not found on this machine`),
      ...configured.filter((a) => a.tagId === 'google_apis_playstore')
        .map((a) => `Configured AVD ${a.name} uses a Google Play system image — no adb root, so HTTPS traffic will not be captured`),
      ...configured.filter((a) => a.tagId === undefined)
        .map((a) => `Could not read the system image tag of configured AVD ${a.name}`),
    ];
    if (issues.length > 0) {
      const onlyMissing = issues.length === missing.length;
      return {
        status: 'warn',
        label: issues.join('; '),
        fix: onlyMissing
          ? `Create it: npx tapsmith create-avd --name ${missing[0]}`
          : fix,
      };
    }
    const otherPlay = playStore.filter((a) => !configuredNames.includes(a.name));
    const context = otherPlay.length > 0
      ? `; ${otherPlay.length} other AVD${otherPlay.length === 1 ? '' : 's'} on this machine use${otherPlay.length === 1 ? 's' : ''} a Play image (${otherPlay.map((a) => a.name).join(', ')})`
      : '';
    const tags = configured.map((a) => a.tagId).filter((t, i, arr) => arr.indexOf(t) === i).join(', ');
    return {
      status: 'pass',
      label: `Configured AVD${configuredNames.length === 1 ? '' : 's'} ${configuredNames.join(', ')} support${configuredNames.length === 1 ? 's' : ''} HTTPS capture ${dim(`(${tags}${context})`)}`,
    };
  }

  if (playStore.length > 0) {
    const capable = avds.length - playStore.length - unreadable.length;
    const context = capable > 0 ? `; ${capable} other AVD${capable === 1 ? ' is' : 's are'} capture-capable` : '';
    return {
      status: 'warn',
      label: `${playStore.length} of ${avds.length} AVD${avds.length === 1 ? '' : 's'} use${playStore.length === 1 ? 's' : ''} a Google Play system image — no adb root, so HTTPS traffic will not be captured ${dim(`(${playStore.map((a) => a.name).join(', ')}${context})`)}`,
      fix,
    };
  }

  // Don't silently vouch for AVDs whose config.ini couldn't be read.
  const detail = unreadable.length > 0
    ? `${avds.length - unreadable.length} of ${avds.length} AVDs verified — could not read: ${unreadable.map((a) => a.name).join(', ')}`
    : `${avds.length} AVD${avds.length === 1 ? '' : 's'} checked`;
  return { status: 'pass', label: `AVD system images support HTTPS capture ${dim(`(${detail})`)}` };
}

function checkAvdImages(report: Reporter, configuredAvd?: string | string[]): void {
  try {
    const summary = summarizeAvdImages(scanAvdImageTags(), configuredAvd);
    if (!summary) return;
    if (summary.status === 'pass') {
      pass(report, 'avd-images', summary.label);
    } else {
      warn(report, 'avd-images', summary.label, summary.fix);
    }
  } catch {
    warn(report, 'avd-images', 'Could not check AVD system images');
  }
}

// ─── iOS checks ───

function checkXcode(report: Reporter): void {
  try {
    const output = execFileSync('xcodebuild', ['-version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const versionMatch = output.match(/Xcode\s+(\S+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    pass(report, 'xcode', `Xcode ${version}`);
  } catch {
    fail(report, 'xcode', 'Xcode not installed — install from the Mac App Store', 'Install Xcode from the Mac App Store');
  }
}

function checkSimctl(report: Reporter): void {
  try {
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pass(report, 'simctl', 'iOS simulators available');
  } catch {
    fail(report, 'simctl', 'xcrun simctl not available — install Xcode command-line tools', 'Run: xcode-select --install');
  }
}

async function checkSimulatorXctestrun(report: Reporter): Promise<void> {
  try {
    const { findSimulatorXctestrun, extractSdkVersion, getInstalledSimulatorSdkVersion } = await import('./ios-device-resolve.js');
    const found = findSimulatorXctestrun();
    if (!found) {
      warn(report, 'ios-sim-agent', 'No simulator xctestrun found — build with xcodebuild or install @tapsmith/agent-ios-simulator-arm64', 'Run: npx tapsmith init --yes (builds it) or install @tapsmith/agent-ios-simulator-arm64');
      return;
    }

    const xctestrunSdk = extractSdkVersion(found);
    const sdkLabel = xctestrunSdk ? `, SDK ${xctestrunSdk}` : '';
    const source = found.includes(path.join('.tapsmith', 'ios-simulator-agent'))
      ? 'auto-build cache'
      : found.includes('agent-ios-simulator')
        ? '@tapsmith/agent-ios-simulator'
        : 'DerivedData';
    const installedSdk = getInstalledSimulatorSdkVersion();

    if (installedSdk && xctestrunSdk && xctestrunSdk !== installedSdk) {
      warn(report, 'ios-sim-agent', `Simulator xctestrun built for iOS ${xctestrunSdk} but installed SDK is ${installedSdk} — will auto-build on first test run`);
    } else {
      pass(report, 'ios-sim-agent', `Simulator xctestrun found ${dim(`(${source}${sdkLabel})`)}`);
    }
  } catch {
    warn(report, 'ios-sim-agent', 'Could not check for simulator xctestrun');
  }
}

// ─── Network Capture checks ───

function checkMitmCa(report: Reporter): void {
  try {
    const caPath = path.join(os.homedir(), '.tapsmith', 'ca.pem');
    if (fs.existsSync(caPath)) {
      pass(report, 'mitm-ca', `MITM CA exists ${dim(`(~/.tapsmith/ca.pem)`)}`);
    } else {
      warn(report, 'mitm-ca', 'MITM CA not found at ~/.tapsmith/ca.pem — run `tapsmith setup-ios` to generate', 'Run: npx tapsmith setup-ios');
    }
  } catch {
    warn(report, 'mitm-ca', 'Could not check for MITM CA');
  }
}

function checkMitmproxy(report: Reporter): void {
  try {
    execFileSync('brew', ['list', 'mitmproxy'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pass(report, 'mitmproxy', 'mitmproxy installed');
  } catch {
    warn(report, 'mitmproxy', 'mitmproxy not installed — install with `brew install mitmproxy`', 'Run: brew install mitmproxy');
  }
}

function checkNetworkExtension(report: Reporter): void {
  try {
    const output = execFileSync('systemextensionsctl', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bundleId = 'org.mitmproxy.macos-redirector.network-extension';
    if (output.includes(bundleId) && output.includes('[activated enabled]')) {
      pass(report, 'network-extension', 'Network Extension enabled');
    } else if (output.includes(bundleId)) {
      warn(report, 'network-extension', 'Network Extension found but not fully enabled — check System Settings > Privacy & Security', 'Run: npx tapsmith setup-ios, then enable in System Settings > Privacy & Security');
    } else {
      warn(report, 'network-extension', 'Network Extension not installed — required for iOS network capture', 'Run: npx tapsmith setup-ios, then enable in System Settings > Privacy & Security');
    }
  } catch {
    warn(report, 'network-extension', 'Could not check Network Extension status');
  }
}

// ─── Main entry point ───

/** Extract a `-c <path>` / `--config <path>` / `--config=<path>` flag. */
export function parseDoctorConfigFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-c' || arg === '--config') return argv[i + 1];
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return undefined;
}

export async function runDoctor(argv: string[] = []): Promise<void> {
  const jsonMode = argv.includes('--json');
  const printing = !jsonMode;
  const configFile = parseDoctorConfigFlag(argv);

  const checks: CheckList = [];
  const report: Reporter = { checks, print: printing };

  if (printing) {
    console.log();
    console.log(bold('Tapsmith Doctor'));
  }

  // Try to load config for the APK path and AVD image checks
  let config: { apk?: string; rootDir?: string; avd?: string; projects?: Array<{ use?: { avd?: string } }> } | undefined;
  try {
    const { loadConfig } = await import('./config.js');
    config = await loadConfig(undefined, configFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Could not find') || msg.includes('ENOENT')) {
      // No config file — fine, checkConfigFile() will report it
    } else {
      warn(report, 'config-load', `Config file has errors: ${msg}`, 'Fix the syntax error in tapsmith.config.ts');
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
  if (printing) {
    console.log();
    console.log(`  ${bold('Core')}`);
  }
  checkNodeVersion(report);
  checkDaemonBin(report);
  checkConfigFile(report);

  // ─── Android ───
  if (hasAndroid) {
    if (printing) {
      console.log();
      console.log(`  ${bold('Android')}`);
    }
    const adbOk = checkAdb(report);
    checkAndroidHome(report);
    if (adbOk) {
      checkConnectedDevices(report);
    }
    checkAgentApks(report);
    checkAppApk(report, config);
  }

  // ─── iOS ───
  if (process.platform === 'darwin') {
    if (printing) {
      console.log();
      console.log(`  ${bold('iOS')}`);
    }
    checkXcode(report);
    checkSimctl(report);
    await checkSimulatorXctestrun(report);
  }

  // ─── Network Capture ───
  if (printing) {
    console.log();
    console.log(`  ${bold('Network Capture')}`);
  }
  checkMitmCa(report);
  if (hasAndroid) {
    // AVDs can be configured top-level or per-project (projects[].use.avd).
    const configuredAvds = [
      ...(config?.avd ? [config.avd] : []),
      ...(config?.projects ?? []).map((p) => p.use?.avd).filter((avd): avd is string => !!avd),
    ];
    checkAvdImages(report, configuredAvds);
  }
  if (process.platform === 'darwin') {
    checkMitmproxy(report);
    checkNetworkExtension(report);
  }

  // ─── Summary ───
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const errors = checks.filter((c) => c.status === 'fail').length;

  if (printing) {
    console.log();
    const parts: string[] = [];
    parts.push(green(`${passed} check${passed === 1 ? '' : 's'} passed`));
    if (warnings > 0) parts.push(yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`));
    if (errors > 0) parts.push(red(`${errors} error${errors === 1 ? '' : 's'}`));
    console.log(parts.join(', '));
    console.log();
  }

  const { scanEnvironment, listConnectedAndroidDevices } = await import('./env-scan.js');
  const env = scanEnvironment();
  const inventory: DoctorInventory = {
    avds: env.avds,
    simulators: env.simulators,
    connectedDevices: listConnectedAndroidDevices(),
  };

  if (jsonMode) {
    console.log(JSON.stringify(buildDoctorJson(checks, inventory), null, 2));
  }

  if (checks.some((c) => c.status === 'fail')) {
    process.exitCode = 1;
  }
}
