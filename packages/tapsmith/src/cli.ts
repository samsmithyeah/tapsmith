#!/usr/bin/env -S node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON

/**
 * CLI entry point for `npx tapsmith`.
 *
 * Commands:
 *   tapsmith test [files...]           Run tests
 *   tapsmith test --device <serial>    Target specific device
 *   tapsmith --version                 Print version
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, configPathOf, normalizeGrep, resolveDeviceStrategy, EXPLICIT_WORKERS, isExplicitWorkers, type TapsmithConfig } from './config.js';
import figlet from 'figlet';
import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults, markFileRetryFlakes, type TestResult, type SuiteResult } from './runner.js';
import { createReporters, ReporterDispatcher, type FullResult } from './reporter.js';
import { ensureSessionReady, launchConfiguredApp } from './session-preflight.js';
import type { PreparedState } from './app-reset.js';
import { installActionProgressPrinter } from './action-progress-renderer.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import { discoverTestFiles } from './test-file-discovery.js';
import {
  resolveTraceConfig,
  isNetworkTracingEnabled,
  networkHostsForPac,
  networkPassthroughHosts,
} from './trace/types.js';
import { resolveVideoConfig } from './video/types.js';
import { recordsOnlyOnRetry } from './trace/trace-mode.js';
import { spawn, execFileSync } from 'node:child_process';
import {
  clearOfflineEmulatorTransports,
  preserveEmulatorsForReuse,
  filterHealthyDevices,
  isPackageInstalled,
  listAdbDevices,
  waitForPackageIndexed,
  cleanupStaleEmulators,
  prefilterDevicesForStrategy,
  probeDeviceHealth,
  provisionEmulators,
  type DeviceHealthResult,
  type LaunchedEmulator,
  selectDevicesForStrategy,
  waitForDeviceStability,
  ensureAdbRoot,
} from './emulator.js';
import { AGENT_START_RETRY_DELAY_MS, isRecoverableInfrastructureError, isRetryableAgentStartError, retryDeviceSelection, serializeConfig } from './worker-protocol.js';
import { findPidsOnPort, freeStaleAgentPort } from './port-utils.js';
import { findDaemonBin } from './daemon-bin.js';
import {
  createUiLaunchSteps,
  UiLaunchProgress,
  type LaunchProgressSink,
} from './launch-progress.js';
import { killAgentRunnersForSimulators } from './ios-simulator.js';

// ─── ANSI helpers ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

let activeLaunchProgress: LaunchProgressSink | undefined;

function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function printTapsmithBanner(): void {
  console.log();
  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  console.log(banner.split('\n').map((line) => `${GREEN}${line}${RESET}`).join('\n'));
  console.log(dim(`v${getVersion()}`));
  console.log();
}

function argsAfterCommand(command: string): string[] {
  const idx = process.argv.indexOf(command);
  return idx >= 0 ? process.argv.slice(idx + 1) : [];
}

function commandArgsInclude(command: string, ...flags: string[]): boolean {
  const wanted = new Set(flags);
  return argsAfterCommand(command).some((arg) => wanted.has(arg));
}

/** Argv to forward to a subcommand's own parser, minus the tsx re-exec marker. */
function forwardedArgs(command: string): string[] {
  return argsAfterCommand(command).filter((a) => a !== '--__tsx-reexec');
}

function shouldPrintBannerForCommand(args: CliArgs): boolean {
  if (!args.command || args.version || args.help) return false;

  // Keep protocol and machine-readable surfaces byte-clean.
  if (args.command === 'mcp-server') return false;
  if (args.command === 'list-devices' && commandArgsInclude(args.command, '--json')) return false;
  if (args.command === 'doctor' && commandArgsInclude(args.command, '--json')) return false;
  if (args.command === 'verify' && commandArgsInclude(args.command, '--json')) return false;

  // These commands render command-specific help after the top-level parser
  // stops, so suppress the decorative banner when the user only asked for help.
  if (commandArgsInclude(args.command, '--help', '-h')) return false;

  // `init` already owns its banner because the wizard can be called directly
  // from tests and package consumers.
  if (args.command === 'init') return false;

  // Test mode prints its banner after TypeScript re-exec and test discovery,
  // immediately before the launch output.
  if (args.command === 'test') return false;

  return new Set([
    'show-trace',
    'show-report',
    'merge-reports',
    'list-devices',
    'setup-ios',
    'setup-ios-device',
    'build-ios-agent',
    'create-avd',
    'configure-ios-network',
    'refresh-ios-network',
    'verify-ios-network',
    'verify',
    'doctor',
  ]).has(args.command);
}

function warnSequentialUnhealthyDevices(devices: DeviceHealthResult[], progress?: LaunchProgressSink): void {
  for (const device of devices) {
    const message = `Skipping unhealthy device ${device.serial}: ${device.reason ?? 'unknown health check failure'}.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }
}

function warnSequentialSkippedDevices(
  devices: Array<{ serial: string; reason: string }>,
  progress?: LaunchProgressSink,
): void {
  for (const device of devices) {
    const message = `Skipping device ${device.serial}: ${device.reason}.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }
}

// ─── Version ───

function getVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─── TSX re-exec ───

/**
 * If test files are TypeScript and we're not already running under tsx,
 * re-exec the CLI using tsx as the loader. This allows `import from "tapsmith"`
 * and TypeScript syntax in test files.
 */
function needsTsx(testFiles: string[]): boolean {
  return testFiles.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

function reExecWithTsx(args: string[]): never {
  // Find tsx binary — first check local node_modules, then global
  const tapsmithPkgDir = path.resolve(import.meta.dirname, '..');
  const localTsx = path.join(tapsmithPkgDir, 'node_modules', '.bin', 'tsx');
  const tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';

  const cliPath = process.argv[1];
  const result = spawn(tsxBin, [cliPath, ...args, '--__tsx-reexec'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Tell Node to resolve "tapsmith" to our package
      NODE_PATH: path.join(tapsmithPkgDir, '..'),
    },
  });

  result.on('close', (code) => {
    process.exit(code ?? 1);
  });

  // Keep alive until child exits
  result.on('error', (err) => {
    console.error(red(`Failed to start tsx: ${err.message}`));
    console.error(dim('Install tsx: npm install -g tsx'));
    process.exit(1);
  });

  // Prevent the current process from continuing
  // This is a "never" return since we rely on the child process
  return undefined as never;
}

// ─── Device health check ───

/**
 * Verify the target device is responsive before running tests.
 * Attempts ADB restart recovery if unresponsive, exits the process if not recoverable.
 */
async function checkDeviceHealth(serial: string | undefined): Promise<void> {
  const target = serial ?? 'any connected device';

  if (serial) {
    const stable = await waitForDeviceStability(serial, 20_000, probeDeviceHealth);
    if (stable.healthy) return;

    if (stable.reason && !stable.reason.includes('ADB shell')) {
      console.error(red(`Device ${target} is not ready: ${stable.reason}.`));
      process.exit(1);
    }
  }

  // Quick ADB responsiveness check (5s timeout)
  const adbArgs = serial
    ? ['-s', serial, 'shell', 'echo', '__tapsmith_health_ok__']
    : ['shell', 'echo', '__tapsmith_health_ok__'];

  const tryAdb = (): boolean => {
    try {
      const result = execFileSync('adb', adbArgs, {
        timeout: 5_000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return result.trim().includes('__tapsmith_health_ok__');
    } catch {
      return false;
    }
  };

  if (tryAdb()) {
    return;
  }

  // Device is unresponsive — try ADB restart recovery
  console.log(yellow(`Device ${target} is unresponsive. Restarting ADB server...`));

  try {
    execFileSync('adb', ['kill-server'], { timeout: 5_000, stdio: 'ignore' });
  } catch {
    // kill-server can fail if daemon isn't running
  }
  // Give ADB time to fully shut down
  await new Promise((r) => setTimeout(r, 2_000));

  try {
    execFileSync('adb', ['start-server'], { timeout: 10_000, stdio: 'ignore' });
  } catch {
    console.error(red('Failed to restart ADB server.'));
    console.error(dim('  Check that Android SDK platform-tools are installed and on PATH.'));
    process.exit(1);
  }

  // Wait for device to come back
  await new Promise((r) => setTimeout(r, 3_000));

  if (!serial ? tryAdb() : (await waitForDeviceStability(serial, 20_000, probeDeviceHealth)).healthy) {
    console.log(dim('ADB recovered. Device is responsive.'));
    return;
  }

  // Still unresponsive — give the user actionable guidance
  console.error(red(`Device ${target} is not responding.`));
  console.error('');
  console.error('  Possible causes:');
  console.error(dim('    • Emulator crashed or froze — restart it'));
  console.error(dim('    • Multiple emulators competing for the same port'));
  console.error(dim('    • USB device disconnected'));
  console.error('');
  console.error('  Try:');
  console.error(dim('    $ adb kill-server && adb start-server'));
  console.error(dim('    $ adb devices -l'));
  if (serial?.startsWith('emulator')) {
    console.error(dim(`    $ adb -s ${serial} emu kill  # restart the emulator`));
  }
  process.exit(1);
}

// ─── Daemon management ───


/** Track the daemon process we spawned so we can kill it on exit. */
let spawnedDaemonProcess: ReturnType<typeof spawn> | undefined;

let sequentialFatalHandlersInstalled = false;
// The handler is registered once, but the active run context is refreshed on
// every install call so a crash always tears down the CURRENT run rather than a
// stale first-run closure (matters if main() runs more than once in a process).
let activeSequentialConfig: TapsmithConfig | undefined;
let activeSequentialDeviceGetter: (() => string | undefined) | undefined;

/**
 * Install process-wide handlers so a *crash* in single-worker (sequential) mode
 * still tears down its daemon and the daemon's xcodebuild XCUITest runner,
 * instead of orphaning them and loading the host (PILOT-230, sequential variant
 * of the dispatcher fix). Idempotent. The sim itself is left booted — sequential
 * mode reuses a named simulator rather than cloning, so deleting it would be
 * wrong; killing the runner is enough to stop it holding the host hot.
 */
function installSequentialFatalHandlers(
  config: TapsmithConfig,
  getActiveDevice?: () => string | undefined,
): void {
  activeSequentialConfig = config;
  activeSequentialDeviceGetter = getActiveDevice;

  if (sequentialFatalHandlersInstalled) return;
  sequentialFatalHandlersInstalled = true;
  let teardownDone = false;
  const runFatalTeardown = (label: string, err: unknown) => {
    if (teardownDone) return;
    teardownDone = true;
    process.stderr.write(`\n${DIM}Fatal ${label} — shutting down daemon and agent...${RESET}\n`);
    // Print the stack, not just the message — async crashes are undebuggable otherwise.
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    // Read the active config/device lazily at crash time: in heterogeneous
    // project runs the sequential device switches mid-run, so this reflects the
    // currently-active sim/device. Fall back to config.device before setup ran.
    const activeConfig = activeSequentialConfig ?? config;
    const activeDevice = activeSequentialDeviceGetter?.() ?? activeConfig.device;
    if (activeConfig.platform === 'ios' && activeDevice) {
      try { killAgentRunnersForSimulators([activeDevice]); } catch { /* best effort */ }
    }
    if (spawnedDaemonProcess) {
      try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    }
    setImmediate(() => process.exit(1));
  };
  process.on('uncaughtException', (err) => runFatalTeardown('error', err));
  process.on('unhandledRejection', (reason) => runFatalTeardown('rejection', reason));
}

async function ensureDaemonRunning(
  address: string,
  daemonBin?: string,
  platform?: string,
  progress?: LaunchProgressSink,
): Promise<TapsmithGrpcClient> {
  const port = address.split(':').pop() ?? '50051';
  progress?.start('daemon', `starting tapsmith-core on ${address}`);

  // When TAPSMITH_REUSE_DAEMON is set (e.g. from MCP server's tapsmith_run_tests),
  // connect to the existing daemon without killing it. This avoids destroying
  // a daemon owned by UI mode or another long-lived session.
  if (process.env.TAPSMITH_REUSE_DAEMON) {
    const client = new TapsmithGrpcClient(address);
    const alive = await client.waitForReady(5_000);
    if (alive) {
      const version = (await client.ping()).version;
      if (progress) progress.complete('daemon', `connected to existing tapsmith-core v${version}`);
      else console.log(dim(`Connected to existing Tapsmith daemon v${version}`));
      return client;
    }
    client.close();
    // Fall through to normal startup if no daemon is running
  }

  // Kill any stale daemon on this port so we always get a fresh one
  // with the correct --platform flag. The daemon starts in <1s so
  // the cost of a restart is negligible.
  try {
    const probe = new TapsmithGrpcClient(address);
    const alive = await probe.waitForReady(1_000);
    if (alive) {
      probe.close();
      // Find and kill the process listening on this port
      const pids = findPidsOnPort(port);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      // Brief wait for the port to free up
      await new Promise((r) => setTimeout(r, 500));
    } else {
      probe.close();
    }
  } catch {
    // No daemon running, nothing to kill
  }

  // Remove stale ADB port forwards whose HOST side is the default agent port
  // (18700). A previous Android instance may have left a forward that hijacks
  // traffic meant for the iOS XCUITest agent. Each line is "<serial> <local>
  // <remote>" — match `local === tcp:18700` exactly so we don't try to remove
  // forwards whose remote side happens to be 18700 but whose host port is not
  // (which would print "listener 'tcp:18700' not found").
  try {
    const fwdList = execFileSync('adb', ['forward', '--list'], { encoding: 'utf-8' }).trim();
    for (const line of fwdList.split('\n')) {
      const [serial, local] = line.split(/\s+/);
      if (!serial || local !== 'tcp:18700') continue;
      try {
        execFileSync('adb', ['-s', serial, 'forward', '--remove', 'tcp:18700']);
      } catch { /* already gone */ }
    }
  } catch {
    // ADB not available or no forwards — safe to ignore
  }

  // Free the agent host port from any leftover process (stale iOS TapsmithAgent
  // from a previous run, or a stuck tapsmith-core daemon). If we leave a stale
  // listener squatting on this port, the new daemon's `adb forward` is
  // shadowed by the stale socket and every command silently routes to the
  // wrong device — see freeStaleAgentPort for the full rationale.
  freeStaleAgentPort(18700, progress
    ? ({ port, pid }) => progress.update('daemon', {
      state: 'running',
      detail: `cleared stale agent port ${port} (pid ${pid})`,
    })
    : undefined);

  // Start a fresh daemon
  const resolvedBin = process.env.TAPSMITH_DAEMON_BIN ?? daemonBin ?? findDaemonBin();
  const daemonArgs = ['--port', port];
  if (platform) daemonArgs.push('--platform', platform);
  // Optional: redirect the spawned daemon's stdout/stderr to a file when
  // `TAPSMITH_DAEMON_LOG=<path>` is set. Useful for debugging daemon-side
  // behaviour (MITM proxy pre-start, `/tapsmith.pac` serves, agent startup)
  // without spinning up a separate daemon process. Off by default — the
  // env var is the only way to enable it.
  let daemonStdio: 'ignore' | ['ignore', number, number] = 'ignore';
  const daemonLogPath = process.env.TAPSMITH_DAEMON_LOG;
  if (daemonLogPath) {
    const fd = fs.openSync(daemonLogPath, 'a');
    daemonStdio = ['ignore', fd, fd];
  }
  const child = spawn(resolvedBin, daemonArgs, {
    stdio: daemonStdio,
  });
  child.on('error', () => {
    // Handled below via waitForReady timeout
  });
  child.unref();
  spawnedDaemonProcess = child;

  // Wait for daemon to be ready. First-exec of a freshly-downloaded unsigned
  // binary on a loaded CI runner can take ~30s before the listener binds
  // (macOS scans the binary), and grpc-js reconnect backoff grows ~1.6x per
  // attempt so a single 10s window can skip right past the moment the server
  // comes up. Retry in bounded windows up to 60s total, bailing early if the
  // daemon process exited (crash — no point waiting out the budget).
  const newClient = new TapsmithGrpcClient(address);
  let daemonExitCode: number | null | undefined;
  child.on('exit', (code) => {
    daemonExitCode = code ?? -1;
  });
  const connectDeadline = Date.now() + 60_000;
  let started = false;
  while (!started && Date.now() < connectDeadline && daemonExitCode === undefined) {
    started = await newClient.waitForReady(10_000);
  }
  if (!started) {
    const reason = daemonExitCode !== undefined
      ? `tapsmith-core exited with code ${daemonExitCode} during startup`
      : 'failed to start tapsmith-core (not ready after 60s)';
    progress?.fail('daemon', reason);
    console.error(red(`Failed to start Tapsmith daemon (${reason}). Is tapsmith-core installed?`));
    process.exit(1);
  }

  const version = (await newClient.ping()).version;
  if (progress) progress.complete('daemon', `connected to tapsmith-core v${version}`);
  else console.log(dim(`Connected to Tapsmith daemon v${version}`));
  return newClient;
}

// ─── Sequential per-project device setup ───

interface SequentialDeviceState {
  effectiveConfig: TapsmithConfig
  client: TapsmithGrpcClient
  device: Device
  deviceSerial: string
  launchedEmulators: LaunchedEmulator[]
  resolvedAgentApk?: string
  resolvedAgentTestApk?: string
  resolvedIosXctestrun?: string
  resolvedIosAppPath?: string
  signature: string
}

/**
 * Provision a device, start the daemon + agent, install + launch the app
 * for a given effective config. Used by sequential mode to set up the
 * initial device and to switch devices between projects whose
 * `deviceSignature` differs.
 */
async function setupSequentialDevice(
  cfg: TapsmithConfig,
  forceInstall: boolean,
  signature: string,
  progress?: LaunchProgressSink,
): Promise<SequentialDeviceState> {
  progress?.start('primary-device');
  const target = await ensureSequentialTargetDevice(cfg, progress);
  const launchedEmulators = target.launched;

  if (!target.selectedSerial) {
    progress?.fail('primary-device', 'no online device found');
    throw new Error(
      'No online devices found. Connect a device, start an emulator, or set `avd` in your config to auto-launch emulators.',
    );
  }

  cfg.device = target.selectedSerial;

  // CI=false (string) must be treated as falsy — some systems export CI=false
  // for "not in CI" which is truthy in JavaScript. Normalise once here.
  const isCI = !!(process.env.CI && process.env.CI !== 'false');

  // Pre-flight: verify device is responsive before doing anything slow (Android only).
  // Skip in CI — the workflow already verified boot_completed=1 and disabled animations.
  if (cfg.platform !== 'ios' && !isCI) {
    progress?.update('primary-device', { state: 'running', detail: `checking ${cfg.device}` });
    await checkDeviceHealth(cfg.device);
  }

  const client = await ensureDaemonRunning(cfg.daemonAddress, cfg.daemonBin, cfg.platform, progress);
  const device = new Device(client, cfg);

  // Tell the daemon whether this session intends to capture network traffic.
  // When false, the daemon skips every physical-iOS MITM/OCSP pre-arm code
  // path — the biggest single basic-track failure-surface reduction.
  // When true, we also pass the host-glob allowlist through so the daemon
  // can embed it in the PAC script served at `/tapsmith.pac`.
  const networkTracingEnabled = isNetworkTracingEnabled(cfg.trace);
  const pacNetworkHosts = networkHostsForPac(cfg.trace);
  const passthroughHosts = networkPassthroughHosts(cfg.trace);

  // Capture the narrowed serial — the retry closure would otherwise see the
  // possibly-undefined config field.
  const deviceSerial = cfg.device;
  try {
    progress?.update('primary-device', { state: 'running', detail: `selecting ${deviceSerial}` });
    await retryDeviceSelection(
      () => device.setDevice(deviceSerial, networkTracingEnabled, pacNetworkHosts, passthroughHosts),
      () => progress?.update('primary-device', { state: 'running', detail: `selection failed transiently, retrying ${deviceSerial}` }),
    );
    if (!progress) console.log(dim(`Using device: ${cfg.device}`));
  } catch (err) {
    progress?.fail('primary-device', `failed to select ${cfg.device}`);
    throw new Error(`Failed to set device: ${err}`);
  }

  const deviceJustLaunched = launchedEmulators.some((e) => e.serial === cfg.device);
  let skipAppReset = false;
  let pendingSimulatorInstall: Promise<void> | undefined;
  let pendingInstallError: unknown;

  // Determine whether this UDID targets a physical device or a simulator.
  // The branch drives every downstream decision in the iOS block: simctl for
  // simulators, devicectl for physical. It also controls whether we cache
  // the app path in startAgent for reinstall-based clearAppData.
  let targetIsPhysical = false;
  let resolvedIosAppPath: string | undefined;
  if (cfg.platform === 'ios') {
    const { isPhysicalDevice } = await import('./ios-devicectl.js');
    targetIsPhysical = cfg.device ? isPhysicalDevice(cfg.device) : false;
    resolvedIosAppPath = cfg.app ? path.resolve(cfg.rootDir, cfg.app) : undefined;
  }

  // Physical-iOS fast-fail checks. Fire BEFORE the 8-second installAppOnDevice
  // so the user gets an immediate, actionable error instead of a mid-test hang.
  if (cfg.platform === 'ios' && targetIsPhysical && cfg.device) {
    // Cert-trust probe. The devicectl launch is ~1s and pattern-matches
    // cleanly on "cert not trusted". Only helpful when the runner is
    // already installed (i.e. second-and-subsequent runs on the device)
    // — on a fresh device the probe returns 'runner-not-installed' and
    // we proceed silently so xcodebuild can install it via the normal
    // path and trigger the iOS trust prompt.
    const { probeCertTrust } = await import('./ios-trust-probe.js');
    const trust = await probeCertTrust(cfg.device);
    if (trust.state === 'untrusted') {
      progress?.fail('primary-device', 'developer certificate is not trusted');
      console.error();
      console.error('\x1b[31m✗ Tapsmith runner is installed but the developer certificate is not trusted.\x1b[0m');
      console.error();
      console.error('  On the phone, open \x1b[1mSettings → General → VPN & Device Management\x1b[0m,');
      console.error('  find \x1b[1mApple Development: <your name>\x1b[0m, and tap \x1b[1mTrust\x1b[0m.');
      console.error();
      console.error(dim('  Free Apple Developer accounts re-roll the profile every 7 days,'));
      console.error(dim('  so this step recurs weekly. Re-run `tapsmith build-ios-agent`'));
      console.error(dim('  before trusting so the profile on the phone matches.'));
      console.error();
      throw new Error('iOS developer certificate not trusted on device');
    }
    // Host-IP drift when tracing is enabled. A stale sidecar means the
    // mobileconfig points at the Mac's old LAN IP and the device will
    // silently fail to route through the proxy.
    if (isNetworkTracingEnabled(cfg.trace)) {
      const { checkHostIpDrift } = await import('./ios-host-ip-check.js');
      const drift = checkHostIpDrift(cfg.device);
      if (!drift.ok && drift.sidecarHostIp && drift.currentHostIp) {
        if (progress) {
          progress.note(
            `Host IP drift detected: profile points at ${drift.sidecarHostIp}, Mac is now ${drift.currentHostIp}.`,
          );
          progress.note(`Run \`tapsmith refresh-ios-network ${cfg.device}\` and reinstall the updated profile.`);
        } else {
          console.log();
          console.log('\x1b[33m⚠ Host IP drift detected.\x1b[0m');
          console.log(
            dim(`  Installed profile points at ${drift.sidecarHostIp}, Mac is now ${drift.currentHostIp}.`),
          );
          console.log(
            dim(`  Run \`tapsmith refresh-ios-network ${cfg.device}\` and reinstall the updated`),
          );
          console.log(dim('  profile on the device, otherwise traces will come back empty.'));
          console.log();
        }
      }
    }
  }

  if (cfg.platform === 'ios') {
    progress?.complete('primary-device', `${cfg.device} selected`);
    if (cfg.app && cfg.device) {
      progress?.start('app-install', `checking ${path.basename(cfg.app)}`);
      try {
        const resolvedApp = resolvedIosAppPath!;
        if (targetIsPhysical) {
          const { installAppOnDevice, isAppInstalledOnDevice } = await import('./ios-devicectl.js');
          const alreadyInstalled = !deviceJustLaunched
            && cfg.package
            && (await isAppInstalledOnDevice(cfg.device, cfg.package));
          if (alreadyInstalled && !forceInstall) {
            if (progress) progress.complete('app-install', `${cfg.package} already installed on device`);
            else console.log(dim(`App ${cfg.package} already installed on device, skipping install. Use --force-install to reinstall.`));
          } else {
            if (alreadyInstalled) {
              if (progress) progress.update('app-install', { state: 'running', detail: `reinstalling ${path.basename(resolvedApp)} on device` });
              else console.log(dim(`Reinstalling iOS app on device: ${path.basename(resolvedApp)}`));
            } else {
              progress?.update('app-install', { state: 'running', detail: `installing ${path.basename(resolvedApp)} on device` });
            }
            await installAppOnDevice(cfg.device, resolvedApp);
            skipAppReset = true;
            if (progress) progress.complete('app-install', `installed ${path.basename(resolvedApp)} on ${cfg.device}`);
            else console.log(dim(`Installed ${path.basename(resolvedApp)} on iOS device ${cfg.device}.`));
          }
        } else {
          const { installAppAsync, isAppInstalled, installedAppMatches } = await import('./ios-simulator.js');
          const alreadyInstalled = !deviceJustLaunched
            && cfg.package
            && isAppInstalled(cfg.device, cfg.package);
          // Skip only when the installed bundle is byte-identical — simulator
          // state can outlive a run (reused CI runner device sets, local app
          // rebuilds), and a presence-only skip silently tests a stale build.
          const upToDate = alreadyInstalled
            && installedAppMatches(cfg.device, cfg.package!, resolvedApp);
          if (upToDate && !forceInstall) {
            if (progress) progress.complete('app-install', `${cfg.package} already installed (matching build)`);
            else console.log(dim(`App ${cfg.package} already installed (matching build), skipping iOS app install. Use --force-install to reinstall.`));
          } else {
            if (alreadyInstalled) {
              if (progress) progress.update('app-install', { state: 'running', detail: `reinstalling ${path.basename(resolvedApp)} (installed build differs)` });
              else console.log(dim(`Reinstalling iOS app (installed build differs): ${path.basename(resolvedApp)}`));
            } else {
              progress?.update('app-install', { state: 'running', detail: `installing ${path.basename(resolvedApp)}` });
            }
            // Start install asynchronously — awaited before startAgent since
            // the iOS agent calls app.launch() immediately on startup.
            pendingSimulatorInstall = installAppAsync(cfg.device, resolvedApp)
              .catch((err: unknown) => { pendingInstallError = err; });
          }
        }
      } catch (err) {
        progress?.fail('app-install', `failed to install ${path.basename(resolvedIosAppPath ?? cfg.app)}`);
        throw new Error(`Failed to install iOS app: ${err}`);
      }
    } else {
      progress?.skip('app-install', 'no iOS app configured');
    }
    if (cfg.package && cfg.device && !pendingSimulatorInstall) {
      // For simulators we fire a best-effort simctl launch so the app is in
      // the foreground when the XCUITest runner attaches, which avoids a
      // brief black-screen flicker. Deferred when a simulator install is
      // running concurrently with agent startup. For physical devices we
      // skip this entirely: `simctl launch` doesn't work on real hardware.
      if (!targetIsPhysical) {
        try {
          execFileSync('xcrun', ['simctl', 'launch', cfg.device, cfg.package]);
          if (!progress) console.log(dim(`Launched ${cfg.package} on iOS simulator.`));
        } catch {
          // App may already be running
        }
      }
    }
  } else {
    if (isCI) {
      // Skip wake/unlock in CI — headless emulators have no lockscreen.
      progress?.complete('primary-device', `${cfg.device} selected`);
    } else {
      try {
        progress?.update('primary-device', { state: 'running', detail: `waking ${cfg.device}` });
        await device.wake();
        await device.unlock();
        if (progress) progress.complete('primary-device', `${cfg.device} awake and unlocked`);
        else console.log(dim('Device screen unlocked.'));
      } catch {
        // Non-fatal — device might already be awake/unlocked
        progress?.complete('primary-device', `${cfg.device} selected`);
      }
    }

    if (cfg.apk) {
      progress?.start('app-install', `checking ${path.basename(cfg.apk)}`);
      const isInstalled = !deviceJustLaunched
        && cfg.package
        && cfg.device
        && isPackageInstalled(cfg.device, cfg.package);

      if (isInstalled && !forceInstall) {
        if (progress) progress.complete('app-install', `${cfg.package} already installed`);
        else console.log(dim(`App ${cfg.package} already installed, skipping APK install. Use --force-install to reinstall.`));
      } else {
        const resolvedApk = path.resolve(cfg.rootDir, cfg.apk);
        try {
          if (isInstalled) {
            if (progress) progress.update('app-install', { state: 'running', detail: `reinstalling ${path.basename(resolvedApk)}` });
            else console.log(dim(`Reinstalling app APK: ${path.basename(resolvedApk)}`));
          } else {
            progress?.update('app-install', { state: 'running', detail: `installing ${path.basename(resolvedApk)}` });
          }
          await device.installApk(resolvedApk);
          skipAppReset = true;
          if (cfg.package && cfg.device) {
            await waitForPackageIndexed(cfg.device, cfg.package);
          }
          if (progress) progress.complete('app-install', `installed ${path.basename(resolvedApk)}`);
          else console.log(dim(`Installed app APK: ${path.basename(resolvedApk)}`));
        } catch (err) {
          progress?.fail('app-install', `failed to install ${path.basename(resolvedApk)}`);
          throw new Error(`Failed to install app APK: ${err}`);
        }
      }
    } else {
      progress?.skip('app-install', 'no Android APK configured');
    }
  }

  const traceConfig = resolveTraceConfig(cfg.trace);
  // PILOT-182: iOS network capture no longer needs sudo — the daemon uses
  // a macOS Network Extension redirector for per-simulator isolation. If
  // the legacy sudoers file is still on disk from an older Tapsmith version,
  // print a one-time deprecation notice.
  if (cfg.platform === 'ios') {
    const { notifyLegacySudoersIfPresent } = await import('./legacy-cleanup.js');
    notifyLegacySudoersIfPresent();
  }
  if (cfg.platform !== 'ios' && traceConfig.mode !== 'off' && traceConfig.network && cfg.device) {
    const restarted = ensureAdbRoot(cfg.device);
    if (restarted) {
      if (progress) progress.note('Enabled adb root for network capture.');
      else console.log(dim('Enabled adb root for network capture.'));
    }
  }

  const resolvedAgentApk = cfg.agentApk
    ? path.resolve(cfg.rootDir, cfg.agentApk)
    : findAgentApk();
  const resolvedAgentTestApk = cfg.agentTestApk
    ? path.resolve(cfg.rootDir, cfg.agentTestApk)
    : findAgentTestApk();
  // TAPSMITH_IOS_XCTESTRUN overrides auto-detection for configs that don't
  // set `iosXctestrun` — CI configs read this env var explicitly, and honoring
  // it uniformly means a locally built agent can be pinned for ANY config
  // instead of silently losing to the npm-package lookup.
  let resolvedIosXctestrun = cfg.iosXctestrun
    ? path.resolve(cfg.rootDir, cfg.iosXctestrun)
    : process.env.TAPSMITH_IOS_XCTESTRUN || undefined;
  // iOS xctestrun auto-detect: if the user didn't set `iosXctestrun`,
  // pick the newest built xctestrun for the target slice. Mirrors the way
  // `simulator: "iPhone 16"` is enough to pick a device without hand-rolling
  // JSON parsing in the config.
  //   - Physical devices: look under `<rootDir>/ios-agent/.build-device/…`
  //     (populated by `tapsmith build-ios-agent`).
  //   - Simulators: look under `~/Library/Developer/Xcode/DerivedData/TapsmithAgent-*`
  //     (populated by the simulator `xcodebuild build-for-testing` command).
  if (!resolvedIosXctestrun && cfg.platform === 'ios') {
    const { findDeviceXctestrun } =
      await import('./ios-device-resolve.js');
    if (targetIsPhysical) {
      const found = findDeviceXctestrun(cfg.rootDir);
      if (found) {
        resolvedIosXctestrun = found;
        const detail = `resolved ${path.relative(cfg.rootDir, found)}`;
        if (progress) progress.update('agent', { state: 'pending', detail });
        else console.log(dim(`Auto-detected iOS device xctestrun: ${path.relative(cfg.rootDir, found)}`));
      } else {
        progress?.fail('agent', 'no device xctestrun found');
        throw new Error(
          'No device xctestrun found under ios-agent/.build-device. ' +
            'Run `tapsmith build-ios-agent` first, or set `iosXctestrun` explicitly.',
        );
      }
    } else {
      const { ensureSimulatorAgent } = await import('./ios-simulator-build.js');
      try {
        const found = await ensureSimulatorAgent();
        resolvedIosXctestrun = found;
        if (progress) progress.update('agent', { state: 'pending', detail: `resolved ${path.basename(found)}` });
        else console.log(dim(`Auto-detected iOS simulator xctestrun: ${found}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progress?.fail('agent', 'failed to ensure simulator agent');
        throw new Error(msg);
      }
    }
  }

  // Physical-iOS provisioning-profile expiry warning, now that we have
  // the resolved xctestrun path. Three-point surfacing (here + build-ios-agent
  // tail + setup-ios-device preflight) so users hit the warning whichever
  // path they took to get to this point.
  if (cfg.platform === 'ios' && targetIsPhysical && resolvedIosXctestrun) {
    const { getProfileExpiryInfo, formatExpiryWarning } = await import('./ios-profile-expiry.js');
    const info = getProfileExpiryInfo(resolvedIosXctestrun);
    if (info) {
      const warning = formatExpiryWarning(info);
      if (warning) {
        if (progress) progress.note(warning);
        else console.log(`  \x1b[33m⚠\x1b[0m ${warning}`);
      }
    }
  }

  // The iOS agent calls app.launch() during testRunAgent(), so the target
  // app must be installed before the agent starts. Await any pending
  // simulator install now — this is a no-op when the app was already installed.
  if (pendingSimulatorInstall) {
    await pendingSimulatorInstall;
    if (pendingInstallError) {
      progress?.fail('app-install', `failed to install ${path.basename(resolvedIosAppPath ?? cfg.app!)}`);
      throw new Error(`Failed to install iOS app: ${pendingInstallError}`);
    }
    skipAppReset = true;
    if (progress) progress.complete('app-install', `installed ${path.basename(resolvedIosAppPath!)}`);
    else console.log(dim(`Installed ${path.basename(resolvedIosAppPath!)} on iOS simulator.`));
    if (cfg.package && cfg.device) {
      try {
        execFileSync('xcrun', ['simctl', 'launch', cfg.device, cfg.package]);
      } catch {
        // App may already be running
      }
    }
    pendingSimulatorInstall = undefined;
  }

  try {
    progress?.start(
      'agent',
      cfg.platform === 'ios'
        ? `starting iOS agent (${resolvedIosXctestrun ? path.basename(resolvedIosXctestrun) : 'xctestrun not set'})`
        : 'starting Android automation agent',
    );
    if (cfg.platform === 'ios') {
      if (!progress) console.log(dim(`Starting iOS agent (xctestrun: ${resolvedIosXctestrun ? 'set' : 'NOT SET'})`));
    }
    const startAgent = () => device.startAgent(
      cfg.package ?? '',
      resolvedAgentApk,
      resolvedAgentTestApk,
      resolvedIosXctestrun,
      cfg.platform === 'ios' ? resolvedIosAppPath : undefined,
      networkTracingEnabled,
    );
    try {
      await startAgent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRetryableAgentStartError(err)) {
        // Include the first attempt's error — without it a failed retry leaves
        // no trace of WHY attempt 1 died (the retry error may differ).
        if (progress) progress.update('agent', { state: 'running', detail: `agent startup failed, retrying once: ${msg}` });
        else console.error(`Agent startup failed, retrying once: ${msg}`);
        // Let a transient agent-connection drop clear before the retry — an
        // immediate re-attempt lands inside the same drop window (PILOT-282).
        await new Promise((resolve) => setTimeout(resolve, AGENT_START_RETRY_DELAY_MS));
        try {
          await startAgent();
        } catch (retryErr) {
          if (progress) progress.fail('agent', 'agent startup retry failed');
          else console.error('Agent startup retry also failed');
          throw retryErr;
        }
      } else {
        throw err;
      }
    }
    if (cfg.platform !== 'ios' && !cfg.package) {
      await ensureSessionReady({
        label: `Device ${cfg.device}`,
        config: cfg,
        device,
        client,
        agentApkPath: resolvedAgentApk,
        agentTestApkPath: resolvedAgentTestApk,
        iosXctestrunPath: resolvedIosXctestrun,
        deviceSerial: cfg.device,
        networkTracingEnabled,
      }, 'startup');
    }
    if (progress) progress.complete('agent', 'agent connected');
    else console.log(dim('Agent connected.'));
  } catch (err) {
    progress?.fail('agent', err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to start agent: ${err}`);
  }

  if (cfg.package) {
    try {
      progress?.start('app-launch', `launching ${cfg.package}`);
      await launchConfiguredApp({
        label: `Device ${cfg.device}`,
        config: cfg,
        device,
        client,
        agentApkPath: resolvedAgentApk,
        agentTestApkPath: resolvedAgentTestApk,
        iosXctestrunPath: resolvedIosXctestrun,
        iosAppPath: resolvedIosAppPath,
        deviceSerial: cfg.device,
        networkTracingEnabled,
      }, 'startup launch', { readinessAttempts: 3, skipAppReset });
      if (progress) progress.complete('app-launch', `launched ${cfg.package}`);
      else console.log(dim(`Launched ${cfg.package}`));
    } catch (err) {
      progress?.fail('app-launch', `failed to launch ${cfg.package}`);
      throw new Error(`Failed to launch app: ${err}`);
    }
  } else {
    progress?.skip('app-launch', 'no package configured');
  }

  return {
    effectiveConfig: cfg,
    client,
    device,
    deviceSerial: cfg.device,
    launchedEmulators,
    resolvedAgentApk,
    resolvedAgentTestApk,
    resolvedIosXctestrun,
    resolvedIosAppPath,
    signature,
  };
}

/**
 * Tear down a sequential device state when switching projects to a
 * different device. Closes the gRPC client and Device, kills the
 * spawned daemon process, and preserves any launched emulators for reuse.
 */
function teardownSequentialDevice(state: SequentialDeviceState): void {
  try { state.device.close(); } catch { /* already closed */ }
  try { state.client.close(); } catch { /* already closed */ }
  if (spawnedDaemonProcess) {
    try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    spawnedDaemonProcess = undefined;
  }
  preserveEmulatorsForReuse(state.launchedEmulators);
}

function listConnectedDeviceSerials(): string[] {
  return listAdbDevices()
    .filter((d) => d.state === 'device')
    .map((d) => d.serial);
}

async function ensureSequentialTargetDevice(
  config: Awaited<ReturnType<typeof loadConfig>>,
  progress?: LaunchProgressSink,
): Promise<{ selectedSerial?: string; launched: LaunchedEmulator[] }> {
  if (config.device) {
    // If the device is an iOS simulator that's already booted, log reuse
    if (config.platform === 'ios') {
      const { listBootedSimulators } = await import('./ios-simulator.js');
      const booted = listBootedSimulators();
      const sim = booted.find((s) => s.udid === config.device);
      if (sim) {
        // "Already booted" and nothing more — the boot may have come from a
        // previous tapsmith run OR from something else entirely (e.g. a CI
        // workflow step that pre-boots the simulator).
        const message = `Reusing already-booted simulator ${sim.udid} (${sim.name}).`;
        if (progress) progress.update('primary-device', { state: 'running', detail: `reusing already-booted ${sim.name}` });
        else process.stderr.write(`${DIM}${message}${RESET}\n`);
      }
    }
    return { selectedSerial: config.device, launched: [] };
  }

  // ─── iOS: use simulator instead of ADB device ───
  if (config.platform === 'ios') {
    const { listBootedSimulators, provisionSimulator, cleanupStaleSimulators } = await import('./ios-simulator.js');
    // If no simulator is configured, try to auto-resolve a single paired
    // physical device. Mirrors how simulators are picked by name — the
    // user should not have to hand-parse `devicectl` JSON in their config.
    if (!config.simulator) {
      try {
        const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
        const udid = resolvePhysicalIosDevice();
        const message = `Auto-detected physical iOS device ${udid}.`;
        if (progress) progress.note(message);
        else process.stderr.write(`${DIM}${message}${RESET}\n`);
        return { selectedSerial: udid, launched: [] };
      } catch (e) {
        console.error(
          red(
            `No simulator specified and physical device auto-detect failed: ${(e as Error).message}\n` +
              `Set \`simulator\` (e.g. simulator: "iPhone 16") or \`device\` in your config.`,
          ),
        );
        process.exit(1);
      }
    }
    const simulatorName = config.simulator;

    // Clean up stale clones from previous runs
    const staleResult = cleanupStaleSimulators(simulatorName);
    if (staleResult.killed.length > 0) {
      const message = `Cleaned up ${staleResult.killed.length} stale simulator(s).`;
      if (progress) progress.note(message);
      else process.stderr.write(`${DIM}${message}${RESET}\n`);
    }

    // Check for already-booted simulators
    const booted = listBootedSimulators();
    const matching = booted.find((s) => s.name === simulatorName || s.udid === simulatorName);
    if (matching) {
      const message = `Reusing already-booted simulator ${matching.udid} (${matching.name}).`;
      if (progress) progress.update('primary-device', { state: 'running', detail: `reusing already-booted ${matching.name}` });
      else process.stderr.write(`${DIM}${message}${RESET}\n`);
      return { selectedSerial: matching.udid, launched: [] };
    }

    // Boot the simulator
    try {
      const udid = provisionSimulator(simulatorName, config.app);
      return { selectedSerial: udid, launched: [] };
    } catch (e) {
      console.error(red(`Failed to provision iOS simulator: ${(e as Error).message}`));
      process.exit(1);
    }
  }

  const clearedOfflineEmulators = clearOfflineEmulatorTransports();
  for (const serial of clearedOfflineEmulators) {
    const message = `Cleared stale offline emulator transport ${serial} before device selection.`;
    if (progress) progress.note(message);
    else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
  }

  // Reclaim healthy emulators from previous runs, kill unhealthy ones.
  // cleanupStaleEmulators logs details about each action internally.
  const staleResult = cleanupStaleEmulators(config.avd);
  if (staleResult.killed.length > 0) {
    const message = `Cleaned up ${staleResult.killed.length} stale emulator(s).`;
    if (progress) progress.note(message);
    else process.stderr.write(`${DIM}${message}${RESET}\n`);
  }

  const deviceStrategy = resolveDeviceStrategy(config);
  const onlineSerials = listConnectedDeviceSerials();
  const prefilteredOnline = prefilterDevicesForStrategy(
    onlineSerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(prefilteredOnline.skippedDevices, progress);
  const healthyOnline = filterHealthyDevices(prefilteredOnline.candidateSerials);
  warnSequentialUnhealthyDevices(healthyOnline.unhealthyDevices, progress);
  const selectedOnline = selectDevicesForStrategy(
    healthyOnline.healthySerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(
    selectedOnline.skippedDevices.filter(
      (device) => !prefilteredOnline.skippedDevices.some((prefiltered) => prefiltered.serial === device.serial),
    ),
    progress,
  );

  if (selectedOnline.selectedSerials.length > 0) {
    return { selectedSerial: selectedOnline.selectedSerials[0], launched: [] };
  }

  if (!config.launchEmulators) {
    return { selectedSerial: undefined, launched: [] };
  }

  progress?.update('primary-device', { state: 'running', detail: 'launching Android emulator' });
  const provision = await provisionEmulators({
    existingSerials: [],
    occupiedSerials: onlineSerials,
    workers: 1,
    avd: config.avd,
    onProgress: (message, level) => {
      if (!progress) return;
      if (level === 'warning') progress.note(message);
      else progress.update('primary-device', { state: 'running', detail: message });
    },
  });
  const healthyProvisioned = filterHealthyDevices(provision.allSerials);
  warnSequentialUnhealthyDevices(healthyProvisioned.unhealthyDevices, progress);
  const selectedProvisioned = selectDevicesForStrategy(
    healthyProvisioned.healthySerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(selectedProvisioned.skippedDevices, progress);

  return {
    selectedSerial: selectedProvisioned.selectedSerials[0],
    launched: provision.launched,
  };
}

// ─── Argument parsing ───

interface CliArgs {
  command: string;
  files: string[];
  device?: string;
  workers?: number;
  shard?: { current: number; total: number };
  trace?: string;
  /** `--video <mode>` override. See `VideoMode` in config for accepted values. */
  video?: string;
  watch: boolean;
  ui: boolean;
  uiPort?: number;
  uiDevUrl?: string;
  config?: string;
  forceInstall: boolean;
  version: boolean;
  help: boolean;
  tsxReexec: boolean;
  /** Pattern from `--grep` / `-g`. Compiled to a RegExp later. */
  grep?: string;
  /** Pattern from `--grep-invert`. Compiled to a RegExp later. */
  grepInvert?: string;
  /** Reporter override from `--reporter`. */
  reporter?: string;
  /** Project name(s) from `--project` (repeatable). Filters which configured projects run. */
  project?: string[];
}

function compileGrepPattern(pattern: string, flag: string): RegExp {
  try {
    const match = pattern.match(/^\/(.*)\/([gimusy]*)$/);
    if (match) return new RegExp(match[1], match[2]);
    return new RegExp(pattern);
  } catch (err) {
    console.error(red(`${flag} is not a valid regular expression: ${(err as Error).message}`));
    process.exit(1);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: '',
    files: [],
    watch: false,
    ui: false,
    version: false,
    help: false,
    forceInstall: false,
    tsxReexec: false,
  };

  const rest = argv.slice(2);
  let i = 0;

  while (i < rest.length) {
    const arg = rest[i];

    if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--device' || arg === '-d') {
      args.device = rest[++i];
    } else if (arg?.startsWith('--device=')) {
      args.device = arg.slice('--device='.length);
    } else if (arg === '--workers' || arg === '-j') {
      const val = parseInt(rest[++i], 10);
      if (isNaN(val) || val < 1) {
        console.error(red('--workers must be a positive integer'));
        process.exit(1);
      }
      args.workers = val;
    } else if (arg?.startsWith('--workers=') || arg?.startsWith('-j=')) {
      const raw = arg.startsWith('--workers=')
        ? arg.slice('--workers='.length)
        : arg.slice('-j='.length);
      const val = parseInt(raw, 10);
      if (isNaN(val) || val < 1) {
        console.error(red('--workers must be a positive integer'));
        process.exit(1);
      }
      args.workers = val;
    } else if (arg?.startsWith('--shard=')) {
      const shardStr = arg.slice('--shard='.length);
      const match = shardStr.match(/^(\d+)\/(\d+)$/);
      if (!match) {
        console.error(red('--shard must be in the format x/y (e.g. --shard=1/4)'));
        process.exit(1);
      }
      const current = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      if (current < 1 || current > total) {
        console.error(red(`Invalid shard: ${current}/${total}. Current must be between 1 and total.`));
        process.exit(1);
      }
      args.shard = { current, total };
    } else if (arg === '--trace') {
      args.trace = rest[++i] ?? 'on';
    } else if (arg?.startsWith('--trace=')) {
      args.trace = arg.slice('--trace='.length);
    } else if (arg === '--video') {
      args.video = rest[++i] ?? 'on';
    } else if (arg?.startsWith('--video=')) {
      args.video = arg.slice('--video='.length);
    } else if (arg === '--watch' || arg === '-w') {
      args.watch = true;
    } else if (arg === '--ui') {
      args.ui = true;
    } else if (arg === '--ui-port') {
      const val = parseInt(rest[++i], 10);
      if (isNaN(val) || val < 0) {
        console.error(red('--ui-port must be a non-negative integer'));
        process.exit(1);
      }
      args.uiPort = val;
    } else if (arg?.startsWith('--ui-port=')) {
      const val = parseInt(arg.slice('--ui-port='.length), 10);
      if (isNaN(val) || val < 0) {
        console.error(red('--ui-port must be a non-negative integer'));
        process.exit(1);
      }
      args.uiPort = val;
    } else if (arg === '--ui-dev-url') {
      args.uiDevUrl = rest[++i];
    } else if (arg?.startsWith('--ui-dev-url=')) {
      args.uiDevUrl = arg.slice('--ui-dev-url='.length);
    } else if (arg === '--config' || arg === '-c') {
      args.config = rest[++i];
    } else if (arg?.startsWith('--config=')) {
      args.config = arg.slice('--config='.length);
    } else if (arg === '--reporter') {
      args.reporter = rest[++i];
    } else if (arg?.startsWith('--reporter=')) {
      args.reporter = arg.slice('--reporter='.length);
    } else if (arg === '--project') {
      const val = rest[++i];
      if (!val) {
        console.error(red('--project requires a project name'));
        process.exit(1);
      }
      (args.project ??= []).push(val);
    } else if (arg?.startsWith('--project=')) {
      const val = arg.slice('--project='.length);
      if (!val) {
        console.error(red('--project requires a project name'));
        process.exit(1);
      }
      (args.project ??= []).push(val);
    } else if (arg === '--grep' || arg === '-g') {
      args.grep = rest[++i];
    } else if (arg?.startsWith('--grep=')) {
      args.grep = arg.slice('--grep='.length);
    } else if (arg?.startsWith('-g=')) {
      args.grep = arg.slice('-g='.length);
    } else if (arg === '--grep-invert') {
      args.grepInvert = rest[++i];
    } else if (arg?.startsWith('--grep-invert=')) {
      args.grepInvert = arg.slice('--grep-invert='.length);
    } else if (arg === '--force-install') {
      args.forceInstall = true;
    } else if (arg === '--__tsx-reexec') {
      args.tsxReexec = true;
    } else if (!arg.startsWith('-') && !args.command) {
      args.command = arg;
      // Subcommands with their own argument parsers: stop consuming here
      // so downstream flags (e.g. `build-ios-agent --verbose --team-id X`)
      // aren't rejected by the top-level parser. The subcommand handler
      // re-parses from process.argv after the command name.
      if (
        arg === 'build-ios-agent'
        || arg === 'create-avd'
        || arg === 'configure-ios-network'
        || arg === 'refresh-ios-network'
        || arg === 'verify-ios-network'
        || arg === 'verify'
        || arg === 'list-devices'
        || arg === 'mcp-server'
        || arg === 'doctor'
        || arg === 'init'
      ) {
        break;
      }
    } else if (!arg.startsWith('-')) {
      args.files.push(arg);
    } else {
      console.error(red(`Unknown argument: ${arg}`));
      process.exit(1);
    }

    i++;
  }

  return args;
}

/**
 * Provision additional device serials for multi-worker iOS/Android modes.
 * Returns the full list of device serials (including the primary), or
 * undefined if fewer than 2 devices are available.
 */
async function provisionMultiWorkerDevices(
  config: Awaited<ReturnType<typeof loadConfig>>,
  modeName: string,
  opts?: { quiet?: boolean; progress?: LaunchProgressSink },
): Promise<{ deviceSerials: string[] | undefined; launched: LaunchedEmulator[] }> {
  let launched: LaunchedEmulator[] = [];
  if (config.workers <= 1) return { deviceSerials: undefined, launched };
  opts?.progress?.start('worker-devices', `preparing ${config.workers} worker device(s)`);

  let serials: string[];
  let reusedSimulatorCount = 0;
  if (config.platform === 'ios') {
    const { listCompatibleBootedSimulators, provisionSimulators, cleanupStaleSimulators } = await import('./ios-simulator.js');
    let reusableUdids: string[] = [];
    if (config.simulator) {
      const staleResult = cleanupStaleSimulators(config.simulator);
      reusableUdids = staleResult.reusable;
      if (staleResult.reusable.length > 0 && opts?.progress) {
        opts.progress.update('worker-devices', {
          state: 'running',
          detail: `found ${staleResult.reusable.length} reusable simulator(s) from previous run`,
        });
      }
    }
    const compatible = listCompatibleBootedSimulators(config.device!);
    const others = compatible.filter((s) => s.udid !== config.device).slice(0, config.workers - 1);
    if (others.length > 0) {
      reusedSimulatorCount += others.length;
      if (opts?.progress) {
        opts.progress.update('worker-devices', {
          state: 'running',
          detail: `reusing ${others.length} booted simulator(s) from previous run`,
        });
      } else {
        for (const sim of others) {
          process.stderr.write(`${DIM}Reusing simulator ${sim.udid} (${sim.name}) from previous run.${RESET}\n`);
        }
      }
    }
    serials = [config.device!, ...others.map((s) => s.udid)].filter(Boolean);

    if (serials.length < config.workers && config.simulator) {
      const provision = provisionSimulators({
        simulatorName: config.simulator,
        workers: config.workers,
        existingUdids: serials,
        appPath: config.app ? path.resolve(config.rootDir, config.app) : undefined,
        reusableUdids,
        onProgress: (message, level) => {
          if (!opts?.progress) return;
          if (level === 'warning') opts.progress.note(message);
          else opts.progress.update('worker-devices', { state: 'running', detail: message });
        },
      });
      reusedSimulatorCount += provision.reusedUdids.length;
      serials = provision.allUdids;
    }
  } else {
    const allConnected = listConnectedDeviceSerials();
    const others = allConnected.filter((s) => s !== config.device);
    serials = [config.device!, ...others].filter(Boolean);

    if (serials.length < config.workers && config.launchEmulators) {
      const provision = await provisionEmulators({
        existingSerials: serials,
        occupiedSerials: allConnected,
        workers: config.workers,
        avd: config.avd,
        onProgress: (message, level) => {
          if (!opts?.progress) return;
          if (level === 'warning') opts.progress.note(message);
          else opts.progress.update('worker-devices', { state: 'running', detail: message });
        },
      });
      launched = provision.launched;
      serials = provision.allSerials;
    }
  }

  if (serials.length < 2) {
    opts?.progress?.skip('worker-devices', `${serials.length} device(s) available; using single-worker mode`);
    if (!opts?.quiet && !opts?.progress) {
      process.stderr.write(
        `${YELLOW}Only ${serials.length} device(s) available. ${modeName} needs 2+ devices for parallel. Using single-worker mode.${RESET}\n`,
      );
    }
    return { deviceSerials: undefined, launched };
  }

  const reuseSuffix = reusedSimulatorCount > 0 ? ` (${reusedSimulatorCount} reused)` : '';
  opts?.progress?.complete('worker-devices', `${serials.length} device(s)${reuseSuffix}: ${serials.join(', ')}`);
  return { deviceSerials: serials, launched };
}

interface PerProjectProvisionResult {
  deviceSerials: string[]
  configByDevice: Map<string, import('./worker-protocol.js').SerializedConfig>
  bucketByDevice: Map<string, string>
  bucketByProject: Map<string, string>
  launched: LaunchedEmulator[]
  reusedSimulatorCount: number
}

/**
 * Provision devices for a single bucket using its effective config and a
 * fixed worker count. Returns the device serials successfully provisioned
 * (may be fewer than requested if hardware constraints prevent it).
 */
async function provisionDevicesForBucket(
  effectiveConfig: TapsmithConfig,
  desiredWorkers: number,
  progress?: LaunchProgressSink,
): Promise<{ serials: string[]; launched: LaunchedEmulator[]; reusedSimulatorCount: number }> {
  if (desiredWorkers <= 0) return { serials: [], launched: [], reusedSimulatorCount: 0 };

  if (effectiveConfig.platform === 'ios') {
    // Physical-device bucket: no `simulator` set → resolve a paired USB
    // device. Parallel workers against one physical device aren't
    // supported, so we always return a single serial here regardless of
    // desiredWorkers; the caller's worker allocation is capped elsewhere.
    if (!effectiveConfig.simulator) {
      if (effectiveConfig.device) {
        return { serials: [effectiveConfig.device], launched: [], reusedSimulatorCount: 0 };
      }
      const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
      try {
        const udid = resolvePhysicalIosDevice();
        return { serials: [udid], launched: [], reusedSimulatorCount: 0 };
      } catch (e) {
        throw new Error(
          `iOS physical device bucket failed to resolve: ${(e as Error).message}`,
        );
      }
    }
    const { provisionSimulators, listBootedSimulators, cleanupStaleSimulators } =
      await import('./ios-simulator.js');

    const stale = cleanupStaleSimulators(effectiveConfig.simulator);
    const reusableUdids = stale.reusable;
    if (reusableUdids.length > 0 && progress) {
      progress.update('worker-devices', {
        state: 'running',
        detail: `found ${reusableUdids.length} reusable simulator(s) from previous run`,
      });
    }

    // Find any already-booted matching simulators (no primary required)
    const booted = listBootedSimulators().filter(
      (s) => s.name === effectiveConfig.simulator || s.udid === effectiveConfig.simulator,
    );
    const existing = booted.map((s) => s.udid).slice(0, desiredWorkers);

    if (existing.length >= desiredWorkers) {
      return { serials: existing, launched: [], reusedSimulatorCount: 0 };
    }

    const provision = provisionSimulators({
      simulatorName: effectiveConfig.simulator,
      workers: desiredWorkers,
      existingUdids: existing,
      appPath: effectiveConfig.app
        ? path.resolve(effectiveConfig.rootDir, effectiveConfig.app)
        : undefined,
      reusableUdids,
      onProgress: (message, level) => {
        if (!progress) return;
        if (level === 'warning') progress.note(message);
        else progress.update('worker-devices', { state: 'running', detail: message });
      },
    });
    return { serials: provision.allUdids, launched: [], reusedSimulatorCount: provision.reusedUdids.length };
  }

  // Android
  const allConnected = listConnectedDeviceSerials();
  const deviceStrategy = resolveDeviceStrategy(effectiveConfig);
  const prefiltered = prefilterDevicesForStrategy(
    allConnected,
    deviceStrategy,
    effectiveConfig.avd,
  );
  const healthy = filterHealthyDevices(prefiltered.candidateSerials);
  const selected = selectDevicesForStrategy(
    healthy.healthySerials,
    deviceStrategy,
    effectiveConfig.avd,
  );
  let serials = selected.selectedSerials.slice(0, desiredWorkers);

  if (serials.length >= desiredWorkers) {
    return { serials, launched: [], reusedSimulatorCount: 0 };
  }

  if (!effectiveConfig.launchEmulators) {
    return { serials, launched: [], reusedSimulatorCount: 0 };
  }

  const provision = await provisionEmulators({
    existingSerials: serials,
    occupiedSerials: allConnected,
    workers: desiredWorkers,
    avd: effectiveConfig.avd,
    onProgress: (message, level) => {
      if (!progress) return;
      if (level === 'warning') progress.note(message);
      else progress.update('worker-devices', { state: 'running', detail: message });
    },
  });
  const healthyLaunched = filterHealthyDevices(provision.allSerials);
  const selectedAfter = selectDevicesForStrategy(
    healthyLaunched.healthySerials,
    deviceStrategy,
    effectiveConfig.avd,
  );
  serials = selectedAfter.selectedSerials.slice(0, desiredWorkers);
  return { serials, launched: provision.launched, reusedSimulatorCount: 0 };
}

/**
 * Provision devices per project bucket. Each bucket (set of projects sharing
 * a deviceSignature) gets its own devices and serialized config. Used by
 * UI mode and watch mode to support multi-device-target projects.
 */
async function provisionPerProjectDevices(
  rootConfig: TapsmithConfig,
  projects: import('./project.js').ResolvedProject[],
  budgetCap?: number,
  progress?: LaunchProgressSink,
): Promise<PerProjectProvisionResult> {
  progress?.start('worker-devices', 'preparing devices across project targets');
  const result: PerProjectProvisionResult = {
    deviceSerials: [],
    configByDevice: new Map(),
    bucketByDevice: new Map(),
    bucketByProject: new Map(),
    launched: [],
    reusedSimulatorCount: 0,
  };

  const { allocateBucketWorkers, bucketizeProjects } = await import('./project.js');
  const bucketEntries = bucketizeProjects(projects);
  for (const b of bucketEntries) {
    for (const p of b.projects) {
      result.bucketByProject.set(p.name, b.signature);
    }
  }

  // Allocate workers across buckets
  const allocation = allocateBucketWorkers(rootConfig.workers, bucketEntries, budgetCap);

  // Provision each bucket's devices in parallel — Android emulators and
  // iOS simulators both have multi-second cold-start costs, and there's
  // no cross-bucket dependency. Preserves per-bucket ordering in the
  // aggregated result by collecting into position-indexed slots.
  const tasks = bucketEntries.map(async ({ signature, projects: bucketProjects }) => {
    const desiredWorkers = allocation.get(signature) ?? 0;
    if (desiredWorkers === 0) return null;

    const bucketEffective = bucketProjects[0].effectiveConfig;
    progress?.update(
      'worker-devices',
      { state: 'running', detail: `preparing ${desiredWorkers} device(s) for ${bucketProjects.map((p) => p.name).join(', ')}` },
    );
    const provisioned = await provisionDevicesForBucket(bucketEffective, desiredWorkers, progress);

    if (provisioned.serials.length === 0) {
      throw new Error(
        `Failed to provision any devices for bucket "${signature.split('|').slice(0, 2).join(' ')}".`,
      );
    }
    if (provisioned.serials.length < desiredWorkers) {
      const message = `Bucket "${bucketProjects.map((p) => p.name).join(',')}" requested ${desiredWorkers} workers but only ${provisioned.serials.length} device(s) could be provisioned.`;
      if (progress) progress.note(message);
      else process.stderr.write(`${YELLOW}${message}${RESET}\n`);
    }

    return { signature, bucketEffective, provisioned };
  });

  const outcomes = await Promise.all(tasks);

  for (const outcome of outcomes) {
    if (!outcome) continue;
    const { signature, bucketEffective, provisioned } = outcome;
    result.launched.push(...provisioned.launched);
    result.reusedSimulatorCount += provisioned.reusedSimulatorCount;
    const bucketSerialized = serializeConfig(bucketEffective);
    for (const serial of provisioned.serials) {
      result.deviceSerials.push(serial);
      result.configByDevice.set(serial, bucketSerialized);
      result.bucketByDevice.set(serial, signature);
    }
  }

  const reuseSuffix = result.reusedSimulatorCount > 0 ? ` (${result.reusedSimulatorCount} reused)` : '';
  progress?.complete('worker-devices', `${result.deviceSerials.length} device(s)${reuseSuffix}: ${result.deviceSerials.join(', ')}`);
  return result;
}

function printHelp(): void {
  printTapsmithBanner();
  console.log(`${bold('Mobile app testing framework')}

${bold('Usage:')}
  tapsmith test [files...]           Run test files
  tapsmith test --watch              Watch test files and re-run on change
  tapsmith test --ui                 Open interactive UI mode
  tapsmith test --ui --ui-port 8080  UI mode on specific port
  tapsmith test --device <serial>    Target specific device/simulator
  tapsmith test --workers <n>        Run tests in parallel across n devices
  tapsmith test --shard=x/y          Run shard x of y (for CI)
  tapsmith test --trace <mode>       Record traces (on, retain-on-failure, etc.)
  tapsmith test --video <mode>       Record videos (on, retain-on-failure, etc.)
  tapsmith show-trace <file.zip>     Open trace viewer in browser
  tapsmith show-report [dir]         Open HTML test report
  tapsmith merge-reports [dir]       Merge blob reports from sharded runs
  tapsmith list-devices              List connected devices (Android, iOS sim, iOS physical)
  tapsmith list-devices --json       Same, as JSON for scripting
  tapsmith setup-ios                 First-run setup for iOS network capture (macOS only)
  tapsmith setup-ios-device          Preflight checklist for physical iOS device testing
  tapsmith build-ios-agent           Build the signed TapsmithAgent runner for physical iOS devices
  tapsmith create-avd                Create an Android AVD that supports HTTPS network capture
  tapsmith configure-ios-network <udid>   Generate a network capture profile (.mobileconfig) for a physical iOS device
  tapsmith refresh-ios-network <udid>     Regenerate the network capture profile after a host Wi-Fi change
  tapsmith verify-ios-network <udid>      Verify HTTPS capture for a normal system-trust client on a physical iOS device
  tapsmith init                      Initialize a new Tapsmith project (interactive wizard)
  tapsmith init --yes [--json]       Non-interactive init for scripts/AI agents (see init --help)
  tapsmith verify [--json]           Run one test end-to-end to prove the setup works
  tapsmith doctor [--json] [-c file] Check system health (--json includes fixes + device inventory)
  tapsmith mcp-server [--config file] Run MCP server for LLM/agent integration (stdio transport)
  tapsmith --version                 Print version
  tapsmith --help                    Show this help

${bold('Options:')}
  -w, --watch              Watch test files and re-run on change
  -d, --device <serial>    Target a specific device or simulator by serial/UDID
  -j, --workers <n>        Number of parallel workers (default: 1)
  --shard=x/y              Split tests across CI machines (e.g. --shard=1/4)
  --trace <mode>           Trace mode: off, on, on-first-retry, on-all-retries,
                           retain-on-failure, retain-on-first-failure,
                           retain-on-failure-and-retries
  --video <mode>           Video mode (same set as --trace). Records the
                           device screen for the lifetime of each test.
  -c, --config <path>      Path to config file (default: tapsmith.config.ts)
  -g, --grep <pattern>     Run only tests whose fullName matches this regex
  --grep-invert <pattern>  Skip tests whose fullName matches this regex
  --reporter <name>        Override the reporter (list, line, dot, json, junit, html, github)
  --project <name>         Only run the named project from your config (repeatable;
                           dependencies run automatically)
  --force-install          Reinstall the app even if already installed
  -v, --version            Print version
  -h, --help               Show this help
`);
}

// ─── Main ───

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(getVersion());
    return;
  }

  // Subcommands that print their own command-specific help on --help.
  // Other commands (e.g. `tapsmith test --help`) fall back to the top-level
  // help below.
  const subcommandsWithOwnHelp = new Set<string>([
    'build-ios-agent',
    'create-avd',
    'configure-ios-network',
    'refresh-ios-network',
    'verify-ios-network',
    'init',
    'verify',
  ]);

  if (args.help && !(args.command && subcommandsWithOwnHelp.has(args.command))) {
    printHelp();
    return;
  }
  if (!args.command) {
    printHelp();
    return;
  }

  if (shouldPrintBannerForCommand(args)) {
    printTapsmithBanner();
  }

  if (args.command === 'show-report') {
    const reportDir = args.files[0] ?? 'tapsmith-report';
    const reportPath = path.resolve(process.cwd(), reportDir, 'index.html');
    if (!fs.existsSync(reportPath)) {
      console.error(red(`No report found at ${reportPath}`));
      process.exit(1);
    }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    console.log(bold('Opening HTML report'));
    console.log(dim(reportPath));
    try {
      spawn(cmd, [reportPath], { detached: true, stdio: 'ignore' }).unref();
      console.log(green('✓ opened default browser'));
    } catch (err) {
      console.error(red(`Failed to open report: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    return;
  }

  if (args.command === 'show-trace') {
    const traceFile = args.files[0];
    if (!traceFile) {
      console.error(red('Usage: tapsmith show-trace <trace.zip>'));
      process.exit(1);
    }
    const { showTrace } = await import('./trace/show-trace-server.js');
    try {
      console.log(bold('Opening trace viewer'));
      console.log(dim(path.resolve(traceFile)));
      const server = await showTrace({ tracePath: traceFile });
      console.log(green('✓ trace viewer ready'));
      console.log(dim(`Trace viewer running at http://127.0.0.1:${server.port}/`));
      console.log(dim('Press Ctrl+C to stop.'));
      // Keep alive until Ctrl+C
      process.on('SIGINT', () => {
        server.close();
        process.exit(0);
      });
      // Prevent Node from exiting
      await new Promise(() => {});
    } catch (err) {
      console.error(red(`${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    return;
  }

  if (args.command === 'merge-reports') {
    const blobDir = args.files[0] ?? 'blob-report';
    const resolvedDir = path.resolve(process.cwd(), blobDir);
    if (!fs.existsSync(resolvedDir)) {
      console.error(red(`No blob directory found at ${resolvedDir}`));
      process.exit(1);
    }
    const { mergeBlobs } = await import('./reporters/blob.js');
    const config = await loadConfig(undefined, args.config);
    const result = mergeBlobs(resolvedDir);
    console.log(bold('Merging blob reports'));
    console.log(dim(resolvedDir));
    console.log();
    const reporters = await createReporters(config.reporter ?? 'list');
    const dispatcher = new ReporterDispatcher(reporters);
    dispatcher.onRunStart(config, 0);
    await dispatcher.onRunEnd(result);
    return;
  }

  if (args.command === 'list-devices') {
    const { runListDevices } = await import('./list-devices.js');
    const forwardedArgv = forwardedArgs('list-devices');
    await runListDevices(forwardedArgv);
    return;
  }

  if (args.command === 'setup-ios') {
    const { runSetupIos } = await import('./setup-ios.js');
    await runSetupIos();
    return;
  }

  if (args.command === 'setup-ios-device') {
    const { runSetupIosDevice } = await import('./setup-ios-device.js');
    await runSetupIosDevice();
    return;
  }

  if (args.command === 'configure-ios-network') {
    const { runConfigureIosNetwork } = await import('./configure-ios-network.js');
    const forwardedArgv = forwardedArgs('configure-ios-network');
    await runConfigureIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'refresh-ios-network') {
    const { runRefreshIosNetwork } = await import('./configure-ios-network.js');
    const forwardedArgv = forwardedArgs('refresh-ios-network');
    await runRefreshIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'verify-ios-network') {
    const { runVerifyIosNetwork } = await import('./verify-ios-network.js');
    const forwardedArgv = forwardedArgs('verify-ios-network');
    await runVerifyIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'build-ios-agent') {
    const { runBuildIosAgent } = await import('./build-ios-agent.js');
    // Everything after the subcommand name is forwarded; drop the verb.
    const forwardedArgv = forwardedArgs('build-ios-agent');
    await runBuildIosAgent(forwardedArgv);
    return;
  }

  if (args.command === 'init') {
    const { runInit } = await import('./init.js');
    const forwardedArgv = forwardedArgs('init');
    await runInit(forwardedArgv);
    return;
  }

  if (args.command === 'create-avd') {
    const { runCreateAvd } = await import('./create-avd.js');
    const forwardedArgv = forwardedArgs('create-avd');
    await runCreateAvd(forwardedArgv);
    return;
  }

  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    const forwardedArgv = forwardedArgs('doctor');
    await runDoctor(forwardedArgv);
    return;
  }

  if (args.command === 'mcp-server') {
    const { runMcpServer } = await import('./mcp/index.js');
    const forwardedArgv = forwardedArgs('mcp-server');
    await runMcpServer(forwardedArgv);
    return;
  }

  if (args.command === 'verify') {
    const { runVerify } = await import('./verify.js');
    const forwardedArgv = forwardedArgs('verify');
    await runVerify(forwardedArgv);
    return;
  }

  if (args.command !== 'test') {
    console.error(red(`Unknown command: ${args.command}`));
    printHelp();
    process.exit(1);
  }

  // Load config
  const config = await loadConfig(undefined, args.config);
  const configPath = configPathOf(config);
  if (args.device) {
    config.device = args.device;
  }
  if (args.workers !== undefined) {
    config.workers = args.workers;
    Object.defineProperty(config, EXPLICIT_WORKERS, {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  if (args.shard) {
    config.shard = args.shard;
  }
  if (args.trace) {
    config.trace = args.trace as TapsmithConfig['trace'];
  }
  if (args.video) {
    config.video = args.video as TapsmithConfig['video'];
  }
  if (args.grep !== undefined) {
    config.grep = compileGrepPattern(args.grep, '--grep');
  }
  if (args.grepInvert !== undefined) {
    config.grepInvert = compileGrepPattern(args.grepInvert, '--grep-invert');
  }
  if (args.reporter) {
    config.reporter = args.reporter;
  }

  // Validate watch mode constraints
  if (args.watch) {
    if (args.shard) {
      console.error(red('--watch cannot be combined with --shard'));
      process.exit(1);
    }
    // Watch mode supports parallel workers when multiple devices are available.
    // config.workers is left as-is; the watch coordinator handles multi-device setup.
  }

  // Validate UI mode constraints
  if (args.ui) {
    if (args.shard) {
      console.error(red('--ui cannot be combined with --shard'));
      process.exit(1);
    }
    if (args.watch) {
      // UI mode has its own watch — ignore --watch
      args.watch = false;
    }
    // UI mode supports parallel workers when multiple devices are available.
    // config.workers is left as-is; the UI server handles multi-device setup.
  }

  // ─── Project resolution & test file discovery ───
  const { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectsForFile, validateProjectNames, projectLabel } = await import('./project.js');
  const hasProjects = config.projects && config.projects.length > 0;
  const hasExplicitFiles = args.files && args.files.length > 0;
  const selectedProjects = args.project && args.project.length > 0 ? args.project : undefined;

  // `--project` requires a configured `projects` array (the only exception is
  // explicitly selecting the synthetic "default" project).
  if (selectedProjects && !hasProjects && !selectedProjects.every((n) => n === 'default')) {
    console.error(red(
      `--project requires a "projects" array in your config. `
      + `Requested: ${selectedProjects.map((n) => `"${n}"`).join(', ')}`,
    ));
    process.exit(1);
  }

  let projects: import('./project.js').ResolvedProject[];
  let projectWaves: import('./project.js').ResolvedProject[][];

  if (hasProjects && !hasExplicitFiles) {
    // Full project mode — discover all files per project
    projects = resolveProjects(config);
    if (selectedProjects) {
      try {
        validateProjectNames(selectedProjects, projects);
      } catch (err) {
        console.error(red((err as Error).message));
        process.exit(1);
      }
      // Run the selected projects plus their transitive dependencies.
      const required = collectTransitiveDeps(new Set(selectedProjects), projects);
      projects = projects.filter((p) => required.has(p.name));
    }
    projectWaves = topologicalSort(projects);
    for (const project of projects) {
      project.testFiles = await discoverTestFiles(project.testMatch, config.rootDir, undefined, project.testIgnore);
    }
  } else if (hasProjects && hasExplicitFiles) {
    // Explicit files with projects — auto-run dependencies
    const allProjects = resolveProjects(config);
    if (selectedProjects) {
      try {
        validateProjectNames(selectedProjects, allProjects);
      } catch (err) {
        console.error(red((err as Error).message));
        process.exit(1);
      }
    }
    const selectedSet = selectedProjects ? new Set(selectedProjects) : undefined;
    const explicitPaths = args.files.map((f: string) => path.resolve(config.rootDir, f));

    // Find which projects the explicit files belong to
    const targetProjectNames = new Set<string>();
    const filesByProject = new Map<string, string[]>();
    for (const filePath of new Set(explicitPaths)) {
      for (const name of findProjectsForFile(filePath, allProjects, config.rootDir)) {
        // When `--project` is given, only keep matches in the selected set.
        if (selectedSet && !selectedSet.has(name)) continue;
        targetProjectNames.add(name);
        let list = filesByProject.get(name);
        if (!list) {
          list = [];
          filesByProject.set(name, list);
        }
        list.push(filePath);
      }
    }

    // Collect transitive dependencies
    const requiredNames = collectTransitiveDeps(targetProjectNames, allProjects);

    // Filter to only required projects
    projects = allProjects.filter((p) => requiredNames.has(p.name));
    projectWaves = topologicalSort(projects);

    // Discover files: dependency projects get their full testMatch, target projects get only explicit files
    for (const project of projects) {
      if (targetProjectNames.has(project.name)) {
        project.testFiles = filesByProject.get(project.name) ?? [];
      } else {
        // Dependency project — run all its files
        project.testFiles = await discoverTestFiles(project.testMatch, config.rootDir, undefined, project.testIgnore);
      }
    }
  } else {
    // No projects configured — single default project
    const { deviceSignature: makeDeviceSignature } = await import('./project.js');
    const defaultProject: import('./project.js').ResolvedProject = {
      name: 'default',
      // Invented because the config declares no projects — the flag is what
      // stops the UI and MCP from presenting it as one the user can name.
      synthesized: true,
      testMatch: config.testMatch,
      testIgnore: [],
      dependencies: [],
      testFiles: [],
      effectiveConfig: config,
      deviceSignature: makeDeviceSignature(config),
    };
    defaultProject.testFiles = await discoverTestFiles(config.testMatch, config.rootDir, args.files);
    projects = [defaultProject];
    projectWaves = [[defaultProject]];
  }

  // Flat list for backward-compatible code paths (reporters, tsx check, etc.)
  let testFiles = projects.flatMap((p) => p.testFiles);
  // Deduplicate (a file could match multiple projects' globs)
  testFiles = [...new Set(testFiles)].sort();

  if (testFiles.length === 0) {
    console.error(red('No test files found.'));
    process.exit(1);
  }

  let shardMessage: string | undefined;
  // Apply sharding — deterministic split within each project. Setup projects
  // (depended on by others) only run on shards that have tests from their dependents.
  if (config.shard) {
    const { current, total } = config.shard;
    if (hasProjects) {
      const depTargets = new Set(projects.flatMap((p) => p.dependencies));
      // First pass: shard non-setup projects
      for (const project of projects) {
        if (depTargets.has(project.name)) continue;
        project.testFiles = project.testFiles.filter((_, i) => i % total === current - 1);
      }
      // Second pass: skip setup projects whose dependents have no files in this shard
      for (const project of projects) {
        if (!depTargets.has(project.name)) continue;
        const hasDependentTests = projects.some(
          (p) => p.dependencies.includes(project.name) && p.testFiles.length > 0,
        );
        if (!hasDependentTests) {
          project.testFiles = [];
        }
      }
      testFiles = projects.flatMap((p) => p.testFiles);
    } else {
      testFiles = testFiles.filter((_, i) => i % total === current - 1);
    }
    if (testFiles.length === 0) {
      console.log(dim(`Shard ${current}/${total}: no test files in this shard.`));
      process.exit(0);
    }
    shardMessage = `Shard ${current}/${total}: running ${testFiles.length} file(s)`;
  }

  // Re-exec under tsx if we have TypeScript test files and haven't already
  if (needsTsx(testFiles) && !args.tsxReexec) {
    const forwardArgs = process.argv.slice(2).filter((a) => a !== '--__tsx-reexec');
    reExecWithTsx(forwardArgs);
    return;
  }

  // Retry-only video/trace modes start no recorder on attempt 0, so with
  // `retries: 0` they can never produce an artifact. Warn at run start —
  // one line per misconfigured project and artifact — rather than letting
  // the run silently record nothing (PILOT-240; same caveat Playwright
  // documents for its `on-first-retry` video mode). Placed after the tsx
  // re-exec so each warning prints exactly once.
  for (const project of projects) {
    const cfg = project.effectiveConfig;
    if (cfg.retries > 0) continue;
    const scope = projects.length > 1 ? ` in project "${project.name}"` : '';
    for (const [artifact, mode] of [
      ['video', resolveVideoConfig(cfg.video).mode],
      ['trace', resolveTraceConfig(cfg.trace).mode],
    ] as const) {
      if (recordsOnlyOnRetry(mode)) {
        console.error(yellow(
          `Warning: ${artifact} mode '${mode}' only records retry attempts, but retries is 0${scope} — no ${artifact} will ever be recorded. Set retries to 1 or more to get ${artifact}s.`,
        ));
      }
    }
  }

  // Initialize reporters
  const reporters = await createReporters(config.reporter);
  // Auto-add GitHub Actions reporter when running in GitHub Actions
  if (process.env.GITHUB_ACTIONS) {
    const hasGithub = reporters.some((r) => r.constructor.name === 'GitHubActionsReporter');
    if (!hasGithub) {
      const { GitHubActionsReporter } = await import('./reporters/github.js');
      reporters.push(new GitHubActionsReporter());
    }
  }
  // Auto-add blob reporter when sharding (for merge-reports)
  if (config.shard) {
    const hasBlob = reporters.some((r) => r.constructor.name === 'BlobReporter');
    if (!hasBlob) {
      const { BlobReporter } = await import('./reporters/blob.js');
      reporters.push(new BlobReporter());
    }
  }
  const reporter = new ReporterDispatcher(reporters);

  // Compute the effective parallelism BEFORE handing config to the reporter,
  // so reporters can correctly suppress file headings / show project tags
  // when buckets or per-project `workers:` push the actual concurrency above
  // the global `config.workers` value.
  const { allocateBucketWorkers, bucketizeProjects } = await import('./project.js');
  const budgetCap = isExplicitWorkers(config) ? config.workers : undefined;
  const allocation = allocateBucketWorkers(config.workers, bucketizeProjects(projects), budgetCap);
  const totalWorkers = [...allocation.values()].reduce((s, n) => s + n, 0);
  const maxFilesInAnyWave = Math.max(...projectWaves.map((wave) =>
    wave.reduce((sum, p) => sum + p.testFiles.length, 0),
  ));
  const effectiveWorkers = Math.min(totalWorkers, maxFilesInAnyWave);

  // Warn only when the irreducible minimum (one worker per active bucket)
  // exceeds the user's explicit --workers value. Per-project `workers:`
  // inflation is now capped by the budget, so this only fires when there
  // are genuinely more device buckets than workers.
  let workerPlanWarning: string | undefined;
  if (isExplicitWorkers(config) && totalWorkers > config.workers) {
    const activeBuckets = [...allocation.values()].filter((n) => n > 0).length;
    workerPlanWarning = `requested ${countLabel(config.workers, 'worker')}; running ${totalWorkers} because ${countLabel(activeBuckets, 'device target')} ${activeBuckets === 1 ? 'needs a worker' : 'need one each'}`;
  }

  // Reflect the effective parallelism on the config so reporters see the
  // real worker count. Downstream dispatcher paths pass `workers` explicitly,
  // so this mutation is safe.
  config.workers = totalWorkers;

  // Pick the first project's effective config as the initial setup target.
  // For single-bucket runs this is identical to the root config.
  const initialProject = projects.find((p) => p.testFiles.length > 0) ?? projects[0];
  const initialEffectiveConfig = initialProject.effectiveConfig;
  const shouldShowLaunchProgress = args.ui || !args.watch;
  printTapsmithBanner();
  if (shardMessage) console.log(dim(shardMessage));
  const launchProgress = shouldShowLaunchProgress
    ? new UiLaunchProgress(createUiLaunchSteps({
      config: initialEffectiveConfig,
      testFileCount: testFiles.length,
      workerCount: args.ui ? totalWorkers : effectiveWorkers,
      mode: args.ui ? 'ui' : 'test',
      projects: hasProjects ? projects : undefined,
      workerPlanWarning,
    }), {
      title: args.ui ? 'UI mode' : '',
    })
    : undefined;
  activeLaunchProgress = launchProgress;
  if (!launchProgress && workerPlanWarning) {
    process.stderr.write(`Note: ${workerPlanWarning}.\n`);
  }

  if (args.watch) {
    console.log(`\nStarting watch mode for ${testFiles.length} test file(s)...\n`);
  }

  // A selection filter (grep / grep-invert, at root or any project) is active.
  // When such a filter selects zero runnable tests — i.e. every discovered test
  // ends up skipped — that's a usage error (typically a typo'd pattern), not a
  // green run. The exit paths below fail loud rather than reporting success.
  const selectionFilterActive =
    config.grep !== undefined || config.grepInvert !== undefined ||
    (hasProjects && projects.some((p) => p.grep !== undefined || p.grepInvert !== undefined));
  const zeroMatchFilterMessage =
    'No tests ran: every selected test was filtered out. Check your --grep / --grep-invert pattern (it matches against the full "describe > test" name).';

  // ─── Parallel mode ───
  // UI and watch modes handle their own execution — skip the dispatcher path.
  // Fall back to sequential when parallelism wouldn't help — either there's
  // only one test file, or all files are in sequential waves (e.g. setup → dependent).
  if (!args.ui && !args.watch) {

    if (effectiveWorkers > 1) {
      // The dispatcher manages its own daemons — one per worker — each with
      // exclusive ADB access to its assigned device. No discovery daemon needed.
      const { runParallel } = await import('./dispatcher.js');
      const fullResult = await runParallel({
        config,
        reporter,
        testFiles,
        workers: totalWorkers,
        workerCap: budgetCap,
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
        launchProgress,
      });

      await reporter.onRunEnd(fullResult);
      const zeroMatch = selectionFilterActive
        && fullResult.tests.length > 0
        && fullResult.tests.every((t) => t.status === 'skipped');
      if (zeroMatch) console.error(red(zeroMatchFilterMessage));
      process.exit((fullResult.status === 'failed' || zeroMatch) ? 1 : 0);
    }
  }

  // ─── Sequential mode (workers: 1, default) ───
  let launchedEmulators: LaunchedEmulator[] = [];
  let client: TapsmithGrpcClient | undefined;
  let device: Device | undefined;
  let disposeActionProgressPrinter: (() => void) | undefined;
  let currentSequentialState: SequentialDeviceState | undefined;
  let resolvedAgentApk: string | undefined;
  let resolvedAgentTestApk: string | undefined;
  let resolvedIosXctestrun: string | undefined;
  let resolvedIosAppPath: string | undefined;
  let sequentialExitCode = 1;
  let sequentialErrorEscaping = false;
  const sequentialStart = Date.now();

  // Route a crash through teardown so we don't orphan the daemon + its
  // xcodebuild runner (PILOT-230). Mutually exclusive with the parallel
  // dispatcher path, so it won't double-install with runParallel's handlers.
  installSequentialFatalHandlers(config, () => currentSequentialState?.deviceSerial);

  // Detect heterogeneous device-targeting projects. When projects share a
  // single signature, sequential mode runs unchanged. When they differ,
  // we tear down + re-provision between projects.
  const uniqueSignatures = new Set(projects.map((p) => p.deviceSignature));
  const isMultiBucketSequential = uniqueSignatures.size > 1;
  // Hint about --workers only when:
  //   - plain `tapsmith test` (UI/watch already provision per bucket)
  //   - the user did not pass --workers explicitly
  //   - config.workers is 1 (so we'd otherwise tear down + re-provision between buckets)
  //   - NO project has an explicit `workers:` value (otherwise parallelism is already happening)
  const anyExplicitWorkers = projects.some((p) => typeof p.workers === 'number' && p.workers > 0);
  if (
    isMultiBucketSequential
    && config.workers === 1
    && args.workers === undefined
    && !args.ui
    && !args.watch
    && !anyExplicitWorkers
  ) {
    process.stderr.write(
      dim(`Multiple device targets detected (${uniqueSignatures.size}). Tip: pass --workers ${uniqueSignatures.size} to run them in parallel.\n`),
    );
  }

  try {
    try {
      currentSequentialState = await setupSequentialDevice(
        initialEffectiveConfig,
        args.forceInstall,
        initialProject.deviceSignature,
        launchProgress,
      );
    } catch (err) {
      launchProgress?.fail('primary-device', (err as Error).message);
      console.error(red((err as Error).message));
      sequentialExitCode = 1;
      return;
    }

    client = currentSequentialState.client;
    device = currentSequentialState.device;
    launchedEmulators = currentSequentialState.launchedEmulators;
    resolvedAgentApk = currentSequentialState.resolvedAgentApk;
    resolvedAgentTestApk = currentSequentialState.resolvedAgentTestApk;
    resolvedIosXctestrun = currentSequentialState.resolvedIosXctestrun;
    resolvedIosAppPath = currentSequentialState.resolvedIosAppPath;
    // Mirror the chosen device serial onto the root config so any code path
    // still reading from `config.device` (UI/watch handoff) sees it.
    config.device = currentSequentialState.deviceSerial;

    // ─── UI mode ───
    // If --ui is set, start the interactive UI server. It keeps the
    // daemon, emulator, and agent alive and serves a Preact SPA.
    // When workers > 1, the UI server manages its own daemons and workers.
    if (args.ui) {
      const { startUIServer } = await import('./ui-mode/ui-server.js');

      const uiScreenshotDir =
        config.screenshot !== 'never'
          ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
          : undefined;

      let uiDeviceSerials: string[] | undefined;
      let uiConfigByDevice: Map<string, import('./worker-protocol.js').SerializedConfig> | undefined;
      let uiBucketByDevice: Map<string, string> | undefined;
      let uiBucketByProject: Map<string, string> | undefined;
      let uiWorkersOverride: number | undefined;

      if (isMultiBucketSequential) {
        // Multi-device-target projects: provision per-bucket devices.
        const perBucket = await provisionPerProjectDevices(config, projects, budgetCap, launchProgress);
        uiDeviceSerials = perBucket.deviceSerials;
        uiConfigByDevice = perBucket.configByDevice;
        uiBucketByDevice = perBucket.bucketByDevice;
        uiBucketByProject = perBucket.bucketByProject;
        uiWorkersOverride = perBucket.deviceSerials.length;
        launchedEmulators = [...launchedEmulators, ...perBucket.launched];
      } else {
        const uiProvision = await provisionMultiWorkerDevices(config, 'UI mode', {
          quiet: !args.tsxReexec,
          progress: launchProgress,
        });
        uiDeviceSerials = uiProvision.deviceSerials;
        launchedEmulators = [...launchedEmulators, ...uiProvision.launched];
        if (uiDeviceSerials) uiWorkersOverride = config.workers;
      }
      // Every UI session runs through persistent workers. With one device the
      // single worker adopts the primary daemon/agent set up above, so the
      // server always gets a serial list to build workers from.
      if (!uiDeviceSerials || uiDeviceSerials.length === 0) {
        uiDeviceSerials = [config.device!];
        uiWorkersOverride = 1;
      }

      const uiServer = await startUIServer({
        config,
        configPath,
        device,
        client,
        deviceSerial: config.device!,
        daemonAddress: config.daemonAddress,
        testFiles,
        screenshotDir: uiScreenshotDir,
        launchedEmulators,
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
        workers: uiWorkersOverride,
        deviceSerials: uiDeviceSerials,
        configByDevice: uiConfigByDevice,
        bucketByDevice: uiBucketByDevice,
        bucketByProject: uiBucketByProject,
      }, {
        port: args.uiPort,
        devUrl: args.uiDevUrl ?? process.env.TAPSMITH_UI_DEV_URL,
        launchProgress,
      });

      // Keep alive until user exits
      const cleanupAndExit = () => {
        uiServer.close();
        if (spawnedDaemonProcess) {
          try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
        }
        process.exit(0);
      };
      process.on('SIGINT', cleanupAndExit);
      process.on('SIGTERM', cleanupAndExit);
      await new Promise<void>(() => { /* never resolves */ });
    }

    // ─── Watch mode ───
    // If --watch is set, hand off to the watch coordinator. It keeps the
    // daemon, emulator, and agent alive and re-runs tests on file changes.
    // The watch coordinator handles its own cleanup and never returns.
    if (args.watch) {
      const { runWatchMode } = await import('./watch.js');

      const watchScreenshotDir =
        config.screenshot !== 'never'
          ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
          : undefined;

      let watchDeviceSerials: string[] | undefined;
      let watchConfigByDevice: Map<string, import('./worker-protocol.js').SerializedConfig> | undefined;
      let watchBucketByDevice: Map<string, string> | undefined;
      let watchBucketByProject: Map<string, string> | undefined;
      let watchWorkersOverride: number | undefined;

      if (isMultiBucketSequential) {
        const perBucket = await provisionPerProjectDevices(config, projects, budgetCap);
        watchDeviceSerials = perBucket.deviceSerials;
        watchConfigByDevice = perBucket.configByDevice;
        watchBucketByDevice = perBucket.bucketByDevice;
        watchBucketByProject = perBucket.bucketByProject;
        watchWorkersOverride = perBucket.deviceSerials.length;
        launchedEmulators = [...launchedEmulators, ...perBucket.launched];
      } else {
        const watchProvision = await provisionMultiWorkerDevices(config, 'Watch mode', { quiet: !args.tsxReexec });
        watchDeviceSerials = watchProvision.deviceSerials;
        launchedEmulators = [...launchedEmulators, ...watchProvision.launched];
        if (watchDeviceSerials) watchWorkersOverride = config.workers;
      }

      await runWatchMode({
        config,
        device,
        client,
        deviceSerial: config.device!,
        daemonAddress: config.daemonAddress,
        testFiles,
        screenshotDir: watchScreenshotDir,
        launchedEmulators,
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
        workers: watchWorkersOverride,
        deviceSerials: watchDeviceSerials,
        configByDevice: watchConfigByDevice,
        bucketByDevice: watchBucketByDevice,
        bucketByProject: watchBucketByProject,
      });
      // runWatchMode never returns — exits via cleanup()
    }

    if (!args.ui && !args.watch) {
      launchProgress?.finish();
      reporter.onRunStart(config, testFiles.length);
      // Print live progress lines for slow device actions (app-state
      // save/restore, between-file resets, …) so long silent stretches are
      // visibly forward motion rather than a hang (PILOT-232). Installed
      // after launchProgress.finish() — startup has its own progress UI.
      disposeActionProgressPrinter = installActionProgressPrinter();
    }

    // Run tests
    const allResults: TestResult[] = [];
    const allSuites: SuiteResult[] = [];
    const setupDuration = Date.now() - sequentialStart;

    const screenshotDir =
      config.screenshot !== 'never'
        ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
        : undefined;

    let fileIndex = 0;
    const failedProjects = new Set<string>();
    const projectsWithFiles = projects.filter((p) => p.testFiles.length > 0);
    const showProjectHeaders = projectsWithFiles.length > 1;

    for (const wave of projectWaves) {
      for (const project of wave) {
        // Skip projects whose dependencies failed
        const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
        if (blockedBy) {
          console.log(dim(`Skipping project "${project.name}" — dependency "${blockedBy}" failed`));
          // Mark all tests in this project as skipped
          for (const file of project.testFiles) {
            reporter.onTestFileStart(file);
            const skippedResult: TestResult = {
              name: path.basename(file),
              fullName: path.basename(file),
              status: 'skipped',
              durationMs: 0,
              project: project.name,
            };
            allResults.push(skippedResult);
            reporter.onTestFileEnd(file, [skippedResult]);
          }
          failedProjects.add(project.name);
          continue;
        }

        let projectFailed = false;

        // ─── Per-project device switching ───
        // When this project's device signature differs from the currently
        // bound device, tear down the previous state and provision the
        // new device before running its files.
        if (project.testFiles.length > 0 && currentSequentialState
          && currentSequentialState.signature !== project.deviceSignature) {
          process.stdout.write(
            dim(`\nSwitching device for project "${project.name}" (target: ${project.deviceSignature.split('|').slice(0, 2).join(' ')})\n`),
          );
          teardownSequentialDevice(currentSequentialState);
          // Reset emulator tracking — the new state owns its own list
          launchedEmulators = [];
          try {
            currentSequentialState = await setupSequentialDevice(
              project.effectiveConfig,
              args.forceInstall,
              project.deviceSignature,
            );
          } catch (err) {
            console.error(red(`Failed to set up device for project "${project.name}": ${(err as Error).message}`));
            sequentialExitCode = 1;
            return;
          }
          client = currentSequentialState.client;
          device = currentSequentialState.device;
          launchedEmulators = currentSequentialState.launchedEmulators;
          resolvedAgentApk = currentSequentialState.resolvedAgentApk;
          resolvedAgentTestApk = currentSequentialState.resolvedAgentTestApk;
          resolvedIosXctestrun = currentSequentialState.resolvedIosXctestrun;
          resolvedIosAppPath = currentSequentialState.resolvedIosAppPath;
          // After switching, the launchConfiguredApp on first file is not
          // needed because setupSequentialDevice already launched the app.
          fileIndex = 0;
        }

        if (showProjectHeaders && project.testFiles.length > 0) {
          process.stdout.write(`\n${dim(`  ── Project: ${project.name} ──`)}\n`);
        }

        // Effective config for this project — only differs from root config
        // when projects override device-shaping fields via `use:`.
        const projectConfig = currentSequentialState?.effectiveConfig ?? config;

        for (const file of project.testFiles) {
          // The between-file app reset is the runner's job (declared policy,
          // recorded in the trace as fixture setup). The first file after a
          // device launch inherits that launch as its prepared state.
          const preparedDevice: PreparedState | undefined = fileIndex === 0
            ? { policy: { mode: 'clear', scope: 'file' }, preparedAt: Date.now(), durationMs: 0, source: 'startup launch' }
            : undefined;

          reporter.onTestFileStart(file);

          const projectGrepRe = normalizeGrep(project.grep);
          const projectGrepInvertRe = normalizeGrep(project.grepInvert);
          const suiteResult = await runTestFileWithRecovery(file, {
            config: projectConfig,
            device: device!,
            client: client!,
            screenshotDir,
            reporter,
            projectUseOptions: project.use,
            projectName: projectLabel(project),
            projectGrep: projectGrepRe.length > 0 ? projectGrepRe : undefined,
            projectGrepInvert: projectGrepInvertRe.length > 0 ? projectGrepInvertRe : undefined,
            preparedDevice,
            sessionContext: {
              label: `Device ${projectConfig.device}`,
              config: projectConfig,
              device: device!,
              client: client!,
              agentApkPath: resolvedAgentApk,
              agentTestApkPath: resolvedAgentTestApk,
              iosXctestrunPath: resolvedIosXctestrun,
              iosAppPath: resolvedIosAppPath,
              deviceSerial: projectConfig.device,
            },
          });

          const fileResults = collectResults(suiteResult);
          allResults.push(...fileResults);
          allSuites.push(suiteResult);

          reporter.onTestFileEnd(file, fileResults);
          fileIndex++;

          if (fileResults.some((r) => r.status === 'failed')) {
            projectFailed = true;
          }
        }

        if (projectFailed) {
          failedProjects.add(project.name);
        }
      }
    }

    const totalDurationMs = Date.now() - sequentialStart;
    const hasFailed = allResults.some((r) => r.status === 'failed');
    const fullResult: FullResult = {
      status: hasFailed ? 'failed' : 'passed',
      duration: totalDurationMs,
      setupDuration,
      tests: allResults,
      suites: allSuites,
    };
    await reporter.onRunEnd(fullResult);
    const zeroMatch = selectionFilterActive
      && allResults.length > 0
      && allResults.every((r) => r.status === 'skipped');
    if (zeroMatch) console.error(red(zeroMatchFilterMessage));
    sequentialExitCode = (hasFailed || zeroMatch) ? 1 : 0;
  } catch (err) {
    // Let main().catch own the exit for escaping errors. Its handler needs
    // async work (dynamic imports) before printing, so the exit timer in
    // the finally block below would kill the process before any error
    // message appears (PILOT-253).
    sequentialErrorEscaping = true;
    throw err;
  } finally {
    disposeActionProgressPrinter?.();
    device?.close();
    client?.close();
    if (spawnedDaemonProcess) {
      try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    }
    // Leave emulators running for reuse by the next run.
    preserveEmulatorsForReuse(launchedEmulators);
    // Defer process.exit so any pending error handlers (unhandledRejection
    // etc.) in the current microtask queue run first — process.exit() in a
    // finally block swallows them. Skipped when an error is escaping:
    // main().catch prints it and exits with code 1 itself.
    if (!sequentialErrorEscaping) {
      setTimeout(() => process.exit(sequentialExitCode), 0);
    }
  }
}

// ─── Infrastructure error recovery for single-worker mode ───

/**
 * Run a test file with automatic retry on infrastructure errors (agent
 * disconnection, gRPC unavailability, etc.). Mirrors the recovery logic
 * in worker-runner.ts for multi-worker mode.
 */
async function runTestFileWithRecovery(
  file: string,
  opts: {
    config: TapsmithConfig
    device: Device
    client: TapsmithGrpcClient
    screenshotDir: string | undefined
    reporter: ReporterDispatcher
    projectUseOptions?: Record<string, unknown>
    projectName?: string
    projectGrep?: RegExp[]
    projectGrepInvert?: RegExp[]
    sessionContext: import('./session-preflight.js').SessionPreflightContext
    preparedDevice?: PreparedState
  },
): Promise<SuiteResult> {
  const grep = normalizeGrep(opts.config.grep);
  const grepInvert = normalizeGrep(opts.config.grepInvert);
  let firstAttemptSuite: SuiteResult | undefined;
  let recoveredPrepared: PreparedState | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const suite = await runTestFile(file, {
        config: opts.config,
        device: opts.device,
        screenshotDir: opts.screenshotDir,
        reporter: opts.reporter,
        beforeEachTest: async (fullName) => {
          // Mirror the worker path: a recovery here relaunched the app, so any
          // beforeAll-established state (navigation, auth) is gone. Throw the
          // infra-shaped error so the file retries and beforeAll re-runs —
          // otherwise the test runs against the recovered app's home screen
          // and fails with a misleading assertion error.
          let recovered = false;
          let recoveryReason = '';
          await ensureSessionReady(
            opts.sessionContext,
            `before test ${fullName}`,
            undefined,
            {
              onRecovery: (err) => {
                recovered = true;
                recoveryReason = err instanceof Error ? err.message : String(err);
              },
            },
          );
          if (recovered) {
            const detail = recoveryReason ? `: ${recoveryReason}` : '';
            throw new Error(
              `session recovered during before test ${fullName}; retrying file so beforeAll hooks run against the recovered app${detail}`,
            );
          }
        },
        abortFileOnError: isRecoverableInfrastructureError,
        sessionContext: opts.sessionContext,
        resetCapabilities: opts.sessionContext.capabilities,
        // Only the first attempt can reuse the pre-launch state; a retry
        // follows a recovery relaunch, which is itself a fresh `clear`.
        preparedDevice: attempt === 1 ? opts.preparedDevice : recoveredPrepared,
        // In-process retries need the same ESM cache busting as worker
        // retries; otherwise import() returns the cached module and the
        // retry registers no tests.
        bustImportCache: attempt > 1,
        projectUseOptions: opts.projectUseOptions,
        projectName: opts.projectName,
        grep: grep.length > 0 ? grep : undefined,
        grepInvert: grepInvert.length > 0 ? grepInvert : undefined,
        projectGrep: opts.projectGrep,
        projectGrepInvert: opts.projectGrepInvert,
      });
      const fileResults = collectResults(suite);
      const infraFailure = fileResults.find(
        (r) => r.status === 'failed' && r.error && isRecoverableInfrastructureError(r.error),
      );
      if (!infraFailure) {
        // If this is a retry that produced fewer results than the first
        // attempt (e.g. crashed before running any tests), prefer the
        // first attempt's results so the original failure is visible.
        if (attempt === 2 && firstAttemptSuite) {
          const firstResults = collectResults(firstAttemptSuite);
          if (fileResults.length < firstResults.length) {
            return firstAttemptSuite;
          }
          // Tests that failed on the discarded first attempt must surface as
          // flaky, not as clean passes — the summary would otherwise hide
          // that the file was re-run at all.
          markFileRetryFlakes(firstAttemptSuite, suite);
        }
        return suite;
      }
      if (attempt === 2) {
        return suite;
      }
      firstAttemptSuite = suite;
      process.stderr.write(
        dim(`Recovering session after infrastructure error in ${path.basename(file)}: ${infraFailure.error?.message ?? 'unknown'}\n`),
      );
      recoveredPrepared = await launchConfiguredApp(opts.sessionContext, `recovery for ${path.basename(file)}`);
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) {
        // If the retry itself crashed, return the first attempt's results
        // (which contain the original failure) so it's counted in the summary.
        if (firstAttemptSuite) return firstAttemptSuite;
        throw err;
      }
      process.stderr.write(
        dim(`Recovering session after infrastructure error in ${path.basename(file)}: ${err instanceof Error ? err.message : err}\n`),
      );
      recoveredPrepared = await launchConfiguredApp(opts.sessionContext, `recovery for ${path.basename(file)}`);
    }
  }
  // Unreachable — loop always returns or throws
  throw new Error(`Exhausted recovery attempts for ${path.basename(file)}`);
}

main().catch(async (err) => {
  // If a SIGINT/SIGTERM handler is already in the middle of shutting down
  // the dispatcher, swallow the resulting "All workers became unavailable"
  // rejection — it's a consequence of our own cleanup, not a real failure.
  // The dispatcher's scheduleShutdownExit will exit the process with the
  // correct signal code momentarily.
  try {
    const { isDispatcherShuttingDown } = await import('./dispatcher.js');
    if (isDispatcherShuttingDown()) return;
  } catch { /* dispatcher not loaded — fall through */ }

  activeLaunchProgress?.finish();
  activeLaunchProgress = undefined;

  let isLaunchFailure = false;
  try {
    const { isLaunchSetupError } = await import('./dispatcher.js');
    isLaunchFailure = isLaunchSetupError(err);
  } catch { /* dispatcher not loaded — fall through */ }

  const message = err instanceof Error ? err.message : String(err);
  if (isLaunchFailure) {
    const [summary, ...detailLines] = message.split('\n');
    console.error(red(`Test run failed to start: ${summary}`));
    const details = detailLines.join('\n').trim();
    if (details) console.error(dim(details));
    if (process.env.TAPSMITH_DEBUG || process.env.DEBUG) {
      console.error((err as Error)?.stack ?? err);
    }
    process.exit(1);
  }

  console.error(red(`Fatal error: ${message}`));
  console.error((err as Error)?.stack ?? err);
  process.exit(1);
});
