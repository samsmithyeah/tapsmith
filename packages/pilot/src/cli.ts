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
import { loadConfig, type PilotConfig } from './config.js';
import { PilotGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults, type TestResult } from './runner.js';
import { glob } from 'glob';
import { spawn, execFileSync } from 'node:child_process';

// ─── ANSI helpers ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}
function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
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

  if (tryAdb()) {
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

// ─── Result formatting ───

function printResults(allResults: TestResult[], totalDurationMs: number): void {
  const passed = allResults.filter((r) => r.status === 'passed').length;
  const failed = allResults.filter((r) => r.status === 'failed').length;
  const skipped = allResults.filter((r) => r.status === 'skipped').length;

  console.log('');
  console.log(bold('Results:'));
  console.log('');

  for (const result of allResults) {
    const icon =
      result.status === 'passed'
        ? green('PASS')
        : result.status === 'failed'
          ? red('FAIL')
          : yellow('SKIP');
    const duration = dim(`(${result.durationMs}ms)`);
    console.log(`  ${icon}  ${result.fullName} ${duration}`);

    if (result.error) {
      const indent = '        ';
      console.log(`${indent}${red(result.error.message)}`);
      if (result.error.stack) {
        const stackLines = result.error.stack.split('\n').slice(1, 4);
        for (const line of stackLines) {
          console.log(`${indent}${dim(line.trim())}`);
        }
      }
    }

    if (result.screenshotPath) {
      console.log(`        ${dim(`Screenshot: ${result.screenshotPath}`)}`);
    }
  }

  console.log('');
  console.log(
    bold('Summary: ') +
      [
        passed > 0 ? green(`${passed} passed`) : null,
        failed > 0 ? red(`${failed} failed`) : null,
        skipped > 0 ? yellow(`${skipped} skipped`) : null,
      ]
        .filter(Boolean)
        .join(', ') +
      dim(` | ${(totalDurationMs / 1000).toFixed(2)}s`),
  );
  console.log('');
}

// ─── Argument parsing ───

interface CliArgs {
  command: string;
  files: string[];
  device?: string;
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
  pilot --version                 Print version
  pilot --help                    Show this help

${bold('Options:')}
  -d, --device <serial>   Target a specific device by serial
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

  // Discover test files
  const testFiles = await discoverTestFiles(config.testMatch, config.rootDir, args.files);
  if (testFiles.length === 0) {
    console.error(red('No test files found.'));
    process.exit(1);
  }

  // Re-exec under tsx if we have TypeScript test files and haven't already
  if (needsTsx(testFiles) && !args.tsxReexec) {
    const forwardArgs = process.argv.slice(2).filter((a) => a !== '--__tsx-reexec');
    reExecWithTsx(forwardArgs);
    return;
  }

  console.log(cyan(`Found ${testFiles.length} test file(s)`));
  console.log('');

  // Pre-flight: verify device is responsive before doing anything slow
  await checkDeviceHealth(config.device);

  // Connect to daemon
  const client = await ensureDaemonRunning(config.daemonAddress, config.daemonBin);
  const device = new Device(client, config);

  // Set device if specified
  if (config.device) {
    try {
      await device.setDevice(config.device);
      console.log(dim(`Using device: ${config.device}`));
    } catch (err) {
      console.error(red(`Failed to set device: ${err}`));
      process.exit(1);
    }
  }

  // Wake and unlock device screen
  try {
    await device.wake();
    await device.unlock();
    console.log(dim('Device screen unlocked.'));
  } catch {
    // Non-fatal — device might already be awake/unlocked
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
    console.log(dim('Agent connected.'));
  } catch (err) {
    console.error(red(`Failed to start agent: ${err}`));
    process.exit(1);
  }

  // Launch the app under test — force-stop first to ensure it starts fresh
  // on the main activity regardless of any previous state.
  if (config.package) {
    try {
      try { await device.terminateApp(config.package); } catch { /* may not be running */ }
      await device.launchApp(config.package);
      console.log(dim(`Launched ${config.package}`));
    } catch (err) {
      console.error(red(`Failed to launch app: ${err}`));
      process.exit(1);
    }
  }

  // Run tests
  const allResults: TestResult[] = [];
  const totalStart = Date.now();

  const screenshotDir =
    config.screenshot !== 'never'
      ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
      : undefined;

  for (let i = 0; i < testFiles.length; i++) {
    const file = testFiles[i];

    // Reset app to main activity between test files for isolation (PILOT-134).
    // Uses direct ADB commands (force-stop + launcher intent) which bypass the
    // on-device agent — the agent survives because it runs as a separate package.
    if (i > 0 && config.package) {
      try {
        // terminateApp may fail if the app already crashed — that's fine,
        // we just need it stopped before relaunching.
        try { await device.terminateApp(config.package); } catch { /* app may not be running */ }
        await device.launchApp(config.package);

        const pong = await client.ping();
        if (!pong.agentConnected) {
          console.error(red('Agent disconnected after app reset. Aborting.'));
          process.exit(1);
        }
      } catch (err) {
        console.error(red(`Failed to reset app between test files: ${err}`));
        process.exit(1);
      }
    }

    const relativePath = path.relative(config.rootDir, file);
    console.log(bold(`  ${relativePath}`));

    const suiteResult = await runTestFile(file, {
      config,
      device,
      screenshotDir,
    });

    const fileResults = collectResults(suiteResult);
    allResults.push(...fileResults);
  }

  const totalDurationMs = Date.now() - totalStart;

  // Print results
  printResults(allResults, totalDurationMs);

  // Cleanup
  device.close();

  // Exit code
  const hasFailed = allResults.some((r) => r.status === 'failed');
  process.exit(hasFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(red(`Fatal error: ${err}`));
  process.exit(1);
});
