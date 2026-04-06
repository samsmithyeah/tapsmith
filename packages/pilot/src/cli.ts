#!/usr/bin/env node

/**
 * CLI entry point for `npx pilot`.
 *
 * Commands:
 *   pilot test [files...]           Run tests
 *   pilot test --device <serial>    Target specific device
 *   pilot --version                 Print version
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig, resolveDeviceStrategy, type PilotConfig } from './config.js';
import { PilotGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults, type TestResult, type SuiteResult } from './runner.js';
import { createReporters, ReporterDispatcher, type FullResult } from './reporter.js';
import { ensureSessionReady, launchConfiguredApp } from './session-preflight.js';
import { glob } from 'glob';
import { resolveTraceConfig } from './trace/types.js';
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
 * re-exec the CLI using tsx as the loader. This allows `import from "pilot"`
 * and TypeScript syntax in test files.
 */
function needsTsx(testFiles: string[]): boolean {
  return testFiles.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

function reExecWithTsx(args: string[]): never {
  // Find tsx binary — first check local node_modules, then global
  const pilotPkgDir = path.resolve(__dirname, '..');
  const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx');
  const tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';

  const cliPath = process.argv[1];
  const result = spawn(tsxBin, [cliPath, ...args, '--__tsx-reexec'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Tell Node to resolve "pilot" to our package
      NODE_PATH: path.join(pilotPkgDir, '..'),
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
    ? ['-s', serial, 'shell', 'echo', '__pilot_health_ok__']
    : ['shell', 'echo', '__pilot_health_ok__'];

  const tryAdb = (): boolean => {
    try {
      const result = execFileSync('adb', adbArgs, {
        timeout: 5_000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return result.trim().includes('__pilot_health_ok__');
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

async function ensureDaemonRunning(address: string, daemonBin?: string, platform?: string): Promise<PilotGrpcClient> {
  const port = address.split(':').pop() ?? '50051';

  // Kill any stale daemon on this port so we always get a fresh one
  // with the correct --platform flag. The daemon starts in <1s so
  // the cost of a restart is negligible.
  try {
    const probe = new PilotGrpcClient(address);
    const alive = await probe.waitForReady(1_000);
    if (alive) {
      probe.close();
      // Find and kill the process listening on this port
      const lsofOut = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf-8' }).trim();
      for (const pid of lsofOut.split('\n').filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
      }
      // Brief wait for the port to free up
      await new Promise((r) => setTimeout(r, 500));
    } else {
      probe.close();
    }
  } catch {
    // No daemon running, nothing to kill
  }

  // Remove stale ADB port forwards on the default agent port (18700).
  // A previous Android instance may have set up a forward that hijacks
  // traffic meant for the iOS XCUITest agent.
  try {
    const fwdList = execFileSync('adb', ['forward', '--list'], { encoding: 'utf-8' }).trim();
    for (const line of fwdList.split('\n')) {
      if (!line.includes('tcp:18700')) continue;
      const serial = line.split(' ')[0];
      if (!serial) continue;
      try {
        execFileSync('adb', ['-s', serial, 'forward', '--remove', 'tcp:18700']);
      } catch { /* already gone */ }
    }
  } catch {
    // ADB not available or no forwards — safe to ignore
  }

  // Start a fresh daemon
  const resolvedBin = process.env.PILOT_DAEMON_BIN ?? daemonBin ?? 'pilot-core';
  const daemonArgs = ['--port', port];
  if (platform) daemonArgs.push('--platform', platform);
  const child = spawn(resolvedBin, daemonArgs, {
    stdio: 'ignore',
  });
  child.on('error', () => {
    // Handled below via waitForReady timeout
  });
  child.unref();
  spawnedDaemonProcess = child;

  // Wait for daemon to be ready
  const newClient = new PilotGrpcClient(address);
  const started = await newClient.waitForReady(10_000);
  if (!started) {
    console.error(red('Failed to start Pilot daemon. Is pilot-core installed?'));
    process.exit(1);
  }

  console.log(dim(`Connected to Pilot daemon v${(await newClient.ping()).version}`));
  return newClient;
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
    if (!config.simulator) {
      console.error(red('No simulator specified. Set `simulator` in your config (e.g. simulator: "iPhone 16").'));
      process.exit(1);
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
    } else if (arg === '--workers' || arg === '-j') {
      const val = parseInt(rest[++i], 10);
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
    } else if (!arg.startsWith('-')) {
      args.files.push(arg);
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

function printHelp(): void {
  console.log(`
${bold('pilot')} — Mobile app testing framework

${bold('Usage:')}
  pilot test [files...]           Run test files
  pilot test --watch              Watch test files and re-run on change
  pilot test --ui                 Open interactive UI mode
  pilot test --ui --ui-port 8080  UI mode on specific port
  pilot test --device <serial>    Target specific device/simulator
  pilot test --workers <n>        Run tests in parallel across n devices
  pilot test --shard=x/y          Run shard x of y (for CI)
  pilot test --trace <mode>       Record traces (on, retain-on-failure, etc.)
  pilot show-trace <file.zip>     Open trace viewer in browser
  pilot show-report [dir]         Open HTML test report
  pilot merge-reports [dir]       Merge blob reports from sharded runs
  pilot --version                 Print version
  pilot --help                    Show this help

${bold('Options:')}
  -w, --watch              Watch test files and re-run on change
  -d, --device <serial>    Target a specific device or simulator by serial/UDID
  -j, --workers <n>        Number of parallel workers (default: 1)
  --shard=x/y              Split tests across CI machines (e.g. --shard=1/4)
  --trace <mode>           Trace mode: off, on, on-first-retry, on-all-retries,
                           retain-on-failure, retain-on-first-failure
  -c, --config <path>      Path to config file (default: pilot.config.ts)
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

  if (args.help || !args.command) {
    printHelp();
    return;
  }

  if (args.command === 'show-report') {
    const reportDir = args.files[0] ?? 'pilot-report';
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
      console.error(red('Usage: pilot show-trace <trace.zip>'));
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
  }
  if (args.shard) {
    config.shard = args.shard;
  }
  if (args.trace) {
    config.trace = args.trace as PilotConfig['trace'];
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
    const defaultProject: import('./project.js').ResolvedProject = {
      name: 'default', testMatch: config.testMatch, testIgnore: [], dependencies: [], testFiles: [],
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

  if (args.ui) {
    console.log(`\nLaunching Pilot UI mode...\n`);
  } else {
    reporter.onRunStart(config, testFiles.length);
  }

  // ─── Parallel mode ───
  // UI and watch modes handle their own execution — skip the dispatcher path.
  // Fall back to sequential when parallelism wouldn't help — either there's
  // only one test file, or all files are in sequential waves (e.g. setup → dependent).
  if (!args.ui && !args.watch) {
    const maxFilesInAnyWave = Math.max(...projectWaves.map((wave) =>
      wave.reduce((sum, p) => sum + p.testFiles.length, 0),
    ));
    const effectiveWorkers = Math.min(config.workers, maxFilesInAnyWave);
    if (effectiveWorkers > 1) {
      // The dispatcher manages its own daemons — one per worker — each with
      // exclusive ADB access to its assigned device. No discovery daemon needed.
      const { runParallel } = await import('./dispatcher.js');
      const fullResult = await runParallel({
        config,
        reporter,
        testFiles,
        workers: config.workers,
        projects: hasProjects ? projects : undefined,
        projectWaves: hasProjects ? projectWaves : undefined,
      });

      await reporter.onRunEnd(fullResult);
      process.exit(fullResult.status === 'failed' ? 1 : 0);
    }
  }

  // ─── Sequential mode (workers: 1, default) ───
  let launchedEmulators: LaunchedEmulator[] = [];
  let client: PilotGrpcClient | undefined;
  let device: Device | undefined;
  let sequentialExitCode = 1;
  const sequentialStart = Date.now();

  try {
    const target = await ensureSequentialTargetDevice(config);
    launchedEmulators = target.launched;

    if (!target.selectedSerial) {
      console.error(
        red(
          'No online devices found. Connect a device, start an emulator, or set `launchEmulators: true` with `avd` in your config.',
        ),
      );
      sequentialExitCode = 1;
      return;
    }

    config.device = target.selectedSerial;

    // Pre-flight: verify device is responsive before doing anything slow (Android only)
    if (config.platform !== 'ios') {
      await checkDeviceHealth(config.device);
    }

    // Connect to daemon
    client = await ensureDaemonRunning(config.daemonAddress, config.daemonBin, config.platform);
    device = new Device(client, config);

    try {
      await device.setDevice(config.device);
      console.log(dim(`Using device: ${config.device}`));
    } catch (err) {
      console.error(red(`Failed to set device: ${err}`));
      sequentialExitCode = 1;
      return;
    }

    if (config.platform === 'ios') {
      // iOS: install and launch .app on simulator before starting the agent.
      // The app must be running BEFORE the XCUITest agent starts so that
      // XCUITest can establish its accessibility bridge to the target app.
      if (config.app && config.device) {
        try {
          const { installApp, isAppInstalled } = await import('./ios-simulator.js');
          const resolvedApp = path.resolve(config.rootDir, config.app);
          const alreadyInstalled = config.package
            && isAppInstalled(config.device, config.package);

          if (alreadyInstalled && !args.forceInstall) {
            console.log(dim(`App ${config.package} already installed, skipping iOS app install. Use --force-install to reinstall.`));
          } else {
            if (alreadyInstalled) {
              console.log(dim(`Reinstalling iOS app: ${path.basename(resolvedApp)}`));
            }
            installApp(config.device, resolvedApp);
            console.log(dim(`Installed ${path.basename(resolvedApp)} on iOS simulator.`));
          }
        } catch (err) {
          console.error(red(`Failed to install iOS app: ${err}`));
          sequentialExitCode = 1;
          return;
        }
      }
      if (config.package && config.device) {
        try {
          const { execFileSync } = await import('node:child_process');
          execFileSync('xcrun', ['simctl', 'launch', config.device, config.package]);
          console.log(dim(`Launched ${config.package} on iOS simulator.`));
        } catch {
          // App may already be running
        }
      }
    } else {
      // Android: Wake and unlock device screen
      try {
        await device.wake();
        await device.unlock();
        console.log(dim('Device screen unlocked.'));
      } catch {
        // Non-fatal — device might already be awake/unlocked
      }

      // Install app under test if APK path is configured and not already installed.
      if (config.apk) {
        const isInstalled = config.package
          && config.device
          && isPackageInstalled(config.device, config.package);

        if (isInstalled && !args.forceInstall) {
          console.log(dim(`App ${config.package} already installed, skipping APK install. Use --force-install to reinstall.`));
        } else {
          const resolvedApk = path.resolve(config.rootDir, config.apk);
          try {
            if (isInstalled) {
              console.log(dim(`Reinstalling app APK: ${path.basename(resolvedApk)}`));
            }
            await device.installApk(resolvedApk);
            // Wait for package manager to index the new app
            if (config.package && config.device) {
              await waitForPackageIndexed(config.device, config.package);
            }
            console.log(dim(`Installed app APK: ${path.basename(resolvedApk)}`));
          } catch (err) {
            console.error(red(`Failed to install app APK: ${err}`));
            sequentialExitCode = 1;
            return;
          }
        }
      }
    }

    // If tracing with network capture, ensure adb root BEFORE starting agent
    // so that the adbd restart doesn't disrupt UIAutomator2's accessibility service.
    const traceConfig = resolveTraceConfig(config.trace);
    if (config.platform !== 'ios' && traceConfig.mode !== 'off' && traceConfig.network && config.device) {
      const restarted = ensureAdbRoot(config.device);
      if (restarted) {
        console.log(dim('Enabled adb root for network capture.'));
      }
    }

    // Start agent (with auto-install if APK paths configured)
    const resolvedAgentApk = config.agentApk
      ? path.resolve(config.rootDir, config.agentApk)
      : undefined;
    const resolvedAgentTestApk = config.agentTestApk
      ? path.resolve(config.rootDir, config.agentTestApk)
      : undefined;
    const resolvedIosXctestrun = config.iosXctestrun
      ? path.resolve(config.rootDir, config.iosXctestrun)
      : undefined;
    try {
      if (config.platform === 'ios') {
        console.log(dim(`Starting iOS agent (xctestrun: ${resolvedIosXctestrun ? 'set' : 'NOT SET'})`));
      }
      await device.startAgent(
        config.package ?? '',
        resolvedAgentApk,
        resolvedAgentTestApk,
        resolvedIosXctestrun,
      );
      if (config.platform !== 'ios') {
        await ensureSessionReady({
          label: `Device ${config.device}`,
          config,
          device,
          client,
          agentApkPath: resolvedAgentApk,
          agentTestApkPath: resolvedAgentTestApk,
          iosXctestrunPath: resolvedIosXctestrun,
          deviceSerial: config.device,
        }, 'startup');
      }
      console.log(dim('Agent connected.'));
    } catch (err) {
      console.error(red(`Failed to start agent: ${err}`));
      sequentialExitCode = 1;
      return;
    }

    // Launch the app under test — force-stop first to ensure it starts fresh
    // on the main activity regardless of any previous state.
    if (config.package) {
      try {
        await launchConfiguredApp({
          label: `Device ${config.device}`,
          config,
          device,
          client,
          agentApkPath: resolvedAgentApk,
          agentTestApkPath: resolvedAgentTestApk,
          iosXctestrunPath: resolvedIosXctestrun,
          deviceSerial: config.device,
        }, 'startup');
        console.log(dim(`Launched ${config.package}`));
      } catch (err) {
        console.error(red(`Failed to launch app: ${err}`));
        sequentialExitCode = 1;
        return;
      }
    }

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

      const uiProvision = await provisionMultiWorkerDevices(config, 'UI mode', { quiet: !args.tsxReexec });
      const uiDeviceSerials = uiProvision.deviceSerials;
      launchedEmulators = [...launchedEmulators, ...uiProvision.launched];

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
        workers: uiDeviceSerials ? config.workers : undefined,
        deviceSerials: uiDeviceSerials,
      }, {
        port: args.uiPort,
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

      const watchProvision = await provisionMultiWorkerDevices(config, 'Watch mode', { quiet: !args.tsxReexec });
      const watchDeviceSerials = watchProvision.deviceSerials;
      launchedEmulators = [...launchedEmulators, ...watchProvision.launched];

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
        workers: watchDeviceSerials ? config.workers : undefined,
        deviceSerials: watchDeviceSerials,
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

        if (showProjectHeaders && project.testFiles.length > 0) {
          process.stdout.write(`\n${dim(`  ── Project: ${project.name} ──`)}\n`);
        }

        for (const file of project.testFiles) {
          if (fileIndex > 0 && config.package) {
            try {
              await launchConfiguredApp({
                label: `Device ${config.device}`,
                config,
                device,
                client,
                agentApkPath: resolvedAgentApk,
                agentTestApkPath: resolvedAgentTestApk,
                deviceSerial: config.device,
              }, `reset before ${path.basename(file)}`);

              const pong = await client.ping();
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
            config,
            device,
            client,
            screenshotDir,
            reporter,
            projectUseOptions: project.use,
            projectName: project.name !== 'default' ? project.name : undefined,
            sessionContext: {
              label: `Device ${config.device}`,
              config,
              device,
              client,
              agentApkPath: resolvedAgentApk,
              agentTestApkPath: resolvedAgentTestApk,
              iosXctestrunPath: resolvedIosXctestrun,
              deviceSerial: config.device,
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
    config: PilotConfig
    device: Device
    client: PilotGrpcClient
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

main().catch((err) => {
  console.error(red(`Fatal error: ${err}`));
  process.exit(1);
});
