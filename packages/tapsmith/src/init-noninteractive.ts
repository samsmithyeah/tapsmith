/**
 * Non-interactive `tapsmith init` — flag parsing, auto-detection resolution,
 * and file writing. Pure of process.exit and console; the CLI shell in
 * init.ts owns printing and exit codes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvScan, SimulatorInfo } from './env-scan.js';
import type { AndroidConfig, IosConfig, Platform } from './init.js';
import { generateConfig, generateExampleTest } from './init.js';
import { writeAgentsMd } from './agents-md.js';
import * as detectDefaults from './init-detect.js';

// ─── Types ───

export type DeviceType = 'emulator' | 'physical' | 'both';

export interface InitArgs {
  yes: boolean;
  json: boolean;
  force: boolean;
  help: boolean;
  platforms?: Platform[];
  apk?: string;
  packageName?: string;
  app?: string;
  bundleId?: string;
  avd?: string;
  simulator?: string;
  deviceType?: DeviceType;
  networkCapture: boolean;
  exampleTest: boolean;
  agentsMd: boolean;
  /** True when any setup-shaping flag was passed (implies non-interactive). */
  anySetupFlag: boolean;
}

export class InitError extends Error {
  readonly code: string;
  readonly fix?: string;
  readonly candidates?: string[];

  constructor(code: string, message: string, opts?: { fix?: string; candidates?: string[] }) {
    super(message);
    this.code = code;
    this.fix = opts?.fix;
    this.candidates = opts?.candidates;
  }
}

export interface InitPlan {
  platforms: Platform[];
  android?: AndroidConfig;
  ios?: IosConfig;
  networkCapture: boolean;
  warnings: string[];
}

export interface InitResult {
  configPath: string;
  filesCreated: string[];
  warnings: string[];
  nextSteps: string[];
}

export interface DetectFns {
  findApkCandidates: (cwd: string) => string[];
  preferDebugApk?: (candidates: string[]) => string[];
  detectAndroidPackage: (apkPath: string) => string | undefined;
  findIosAppCandidates: (cwd: string) => string[];
  detectIosBundleId: (appPath: string) => string | undefined;
}

// ─── Flag parsing ───

const VALUE_FLAGS = new Set([
  '--platform', '--apk', '--package', '--app', '--bundle-id',
  '--avd', '--simulator', '--device-type',
]);

export function parseInitArgs(argv: string[]): InitArgs {
  const args: InitArgs = {
    yes: false, json: false, force: false, help: false,
    networkCapture: false, exampleTest: true, agentsMd: true,
    anySetupFlag: false,
  };

  const setValue = (flag: string, value: string | undefined): void => {
    if (value === undefined || value.startsWith('-')) {
      throw new InitError('MISSING_FLAG_VALUE', `${flag} requires a value`, { fix: `Pass a value: ${flag} <value>` });
    }
    args.anySetupFlag = true;
    switch (flag) {
      case '--platform': {
        const platforms = value.split(',').map((p) => p.trim()) as Platform[];
        for (const p of platforms) {
          if (p !== 'android' && p !== 'ios') {
            throw new InitError('INVALID_PLATFORM', `Unknown platform "${p}"`, { fix: 'Use --platform android, --platform ios, or --platform android,ios' });
          }
        }
        args.platforms = platforms;
        break;
      }
      case '--apk': args.apk = value; break;
      case '--package': args.packageName = value; break;
      case '--app': args.app = value; break;
      case '--bundle-id': args.bundleId = value; break;
      case '--avd': args.avd = value; break;
      case '--simulator': args.simulator = value; break;
      case '--device-type': {
        if (value !== 'emulator' && value !== 'physical' && value !== 'both') {
          throw new InitError('INVALID_DEVICE_TYPE', `Unknown device type "${value}"`, { fix: 'Use --device-type emulator|physical|both' });
        }
        args.deviceType = value;
        break;
      }
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--force') { args.force = true; args.anySetupFlag = true; }
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--network-capture') { args.networkCapture = true; args.anySetupFlag = true; }
    else if (arg === '--no-example-test') { args.exampleTest = false; args.anySetupFlag = true; }
    else if (arg === '--no-agents-md') { args.agentsMd = false; args.anySetupFlag = true; }
    else if (VALUE_FLAGS.has(arg)) setValue(arg, argv[++i]);
    else if (arg.includes('=') && VALUE_FLAGS.has(arg.slice(0, arg.indexOf('=')))) {
      setValue(arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1));
    } else {
      throw new InitError('UNKNOWN_FLAG', `Unknown init flag: ${arg}`, { fix: 'Run: npx tapsmith init --help' });
    }
  }

  return args;
}

// ─── Resolution ───

function pickNewestSimulator(simulators: SimulatorInfo[]): string | undefined {
  const seen = new Map<string, SimulatorInfo>();
  for (const sim of simulators) {
    const existing = seen.get(sim.name);
    if (!existing || sim.runtime.localeCompare(existing.runtime, undefined, { numeric: true }) > 0) {
      seen.set(sim.name, sim);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }));
  const iphone = sorted.find((s) => s.name.startsWith('iPhone'));
  return (iphone ?? sorted[0])?.name;
}

export function resolveInitPlan(
  args: InitArgs,
  env: EnvScan,
  detect: DetectFns = detectDefaults,
  cwd: string = process.cwd(),
): InitPlan {
  const warnings: string[] = [];

  // Platform: explicit flag, else infer from project layout.
  let platforms = args.platforms;
  if (!platforms) {
    const inferred: Platform[] = [];
    if (fs.existsSync(path.join(cwd, 'android'))) inferred.push('android');
    if (env.isMacOS && fs.existsSync(path.join(cwd, 'ios'))) inferred.push('ios');
    if (inferred.length === 0) {
      throw new InitError('NO_PLATFORM', 'Could not infer target platform (no android/ or ios/ directory found)', {
        fix: 'Pass --platform android, --platform ios, or --platform android,ios',
      });
    }
    platforms = inferred;
  }

  let android: AndroidConfig | undefined;
  if (platforms.includes('android')) {
    let apkPath = args.apk;
    if (!apkPath) {
      const prefer = detect.preferDebugApk ?? detectDefaults.preferDebugApk;
      const candidates = prefer(detect.findApkCandidates(cwd));
      if (candidates.length === 0) {
        throw new InitError('NO_APK', 'No Android APK found under android/**/build/outputs/apk/', {
          fix: 'Build your app (e.g. cd android && ./gradlew assembleDebug), or pass --apk <path>',
        });
      }
      if (candidates.length > 1) {
        throw new InitError('AMBIGUOUS_APK', `Found ${candidates.length} APK candidates`, {
          fix: 'Pass --apk <path> to choose one',
          candidates,
        });
      }
      apkPath = candidates[0];
    }

    const packageName = args.packageName ?? detect.detectAndroidPackage(apkPath);
    if (!packageName) {
      throw new InitError('NO_PACKAGE', `Could not detect package name from ${apkPath} (aapt2 unavailable or APK missing)`, {
        fix: 'Pass --package <id>',
      });
    }

    const deviceType = args.deviceType ?? 'emulator';
    const useEmulators = deviceType === 'emulator' || deviceType === 'both';
    let avd = args.avd;
    if (useEmulators && !avd) {
      avd = env.avds[0];
      if (!avd) warnings.push('No Android AVDs found — create one in Android Studio, then set `avd` in tapsmith.config.ts');
    }
    android = { apkPath, packageName, useEmulators, usePhysicalDevices: deviceType === 'physical' || deviceType === 'both', avd };
  }

  let ios: IosConfig | undefined;
  if (platforms.includes('ios')) {
    const deviceType = args.deviceType ?? 'emulator';
    if (deviceType === 'physical') {
      throw new InitError('IOS_PHYSICAL_INTERACTIVE_ONLY', 'iOS physical-device setup requires the interactive wizard (code signing preflight)', {
        fix: 'Run `npx tapsmith init` in a terminal, or use --device-type emulator for simulators',
      });
    }
    if (deviceType === 'both') {
      warnings.push('iOS physical devices skipped — run `npx tapsmith init` interactively to configure them (code signing preflight)');
    }

    let appPath = args.app;
    if (!appPath) {
      const candidates = detect.findIosAppCandidates(cwd);
      if (candidates.length === 0) {
        throw new InitError('NO_IOS_APP', 'No simulator .app bundle found under ios/', {
          fix: 'Build your app for the simulator (xcodebuild -sdk iphonesimulator), or pass --app <path>',
        });
      }
      if (candidates.length > 1) {
        throw new InitError('AMBIGUOUS_IOS_APP', `Found ${candidates.length} .app candidates`, {
          fix: 'Pass --app <path> to choose one',
          candidates,
        });
      }
      appPath = candidates[0];
    }

    const bundleId = args.bundleId ?? detect.detectIosBundleId(appPath);
    if (!bundleId) {
      throw new InitError('NO_BUNDLE_ID', `Could not detect bundle identifier from ${appPath}`, {
        fix: 'Pass --bundle-id <id>',
      });
    }

    let simulator = args.simulator;
    if (!simulator) {
      simulator = pickNewestSimulator(env.simulators);
      if (!simulator) {
        simulator = 'iPhone 17';
        warnings.push('No iOS simulators found — install one via Xcode; defaulting to "iPhone 17"');
      }
    }
    ios = { appPath, bundleId, simulator, usePhysicalDevice: false };
  }

  return { platforms, android, ios, networkCapture: args.networkCapture, warnings };
}

// ─── Execution ───

export function executeInitPlan(plan: InitPlan, args: InitArgs, cwd: string = process.cwd()): InitResult {
  const filesCreated: string[] = [];
  const warnings = [...plan.warnings];

  const configPath = path.join(cwd, 'tapsmith.config.ts');
  const existing = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js']
    .find((name) => fs.existsSync(path.join(cwd, name)));
  if (existing && !args.force) {
    throw new InitError('CONFIG_EXISTS', `Found existing ${existing}`, {
      fix: 'Pass --force to overwrite, or delete the existing config',
    });
  }

  fs.writeFileSync(configPath, generateConfig(plan.platforms, plan.android, plan.ios, plan.networkCapture));
  filesCreated.push('tapsmith.config.ts');

  if (args.exampleTest) {
    const testPath = path.join(cwd, 'tests', 'example.test.ts');
    if (fs.existsSync(testPath)) {
      warnings.push('tests/example.test.ts already exists — left untouched');
    } else {
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, generateExampleTest());
      filesCreated.push('tests/example.test.ts');
    }
  }

  if (args.agentsMd) {
    writeAgentsMd(cwd);
    filesCreated.push('AGENTS.md');
  }

  const nextSteps = [
    'Verify the setup end-to-end: npx tapsmith verify --json',
    'Run tests: npx tapsmith test',
    'Register the MCP server for richer agent tooling: claude mcp add tapsmith -- npx tapsmith mcp-server',
  ];

  return { configPath, filesCreated, warnings, nextSteps };
}
