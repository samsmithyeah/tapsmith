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
} from './emulator.js';

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

async function ensureDaemonRunning(address: string, daemonBin?: string): Promise<PilotGrpcClient> {
  const client = new PilotGrpcClient(address);

  // Try to connect to existing daemon
  const ready = await client.waitForReady(2_000);
  if (ready) {
    try {
      const pong = await client.ping();
      console.log(dim(`Connected to Pilot daemon v${pong.version}`));
      return client;
    } catch {
      // fall through to start daemon
    }
  }

  // Try to start daemon
  console.log(dim('Starting Pilot daemon...'));
  client.close();

  const resolvedBin = process.env.PILOT_DAEMON_BIN ?? daemonBin ?? 'pilot-core';
  const port = address.split(':').pop() ?? '50051';
  const child = spawn(resolvedBin, ['--port', port], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    // Handled below via waitForReady timeout
  });
  child.unref();

  // Wait for daemon to be ready
  const newClient = new PilotGrpcClient(address);
  const started = await newClient.waitForReady(10_000);
  if (!started) {
    console.error(red('Failed to start Pilot daemon. Is pilot-core installed?'));
    process.exit(1);
  }

  console.log(dim('Pilot daemon started.'));
  return newClient;
}

// ─── Test file discovery ───

async function discoverTestFiles(
  patterns: string[],
  rootDir: string,
  explicitFiles?: string[],
): Promise<string[]> {
  if (explicitFiles && explicitFiles.length > 0) {
    return explicitFiles.map((f) => path.resolve(rootDir, f));
  }

  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**'],
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
    return { selectedSerial: config.device, launched: [] };
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
  forceInstall: boolean;
  version: boolean;
  help: boolean;
  tsxReexec: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: '',
    files: [],
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

function printHelp(): void {
  console.log(`
${bold('pilot')} — Mobile app testing framework

${bold('Usage:')}
  pilot test [files...]           Run test files
  pilot test --device <serial>    Target specific device
  pilot test --workers <n>        Run tests in parallel across n devices
  pilot test --shard=x/y          Run shard x of y (for CI)
  pilot test --trace <mode>       Record traces (on, retain-on-failure, etc.)
  pilot show-trace <file.zip>     Open trace viewer in browser
  pilot show-report [dir]         Open HTML test report
  pilot merge-reports [dir]       Merge blob reports from sharded runs
  pilot --version                 Print version
  pilot --help                    Show this help

${bold('Options:')}
  -d, --device <serial>    Target a specific device by serial
  -j, --workers <n>        Number of parallel workers (default: 1)
  --shard=x/y              Split tests across CI machines (e.g. --shard=1/4)
  --trace <mode>           Trace mode: off, on, on-first-retry, on-all-retries,
                           retain-on-failure, retain-on-first-failure
  --force-install          Reinstall the APK even if already installed
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
    const reportDir = args.files[0] ?? 'pilot-report'
    const reportPath = path.resolve(process.cwd(), reportDir, 'index.html')
    if (!fs.existsSync(reportPath)) {
      console.error(red(`No report found at ${reportPath}`))
      process.exit(1)
    }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawn(cmd, [reportPath], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  if (args.command === 'show-trace') {
    const traceFile = args.files[0]
    if (!traceFile) {
      console.error(red('Usage: pilot show-trace <trace.zip>'))
      process.exit(1)
    }
    const { showTrace } = await import('./trace/show-trace-server.js')
    try {
      const server = await showTrace({ tracePath: traceFile })
      console.log(dim(`Trace viewer running at http://127.0.0.1:${server.port}/`))
      console.log(dim('Press Ctrl+C to stop.'))
      // Keep alive until Ctrl+C
      process.on('SIGINT', () => {
        server.close()
        process.exit(0)
      })
      // Prevent Node from exiting
      await new Promise(() => {})
    } catch (err) {
      console.error(red(`${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
    return
  }

  if (args.command === 'merge-reports') {
    const blobDir = args.files[0] ?? 'blob-report'
    const resolvedDir = path.resolve(process.cwd(), blobDir)
    if (!fs.existsSync(resolvedDir)) {
      console.error(red(`No blob directory found at ${resolvedDir}`))
      process.exit(1)
    }
    const { mergeBlobs } = await import('./reporters/blob.js')
    const config = await loadConfig()
    const result = mergeBlobs(resolvedDir)
    const reporters = await createReporters(config.reporter ?? 'list')
    const dispatcher = new ReporterDispatcher(reporters)
    dispatcher.onRunStart(config, 0)
    await dispatcher.onRunEnd(result)
    return
  }

  if (args.command !== 'test') {
    console.error(red(`Unknown command: ${args.command}`));
    printHelp();
    process.exit(1);
  }

  // Load config
  const config = await loadConfig();
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

  // Discover test files
  let testFiles = await discoverTestFiles(config.testMatch, config.rootDir, args.files);
  if (testFiles.length === 0) {
    console.error(red('No test files found.'));
    process.exit(1);
  }

  // Apply sharding — deterministic split across CI machines
  if (config.shard) {
    const { current, total } = config.shard;
    testFiles = testFiles.filter((_, i) => i % total === current - 1);
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

  reporter.onRunStart(config, testFiles.length);

  // ─── Parallel mode ───
  // Fall back to sequential when there's only one test file — no point
  // spinning up the full dispatcher/worker infrastructure for a single file.
  if (config.workers > 1 && testFiles.length > 1) {
    // The dispatcher manages its own daemons — one per worker — each with
    // exclusive ADB access to its assigned device. No discovery daemon needed.
    const { runParallel } = await import('./dispatcher.js');
    const fullResult = await runParallel({
      config,
      reporter,
      testFiles,
      workers: config.workers,
    });

    await reporter.onRunEnd(fullResult);
    process.exit(fullResult.status === 'failed' ? 1 : 0);
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

    // Pre-flight: verify device is responsive before doing anything slow
    await checkDeviceHealth(config.device);

    // Connect to daemon
    client = await ensureDaemonRunning(config.daemonAddress, config.daemonBin);
    device = new Device(client, config);

    try {
      await device.setDevice(config.device);
      console.log(dim(`Using device: ${config.device}`));
    } catch (err) {
      console.error(red(`Failed to set device: ${err}`));
      sequentialExitCode = 1;
      return;
    }

    // Wake and unlock device screen
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

    // Start agent (with auto-install if APK paths configured)
    const resolvedAgentApk = config.agentApk
      ? path.resolve(config.rootDir, config.agentApk)
      : undefined;
    const resolvedAgentTestApk = config.agentTestApk
      ? path.resolve(config.rootDir, config.agentTestApk)
      : undefined;
    try {
      await device.startAgent(
        '',
        resolvedAgentApk,
        resolvedAgentTestApk,
      );
      await ensureSessionReady({
        label: `Device ${config.device}`,
        config,
        device,
        client,
        agentApkPath: resolvedAgentApk,
        agentTestApkPath: resolvedAgentTestApk,
        deviceSerial: config.device,
      }, 'startup');
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
          deviceSerial: config.device,
        }, 'startup');
        console.log(dim(`Launched ${config.package}`));
      } catch (err) {
        console.error(red(`Failed to launch app: ${err}`));
        sequentialExitCode = 1;
        return;
      }
    }

    // Run tests
    const allResults: TestResult[] = [];
    const allSuites: SuiteResult[] = [];
    const setupDuration = Date.now() - sequentialStart;

    const screenshotDir =
      config.screenshot !== 'never'
        ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
        : undefined;

    for (let i = 0; i < testFiles.length; i++) {
      const file = testFiles[i];

      if (i > 0 && config.package) {
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

      const suiteResult = await runTestFile(file, {
        config,
        device,
        screenshotDir,
        reporter,
      });

      const fileResults = collectResults(suiteResult);
      allResults.push(...fileResults);
      allSuites.push(suiteResult);

      reporter.onTestFileEnd(file, fileResults);
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
    // Leave emulators running for reuse by the next run.
    preserveEmulatorsForReuse(launchedEmulators);
  }

  process.exit(sequentialExitCode);
}

main().catch((err) => {
  console.error(red(`Fatal error: ${err}`));
  process.exit(1);
});
