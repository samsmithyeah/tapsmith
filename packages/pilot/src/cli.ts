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
import { spawn, execSync } from 'node:child_process';

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

// ─── Daemon management ───

async function ensureDaemonRunning(address: string): Promise<PilotGrpcClient> {
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

  const daemonBin = process.env.PILOT_DAEMON_BIN ?? 'pilot-core';
  const child = spawn(daemonBin, ['--address', address], {
    detached: true,
    stdio: 'ignore',
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

  // Connect to daemon
  const client = await ensureDaemonRunning(config.daemonAddress);
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

  // Connect to agent if APK is specified
  if (config.apk) {
    try {
      // Extract package name from APK path or use a default
      await device.startAgent('');
      console.log(dim('Agent connected.'));
    } catch {
      // Agent connection is best-effort at this stage
    }
  }

  // Run tests
  const allResults: TestResult[] = [];
  const totalStart = Date.now();

  const screenshotDir =
    config.screenshot !== 'never'
      ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
      : undefined;

  for (const file of testFiles) {
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
