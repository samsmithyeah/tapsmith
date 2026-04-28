#!/usr/bin/env node

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
import { loadConfig, resolveDeviceStrategy, EXPLICIT_WORKERS, isExplicitWorkers, type TapsmithConfig } from './config.js';
import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults, type TestResult, type SuiteResult } from './runner.js';
import { createReporters, ReporterDispatcher, type FullResult } from './reporter.js';
import { ensureSessionReady, launchConfiguredApp } from './session-preflight.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import { glob } from 'glob';
import { resolveTraceConfig, isNetworkTracingEnabled, networkHostsForPac } from './trace/types.js';
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
import { isRecoverableInfrastructureError } from './worker-protocol.js';
import { findPidsOnPort, freeStaleAgentPort } from './port-utils.js';
import { findDaemonBin } from './daemon-bin.js';

// ─── ANSI helpers ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

function warnSequentialUnhealthyDevices(devices: DeviceHealthResult[]): void {
  for (const device of devices) {
    process.stderr.write(
      `${YELLOW}Skipping unhealthy device ${device.serial}: ${device.reason ?? 'unknown health check failure'}.${RESET}\n`,
    );
  }
}

function warnSequentialSkippedDevices(devices: Array<{ serial: string; reason: string }>): void {
  for (const device of devices) {
    process.stderr.write(
      `${YELLOW}Skipping device ${device.serial}: ${device.reason}.${RESET}\n`,
    );
  }
}

// ─── Version ───

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../package.json');
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
  const tapsmithPkgDir = path.resolve(__dirname, '..');
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

  if (tryAdb()) return;

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

async function ensureDaemonRunning(address: string, daemonBin?: string, platform?: string): Promise<TapsmithGrpcClient> {
  const port = address.split(':').pop() ?? '50051';

  // When TAPSMITH_REUSE_DAEMON is set (e.g. from MCP server's tapsmith_run_tests),
  // connect to the existing daemon without killing it. This avoids destroying
  // a daemon owned by UI mode or another long-lived session.
  if (process.env.TAPSMITH_REUSE_DAEMON) {
    const client = new TapsmithGrpcClient(address);
    const alive = await client.waitForReady(5_000);
    if (alive) {
      console.log(dim(`Connected to existing Tapsmith daemon v${(await client.ping()).version}`));
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
  freeStaleAgentPort(18700);

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

  // Wait for daemon to be ready
  const newClient = new TapsmithGrpcClient(address);
  const started = await newClient.waitForReady(10_000);
  if (!started) {
    console.error(red('Failed to start Tapsmith daemon. Is tapsmith-core installed?'));
    process.exit(1);
  }

  console.log(dim(`Connected to Tapsmith daemon v${(await newClient.ping()).version}`));
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
): Promise<SequentialDeviceState> {
  const target = await ensureSequentialTargetDevice(cfg);
  const launchedEmulators = target.launched;

  if (!target.selectedSerial) {
    throw new Error(
      'No online devices found. Connect a device, start an emulator, or set `avd` in your config to auto-launch emulators.',
    );
  }

  cfg.device = target.selectedSerial;

  // Pre-flight: verify device is responsive before doing anything slow (Android only)
  if (cfg.platform !== 'ios') {
    await checkDeviceHealth(cfg.device);
  }

  const client = await ensureDaemonRunning(cfg.daemonAddress, cfg.daemonBin, cfg.platform);
  const device = new Device(client, cfg);

  // Tell the daemon whether this session intends to capture network traffic.
  // When false, the daemon skips every physical-iOS MITM/OCSP pre-arm code
  // path — the biggest single basic-track failure-surface reduction.
  // When true, we also pass the host-glob allowlist through so the daemon
  // can embed it in the PAC script served at `/tapsmith.pac`.
  const networkTracingEnabled = isNetworkTracingEnabled(cfg.trace);
  const pacNetworkHosts = networkHostsForPac(cfg.trace);

  try {
    await device.setDevice(cfg.device, networkTracingEnabled, pacNetworkHosts);
    console.log(dim(`Using device: ${cfg.device}`));
  } catch (err) {
    throw new Error(`Failed to set device: ${err}`);
  }

  const deviceJustLaunched = launchedEmulators.some((e) => e.serial === cfg.device);

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

  if (cfg.platform === 'ios') {
    if (cfg.app && cfg.device) {
      try {
        const resolvedApp = resolvedIosAppPath!;
        if (targetIsPhysical) {
          const { installAppOnDevice, isAppInstalledOnDevice } = await import('./ios-devicectl.js');
          const alreadyInstalled = !deviceJustLaunched
            && cfg.package
            && (await isAppInstalledOnDevice(cfg.device, cfg.package));
          if (alreadyInstalled && !forceInstall) {
            console.log(dim(`App ${cfg.package} already installed on device, skipping install. Use --force-install to reinstall.`));
          } else {
            if (alreadyInstalled) {
              console.log(dim(`Reinstalling iOS app on device: ${path.basename(resolvedApp)}`));
            }
            await installAppOnDevice(cfg.device, resolvedApp);
            console.log(dim(`Installed ${path.basename(resolvedApp)} on iOS device ${cfg.device}.`));
          }
        } else {
          const { installApp, isAppInstalled } = await import('./ios-simulator.js');
          const alreadyInstalled = !deviceJustLaunched
            && cfg.package
            && isAppInstalled(cfg.device, cfg.package);
          if (alreadyInstalled && !forceInstall) {
            console.log(dim(`App ${cfg.package} already installed, skipping iOS app install. Use --force-install to reinstall.`));
          } else {
            if (alreadyInstalled) {
              console.log(dim(`Reinstalling iOS app: ${path.basename(resolvedApp)}`));
            }
            installApp(cfg.device, resolvedApp);
            console.log(dim(`Installed ${path.basename(resolvedApp)} on iOS simulator.`));
          }
        }
      } catch (err) {
        throw new Error(`Failed to install iOS app: ${err}`);
      }
    }
    if (cfg.package && cfg.device) {
      // For simulators we fire a best-effort simctl launch so the app is in
      // the foreground when the XCUITest runner attaches, which avoids a
      // brief black-screen flicker. For physical devices we skip this step
      // entirely: `simctl launch` doesn't work on real hardware, and the
      // XCUITest runner's own `app.launch()` (inside the Swift agent) will
      // bring the app forward during the subsequent agent startup.
      if (!targetIsPhysical) {
        try {
          execFileSync('xcrun', ['simctl', 'launch', cfg.device, cfg.package]);
          console.log(dim(`Launched ${cfg.package} on iOS simulator.`));
        } catch {
          // App may already be running
        }
      }
    }
  } else {
    try {
      await device.wake();
      await device.unlock();
      console.log(dim('Device screen unlocked.'));
    } catch {
      // Non-fatal — device might already be awake/unlocked
    }

    if (cfg.apk) {
      const isInstalled = !deviceJustLaunched
        && cfg.package
        && cfg.device
        && isPackageInstalled(cfg.device, cfg.package);

      if (isInstalled && !forceInstall) {
        console.log(dim(`App ${cfg.package} already installed, skipping APK install. Use --force-install to reinstall.`));
      } else {
        const resolvedApk = path.resolve(cfg.rootDir, cfg.apk);
        try {
          if (isInstalled) {
            console.log(dim(`Reinstalling app APK: ${path.basename(resolvedApk)}`));
          }
          await device.installApk(resolvedApk);
          if (cfg.package && cfg.device) {
            await waitForPackageIndexed(cfg.device, cfg.package);
          }
          console.log(dim(`Installed app APK: ${path.basename(resolvedApk)}`));
        } catch (err) {
          throw new Error(`Failed to install app APK: ${err}`);
        }
      }
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
      console.log(dim('Enabled adb root for network capture.'));
    }
  }

  const resolvedAgentApk = cfg.agentApk
    ? path.resolve(cfg.rootDir, cfg.agentApk)
    : findAgentApk();
  const resolvedAgentTestApk = cfg.agentTestApk
    ? path.resolve(cfg.rootDir, cfg.agentTestApk)
    : findAgentTestApk();
  let resolvedIosXctestrun = cfg.iosXctestrun
    ? path.resolve(cfg.rootDir, cfg.iosXctestrun)
    : undefined;
  // iOS xctestrun auto-detect: if the user didn't set `iosXctestrun`,
  // pick the newest built xctestrun for the target slice. Mirrors the way
  // `simulator: "iPhone 16"` is enough to pick a device without hand-rolling
  // JSON parsing in the config.
  //   - Physical devices: look under `<rootDir>/ios-agent/.build-device/…`
  //     (populated by `tapsmith build-ios-agent`).
  //   - Simulators: look under `~/Library/Developer/Xcode/DerivedData/TapsmithAgent-*`
  //     (populated by the simulator `xcodebuild build-for-testing` command).
  if (!resolvedIosXctestrun && cfg.platform === 'ios') {
    const { findDeviceXctestrun, findSimulatorXctestrun } =
      await import('./ios-device-resolve.js');
    if (targetIsPhysical) {
      const found = findDeviceXctestrun(cfg.rootDir);
      if (found) {
        resolvedIosXctestrun = found;
        console.log(dim(`Auto-detected iOS device xctestrun: ${path.relative(cfg.rootDir, found)}`));
      } else {
        throw new Error(
          'No device xctestrun found under ios-agent/.build-device. ' +
            'Run `tapsmith build-ios-agent` first, or set `iosXctestrun` explicitly.',
        );
      }
    } else {
      const found = findSimulatorXctestrun();
      if (found) {
        resolvedIosXctestrun = found;
        console.log(dim(`Auto-detected iOS simulator xctestrun: ${found}`));
      } else {
        throw new Error(
          'No simulator xctestrun found under ~/Library/Developer/Xcode/DerivedData/TapsmithAgent-*. ' +
            'Build the simulator agent first (see docs/ios-physical-devices.md for the command) ' +
            'or set `iosXctestrun` explicitly.',
        );
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
      if (warning) console.log(`  \x1b[33m⚠\x1b[0m ${warning}`);
    }
  }

  try {
    if (cfg.platform === 'ios') {
      console.log(dim(`Starting iOS agent (xctestrun: ${resolvedIosXctestrun ? 'set' : 'NOT SET'})`));
    }
    await device.startAgent(
      cfg.package ?? '',
      resolvedAgentApk,
      resolvedAgentTestApk,
      resolvedIosXctestrun,
      // Only cache the app path on physical iOS — the daemon uses it for
      // reinstall-based clearAppData. Simulators keep the host-filesystem
      // app-container clearing path instead.
      cfg.platform === 'ios' && targetIsPhysical ? resolvedIosAppPath : undefined,
      networkTracingEnabled,
    );
    if (cfg.platform !== 'ios') {
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
    console.log(dim('Agent connected.'));
  } catch (err) {
    throw new Error(`Failed to start agent: ${err}`);
  }

  if (cfg.package) {
    try {
      await launchConfiguredApp({
        label: `Device ${cfg.device}`,
        config: cfg,
        device,
        client,
        agentApkPath: resolvedAgentApk,
        agentTestApkPath: resolvedAgentTestApk,
        iosXctestrunPath: resolvedIosXctestrun,
        deviceSerial: cfg.device,
      }, 'startup');
      console.log(dim(`Launched ${cfg.package}`));
    } catch (err) {
      throw new Error(`Failed to launch app: ${err}`);
    }
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

// ─── Test file discovery ───

async function discoverTestFiles(
  patterns: string[],
  rootDir: string,
  explicitFiles?: string[],
  extraIgnore?: string[],
): Promise<string[]> {
  if (explicitFiles && explicitFiles.length > 0) {
    return explicitFiles.map((f) => path.resolve(rootDir, f));
  }

  const ignore = ['**/node_modules/**', '**/dist/**', ...(extraIgnore ?? [])];
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      absolute: true,
      ignore,
    });
    files.push(...matches);
  }

  return [...new Set(files)].sort();
}

function listConnectedDeviceSerials(): string[] {
  return listAdbDevices()
    .filter((d) => d.state === 'device')
    .map((d) => d.serial);
}

async function ensureSequentialTargetDevice(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<{ selectedSerial?: string; launched: LaunchedEmulator[] }> {
  if (config.device) {
    // If the device is an iOS simulator that's already booted, log reuse
    if (config.platform === 'ios') {
      const { listBootedSimulators } = await import('./ios-simulator.js');
      const booted = listBootedSimulators();
      const sim = booted.find((s) => s.udid === config.device);
      if (sim) {
        process.stderr.write(
          `${DIM}Reusing simulator ${sim.udid} (${sim.name}) from previous run.${RESET}\n`,
        );
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
        process.stderr.write(`${DIM}Auto-detected physical iOS device ${udid}.${RESET}\n`);
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
      process.stderr.write(
        `${DIM}Cleaned up ${staleResult.killed.length} stale simulator(s).${RESET}\n`,
      );
    }

    // Check for already-booted simulators
    const booted = listBootedSimulators();
    const matching = booted.find((s) => s.name === simulatorName || s.udid === simulatorName);
    if (matching) {
      process.stderr.write(
        `${DIM}Reusing simulator ${matching.udid} (${matching.name}) from previous run.${RESET}\n`,
      );
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
    process.stderr.write(
      `${YELLOW}Cleared stale offline emulator transport ${serial} before device selection.${RESET}\n`,
    );
  }

  // Reclaim healthy emulators from previous runs, kill unhealthy ones.
  // cleanupStaleEmulators logs details about each action internally.
  const staleResult = cleanupStaleEmulators(config.avd);
  if (staleResult.killed.length > 0) {
    process.stderr.write(
      `${DIM}Cleaned up ${staleResult.killed.length} stale emulator(s).${RESET}\n`,
    );
  }

  const deviceStrategy = resolveDeviceStrategy(config);
  const onlineSerials = listConnectedDeviceSerials();
  const prefilteredOnline = prefilterDevicesForStrategy(
    onlineSerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(prefilteredOnline.skippedDevices);
  const healthyOnline = filterHealthyDevices(prefilteredOnline.candidateSerials);
  warnSequentialUnhealthyDevices(healthyOnline.unhealthyDevices);
  const selectedOnline = selectDevicesForStrategy(
    healthyOnline.healthySerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(
    selectedOnline.skippedDevices.filter(
      (device) => !prefilteredOnline.skippedDevices.some((prefiltered) => prefiltered.serial === device.serial),
    ),
  );

  if (selectedOnline.selectedSerials.length > 0) {
    return { selectedSerial: selectedOnline.selectedSerials[0], launched: [] };
  }

  if (!config.launchEmulators) {
    return { selectedSerial: undefined, launched: [] };
  }

  const provision = await provisionEmulators({
    existingSerials: [],
    occupiedSerials: onlineSerials,
    workers: 1,
    avd: config.avd,
  });
  const healthyProvisioned = filterHealthyDevices(provision.allSerials);
  warnSequentialUnhealthyDevices(healthyProvisioned.unhealthyDevices);
  const selectedProvisioned = selectDevicesForStrategy(
    healthyProvisioned.healthySerials,
    deviceStrategy,
    config.avd,
  );
  warnSequentialSkippedDevices(selectedProvisioned.skippedDevices);

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
  watch: boolean;
  ui: boolean;
  uiPort?: number;
  uiDevUrl?: string;
  config?: string;
  forceInstall: boolean;
  version: boolean;
  help: boolean;
  tsxReexec: boolean;
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
        || arg === 'configure-ios-network'
        || arg === 'refresh-ios-network'
        || arg === 'verify-ios-network'
        || arg === 'list-devices'
        || arg === 'mcp-server'
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
  opts?: { quiet?: boolean },
): Promise<{ deviceSerials: string[] | undefined; launched: LaunchedEmulator[] }> {
  let launched: LaunchedEmulator[] = [];
  if (config.workers <= 1) return { deviceSerials: undefined, launched };

  let serials: string[];
  if (config.platform === 'ios') {
    const { listCompatibleBootedSimulators, provisionSimulators, cleanupStaleSimulators } = await import('./ios-simulator.js');
    let reusableUdids: string[] = [];
    if (config.simulator) {
      const staleResult = cleanupStaleSimulators(config.simulator);
      reusableUdids = staleResult.reusable;
    }
    const compatible = listCompatibleBootedSimulators(config.device!);
    const others = compatible.filter((s) => s.udid !== config.device).slice(0, config.workers - 1);
    for (const sim of others) {
      process.stderr.write(
        `${DIM}Reusing simulator ${sim.udid} (${sim.name}) from previous run.${RESET}\n`,
      );
    }
    serials = [config.device!, ...others.map((s) => s.udid)].filter(Boolean);

    if (serials.length < config.workers && config.simulator) {
      const provision = provisionSimulators({
        simulatorName: config.simulator,
        workers: config.workers,
        existingUdids: serials,
        appPath: config.app ? path.resolve(config.rootDir, config.app) : undefined,
        reusableUdids,
      });
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
      });
      launched = provision.launched;
      serials = provision.allSerials;
    }
  }

  if (serials.length < 2) {
    if (!opts?.quiet) {
      process.stderr.write(
        `${YELLOW}Only ${serials.length} device(s) available. ${modeName} needs 2+ devices for parallel. Using single-worker mode.${RESET}\n`,
      );
    }
    return { deviceSerials: undefined, launched };
  }

  return { deviceSerials: serials, launched };
}

interface PerProjectProvisionResult {
  deviceSerials: string[]
  configByDevice: Map<string, import('./worker-protocol.js').SerializedConfig>
  bucketByDevice: Map<string, string>
  bucketByProject: Map<string, string>
  launched: LaunchedEmulator[]
}

/**
 * Build a SerializedConfig from a TapsmithConfig (a per-bucket effective config).
 */
function buildSerializedConfig(cfg: TapsmithConfig): import('./worker-protocol.js').SerializedConfig {
  return {
    timeout: cfg.timeout,
    retries: cfg.retries,
    screenshot: cfg.screenshot,
    rootDir: cfg.rootDir,
    outputDir: cfg.outputDir,
    apk: cfg.apk,
    activity: cfg.activity,
    package: cfg.package,
    agentApk: cfg.agentApk,
    agentTestApk: cfg.agentTestApk,
    trace: typeof cfg.trace === 'string' || typeof cfg.trace === 'object'
      ? cfg.trace
      : undefined,
    platform: cfg.platform,
    app: cfg.app,
    iosXctestrun: cfg.iosXctestrun,
    simulator: cfg.simulator,
    resetAppDeepLink: cfg.resetAppDeepLink,
    resetAppWaitMs: cfg.resetAppWaitMs,
  };
}

/**
 * Provision devices for a single bucket using its effective config and a
 * fixed worker count. Returns the device serials successfully provisioned
 * (may be fewer than requested if hardware constraints prevent it).
 */
async function provisionDevicesForBucket(
  effectiveConfig: TapsmithConfig,
  desiredWorkers: number,
): Promise<{ serials: string[]; launched: LaunchedEmulator[] }> {
  if (desiredWorkers <= 0) return { serials: [], launched: [] };

  if (effectiveConfig.platform === 'ios') {
    // Physical-device bucket: no `simulator` set → resolve a paired USB
    // device. Parallel workers against one physical device aren't
    // supported, so we always return a single serial here regardless of
    // desiredWorkers; the caller's worker allocation is capped elsewhere.
    if (!effectiveConfig.simulator) {
      if (effectiveConfig.device) {
        return { serials: [effectiveConfig.device], launched: [] };
      }
      const { resolvePhysicalIosDevice } = await import('./ios-device-resolve.js');
      try {
        const udid = resolvePhysicalIosDevice();
        return { serials: [udid], launched: [] };
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

    // Find any already-booted matching simulators (no primary required)
    const booted = listBootedSimulators().filter(
      (s) => s.name === effectiveConfig.simulator || s.udid === effectiveConfig.simulator,
    );
    const existing = booted.map((s) => s.udid).slice(0, desiredWorkers);

    if (existing.length >= desiredWorkers) {
      return { serials: existing, launched: [] };
    }

    const provision = provisionSimulators({
      simulatorName: effectiveConfig.simulator,
      workers: desiredWorkers,
      existingUdids: existing,
      appPath: effectiveConfig.app
        ? path.resolve(effectiveConfig.rootDir, effectiveConfig.app)
        : undefined,
      reusableUdids,
    });
    return { serials: provision.allUdids, launched: [] };
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
    return { serials, launched: [] };
  }

  if (!effectiveConfig.launchEmulators) {
    return { serials, launched: [] };
  }

  const provision = await provisionEmulators({
    existingSerials: serials,
    occupiedSerials: allConnected,
    workers: desiredWorkers,
    avd: effectiveConfig.avd,
  });
  const healthyLaunched = filterHealthyDevices(provision.allSerials);
  const selectedAfter = selectDevicesForStrategy(
    healthyLaunched.healthySerials,
    deviceStrategy,
    effectiveConfig.avd,
  );
  serials = selectedAfter.selectedSerials.slice(0, desiredWorkers);
  return { serials, launched: provision.launched };
}

/**
 * Provision devices per project bucket. Each bucket (set of projects sharing
 * a deviceSignature) gets its own devices and serialized config. Used by
 * UI mode and watch mode to support multi-device-target projects.
 */
async function provisionPerProjectDevices(
  rootConfig: TapsmithConfig,
  projects: import('./project.js').ResolvedProject[],
): Promise<PerProjectProvisionResult> {
  const result: PerProjectProvisionResult = {
    deviceSerials: [],
    configByDevice: new Map(),
    bucketByDevice: new Map(),
    bucketByProject: new Map(),
    launched: [],
  };

  const { allocateBucketWorkers, bucketizeProjects } = await import('./project.js');
  const bucketEntries = bucketizeProjects(projects);
  for (const b of bucketEntries) {
    for (const p of b.projects) {
      result.bucketByProject.set(p.name, b.signature);
    }
  }

  // Allocate workers across buckets
  const allocation = allocateBucketWorkers(rootConfig.workers, bucketEntries);

  // Provision each bucket's devices in parallel — Android emulators and
  // iOS simulators both have multi-second cold-start costs, and there's
  // no cross-bucket dependency. Preserves per-bucket ordering in the
  // aggregated result by collecting into position-indexed slots.
  const tasks = bucketEntries.map(async ({ signature, projects: bucketProjects }) => {
    const desiredWorkers = allocation.get(signature) ?? 0;
    if (desiredWorkers === 0) return null;

    const bucketEffective = bucketProjects[0].effectiveConfig;
    const provisioned = await provisionDevicesForBucket(bucketEffective, desiredWorkers);

    if (provisioned.serials.length === 0) {
      throw new Error(
        `Failed to provision any devices for bucket "${signature.split('|').slice(0, 2).join(' ')}".`,
      );
    }
    if (provisioned.serials.length < desiredWorkers) {
      process.stderr.write(
        `${YELLOW}Bucket "${bucketProjects.map((p) => p.name).join(',')}" requested ${desiredWorkers} workers but only ${provisioned.serials.length} device(s) could be provisioned.${RESET}\n`,
      );
    }

    return { signature, bucketEffective, provisioned };
  });

  const outcomes = await Promise.all(tasks);

  for (const outcome of outcomes) {
    if (!outcome) continue;
    const { signature, bucketEffective, provisioned } = outcome;
    result.launched.push(...provisioned.launched);
    const bucketSerialized = buildSerializedConfig(bucketEffective);
    for (const serial of provisioned.serials) {
      result.deviceSerials.push(serial);
      result.configByDevice.set(serial, bucketSerialized);
      result.bucketByDevice.set(serial, signature);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
${bold('tapsmith')} — Mobile app testing framework

${bold('Usage:')}
  tapsmith test [files...]           Run test files
  tapsmith test --watch              Watch test files and re-run on change
  tapsmith test --ui                 Open interactive UI mode
  tapsmith test --ui --ui-port 8080  UI mode on specific port
  tapsmith test --device <serial>    Target specific device/simulator
  tapsmith test --workers <n>        Run tests in parallel across n devices
  tapsmith test --shard=x/y          Run shard x of y (for CI)
  tapsmith test --trace <mode>       Record traces (on, retain-on-failure, etc.)
  tapsmith show-trace <file.zip>     Open trace viewer in browser
  tapsmith show-report [dir]         Open HTML test report
  tapsmith merge-reports [dir]       Merge blob reports from sharded runs
  tapsmith list-devices              List connected devices (Android, iOS sim, iOS physical)
  tapsmith list-devices --json       Same, as JSON for scripting
  tapsmith setup-ios                 First-run setup for iOS network capture (macOS only)
  tapsmith setup-ios-device          Preflight checklist for physical iOS device testing
  tapsmith build-ios-agent           Build the signed TapsmithAgent runner for physical iOS devices
  tapsmith configure-ios-network <udid>   Generate a network capture profile (.mobileconfig) for a physical iOS device
  tapsmith refresh-ios-network <udid>     Regenerate the network capture profile after a host Wi-Fi change
  tapsmith verify-ios-network <udid>      Verify decrypted HTTPS capture is working on a physical iOS device
  tapsmith init                      Initialize a new Tapsmith project (interactive wizard)
  tapsmith doctor                    Check system health and dependencies
  tapsmith mcp-server                Run MCP server for LLM/agent integration (stdio transport)
  tapsmith --version                 Print version
  tapsmith --help                    Show this help

${bold('Options:')}
  -w, --watch              Watch test files and re-run on change
  -d, --device <serial>    Target a specific device or simulator by serial/UDID
  -j, --workers <n>        Number of parallel workers (default: 1)
  --shard=x/y              Split tests across CI machines (e.g. --shard=1/4)
  --trace <mode>           Trace mode: off, on, on-first-retry, on-all-retries,
                           retain-on-failure, retain-on-first-failure
  -c, --config <path>      Path to config file (default: tapsmith.config.ts)
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
    'configure-ios-network',
    'refresh-ios-network',
    'verify-ios-network',
  ]);

  if (args.help && !(args.command && subcommandsWithOwnHelp.has(args.command))) {
    printHelp();
    return;
  }
  if (!args.command) {
    printHelp();
    return;
  }

  if (args.command === 'show-report') {
    const reportDir = args.files[0] ?? 'tapsmith-report';
    const reportPath = path.resolve(process.cwd(), reportDir, 'index.html');
    if (!fs.existsSync(reportPath)) {
      console.error(red(`No report found at ${reportPath}`));
      process.exit(1);
    }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [reportPath], { detached: true, stdio: 'ignore' }).unref();
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
      const server = await showTrace({ tracePath: traceFile });
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
    const reporters = await createReporters(config.reporter ?? 'list');
    const dispatcher = new ReporterDispatcher(reporters);
    dispatcher.onRunStart(config, 0);
    await dispatcher.onRunEnd(result);
    return;
  }

  if (args.command === 'list-devices') {
    const { runListDevices } = await import('./list-devices.js');
    const forwardedArgv = process.argv.slice(process.argv.indexOf('list-devices') + 1)
      .filter((a) => a !== '--__tsx-reexec');
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
    const forwardedArgv = process.argv.slice(process.argv.indexOf('configure-ios-network') + 1)
      .filter((a) => a !== '--__tsx-reexec');
    await runConfigureIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'refresh-ios-network') {
    const { runRefreshIosNetwork } = await import('./configure-ios-network.js');
    const forwardedArgv = process.argv.slice(process.argv.indexOf('refresh-ios-network') + 1)
      .filter((a) => a !== '--__tsx-reexec');
    await runRefreshIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'verify-ios-network') {
    const { runVerifyIosNetwork } = await import('./verify-ios-network.js');
    const forwardedArgv = process.argv.slice(process.argv.indexOf('verify-ios-network') + 1)
      .filter((a) => a !== '--__tsx-reexec');
    await runVerifyIosNetwork(forwardedArgv);
    return;
  }

  if (args.command === 'build-ios-agent') {
    const { runBuildIosAgent } = await import('./build-ios-agent.js');
    // Everything after the subcommand name is forwarded; drop the verb.
    const forwardedArgv = process.argv.slice(process.argv.indexOf('build-ios-agent') + 1)
      .filter((a) => a !== '--__tsx-reexec');
    await runBuildIosAgent(forwardedArgv);
    return;
  }

  if (args.command === 'init') {
    const { runInit } = await import('./init.js');
    await runInit();
    return;
  }

  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    await runDoctor();
    return;
  }

  if (args.command === 'mcp-server') {
    const { runMcpServer } = await import('./mcp/index.js');
    await runMcpServer();
    return;
  }

  if (args.command !== 'test') {
    console.error(red(`Unknown command: ${args.command}`));
    printHelp();
    process.exit(1);
  }

  // Load config
  const config = await loadConfig(undefined, args.config);
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
  const { resolveProjects, topologicalSort, collectTransitiveDeps, findProjectForFile } = await import('./project.js');
  const hasProjects = config.projects && config.projects.length > 0;
  const hasExplicitFiles = args.files && args.files.length > 0;

  let projects: import('./project.js').ResolvedProject[];
  let projectWaves: import('./project.js').ResolvedProject[][];

  if (hasProjects && !hasExplicitFiles) {
    // Full project mode — discover all files per project
    projects = resolveProjects(config);
    projectWaves = topologicalSort(projects);
    for (const project of projects) {
      project.testFiles = await discoverTestFiles(project.testMatch, config.rootDir, undefined, project.testIgnore);
    }
  } else if (hasProjects && hasExplicitFiles) {
    // Explicit files with projects — auto-run dependencies
    const allProjects = resolveProjects(config);
    const explicitPaths = args.files.map((f: string) => path.resolve(config.rootDir, f));

    // Find which projects the explicit files belong to
    const targetProjectNames = new Set<string>();
    for (const filePath of explicitPaths) {
      const projectName = findProjectForFile(filePath, allProjects, config.rootDir);
      if (projectName) {
        targetProjectNames.add(projectName);
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
        // Only run the explicit files that belong to this project
        project.testFiles = explicitPaths.filter(
          (f: string) => findProjectForFile(f, [project], config.rootDir) === project.name,
        );
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

  // Apply sharding — deterministic split within each project. Projects that
  // are dependencies of other projects run in full on every shard (like setup).
  if (config.shard) {
    const { current, total } = config.shard;
    if (hasProjects) {
      // Find projects that are depended on by others — these must not be sharded
      const depTargets = new Set(projects.flatMap((p) => p.dependencies));
      for (const project of projects) {
        if (depTargets.has(project.name)) continue; // run in full on every shard
        project.testFiles = project.testFiles.filter((_, i) => i % total === current - 1);
      }
      testFiles = projects.flatMap((p) => p.testFiles);
    } else {
      testFiles = testFiles.filter((_, i) => i % total === current - 1);
    }
    if (testFiles.length === 0) {
      console.log(dim(`Shard ${current}/${total}: no test files in this shard.`));
      process.exit(0);
    }
    console.log(dim(`Shard ${current}/${total}: running ${testFiles.length} file(s)`));
  }

  // Re-exec under tsx if we have TypeScript test files and haven't already
  if (needsTsx(testFiles) && !args.tsxReexec) {
    const forwardArgs = process.argv.slice(2).filter((a) => a !== '--__tsx-reexec');
    reExecWithTsx(forwardArgs);
    return;
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
  const allocation = allocateBucketWorkers(config.workers, bucketizeProjects(projects));
  const totalWorkers = [...allocation.values()].reduce((s, n) => s + n, 0);
  const maxFilesInAnyWave = Math.max(...projectWaves.map((wave) =>
    wave.reduce((sum, p) => sum + p.testFiles.length, 0),
  ));
  const effectiveWorkers = Math.min(totalWorkers, maxFilesInAnyWave);

  // Only warn when the user explicitly asked for fewer workers than we
  // ended up running — either via --workers or `workers:` in the config
  // file. Don't fire on the implicit default of 1.
  if (isExplicitWorkers(config) && totalWorkers > config.workers) {
    process.stderr.write(
      `Note: requested workers=${config.workers} but running ${totalWorkers} (one per device bucket is the minimum). ` +
        `Raise the workers budget to speed things up, or set per-project \`workers\` to control the total.\n`,
    );
  }

  // Reflect the effective parallelism on the config so reporters see the
  // real worker count. Downstream dispatcher paths pass `workers` explicitly,
  // so this mutation is safe.
  config.workers = totalWorkers;

  if (args.ui) {
    console.log(`\nLaunching Tapsmith UI mode...\n`);
  } else if (args.watch) {
    console.log(`\nStarting watch mode for ${testFiles.length} test file(s)...\n`);
  } else {
    reporter.onRunStart(config, testFiles.length);
  }

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
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
      });

      await reporter.onRunEnd(fullResult);
      process.exit(fullResult.status === 'failed' ? 1 : 0);
    }
  }

  // ─── Sequential mode (workers: 1, default) ───
  let launchedEmulators: LaunchedEmulator[] = [];
  let client: TapsmithGrpcClient | undefined;
  let device: Device | undefined;
  let currentSequentialState: SequentialDeviceState | undefined;
  let resolvedAgentApk: string | undefined;
  let resolvedAgentTestApk: string | undefined;
  let resolvedIosXctestrun: string | undefined;
  let sequentialExitCode = 1;
  const sequentialStart = Date.now();

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

  // Pick the first project's effective config as the initial setup target.
  // For single-bucket runs this is identical to the root config.
  const initialProject = projects.find((p) => p.testFiles.length > 0) ?? projects[0];
  const initialEffectiveConfig = initialProject.effectiveConfig;

  try {
    try {
      currentSequentialState = await setupSequentialDevice(
        initialEffectiveConfig,
        args.forceInstall,
        initialProject.deviceSignature,
      );
    } catch (err) {
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
        const perBucket = await provisionPerProjectDevices(config, projects);
        uiDeviceSerials = perBucket.deviceSerials;
        uiConfigByDevice = perBucket.configByDevice;
        uiBucketByDevice = perBucket.bucketByDevice;
        uiBucketByProject = perBucket.bucketByProject;
        uiWorkersOverride = perBucket.deviceSerials.length;
        launchedEmulators = [...launchedEmulators, ...perBucket.launched];
      } else {
        const uiProvision = await provisionMultiWorkerDevices(config, 'UI mode', { quiet: !args.tsxReexec });
        uiDeviceSerials = uiProvision.deviceSerials;
        launchedEmulators = [...launchedEmulators, ...uiProvision.launched];
        if (uiDeviceSerials) uiWorkersOverride = config.workers;
      }

      const uiServer = await startUIServer({
        config,
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
        const perBucket = await provisionPerProjectDevices(config, projects);
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
          if (fileIndex > 0 && projectConfig.package) {
            try {
              await launchConfiguredApp({
                label: `Device ${projectConfig.device}`,
                config: projectConfig,
                device: device!,
                client: client!,
                agentApkPath: resolvedAgentApk,
                agentTestApkPath: resolvedAgentTestApk,
                deviceSerial: projectConfig.device,
              }, `reset before ${path.basename(file)}`);

              const pong = await client!.ping();
              if (!pong.agentConnected) {
                console.error(red('Agent disconnected after app reset. Aborting.'));
                sequentialExitCode = 1;
                return;
              }
            } catch (err) {
              console.error(red(`Failed to reset app between test files: ${err}`));
              sequentialExitCode = 1;
              return;
            }
          }

          reporter.onTestFileStart(file);

          const suiteResult = await runTestFileWithRecovery(file, {
            config: projectConfig,
            device: device!,
            client: client!,
            screenshotDir,
            reporter,
            projectUseOptions: project.use,
            projectName: project.name !== 'default' ? project.name : undefined,
            sessionContext: {
              label: `Device ${projectConfig.device}`,
              config: projectConfig,
              device: device!,
              client: client!,
              agentApkPath: resolvedAgentApk,
              agentTestApkPath: resolvedAgentTestApk,
              iosXctestrunPath: resolvedIosXctestrun,
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
    sequentialExitCode = hasFailed ? 1 : 0;
  } finally {
    device?.close();
    client?.close();
    if (spawnedDaemonProcess) {
      try { spawnedDaemonProcess.kill(); } catch { /* already gone */ }
    }
    // Leave emulators running for reuse by the next run.
    preserveEmulatorsForReuse(launchedEmulators);
  }

  process.exit(sequentialExitCode);
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
    sessionContext: import('./session-preflight.js').SessionPreflightContext
  },
): Promise<SuiteResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const suite = await runTestFile(file, {
        config: opts.config,
        device: opts.device,
        screenshotDir: opts.screenshotDir,
        reporter: opts.reporter,
        abortFileOnError: isRecoverableInfrastructureError,
        projectUseOptions: opts.projectUseOptions,
        projectName: opts.projectName,
      });
      const fileResults = collectResults(suite);
      const infraFailure = fileResults.find(
        (r) => r.status === 'failed' && r.error && isRecoverableInfrastructureError(r.error),
      );
      if (!infraFailure) {
        return suite;
      }
      if (attempt === 2) {
        return suite;
      }
      process.stderr.write(
        dim(`Recovering session after infrastructure error in ${path.basename(file)}: ${infraFailure.error?.message ?? 'unknown'}\n`),
      );
      await launchConfiguredApp(opts.sessionContext, `recovery for ${path.basename(file)}`, { allowSoftReset: false });
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) {
        throw err;
      }
      process.stderr.write(
        dim(`Recovering session after infrastructure error in ${path.basename(file)}: ${err instanceof Error ? err.message : err}\n`),
      );
      await launchConfiguredApp(opts.sessionContext, `recovery for ${path.basename(file)}`, { allowSoftReset: false });
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
  console.error(red(`Fatal error: ${err}`));
  process.exit(1);
});
