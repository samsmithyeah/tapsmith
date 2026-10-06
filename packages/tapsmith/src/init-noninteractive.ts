/**
 * Non-interactive `tapsmith init` — flag validation, auto-detection resolution,
 * and file writing. Pure of process.exit and console; the CLI shell in
 * init.ts owns printing and exit codes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { simulatorChoices, type EnvScan } from './env-scan.js';
import type { AndroidConfig, IosConfig, Platform } from './init.js';
import { EXAMPLE_TEST_PATH, generateConfig, tapsmithTestsOutsideGeneratedMatch, testsOutsideGeneratedMatchWarning, writeExampleTest } from './init.js';
import { writeAgentsMd } from './agents-md.js';
import { avdCaptureSupport, avdCaptureWarning, noAvdsListedMessage } from './avd-images.js';
import * as detectDefaults from './init-detect.js';
import type { InitCommandOptions } from './cli-program.js';
import type { InstallCommand } from './config.js';

// ─── Types ───

export type DeviceType = 'emulator' | 'physical' | 'both';

export interface InitArgs {
  yes: boolean;
  json: boolean;
  force: boolean;
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
  /** Optional so callers that stub the build detectors need not stub this too (PILOT-557). */
  detectExpoProject?: (cwd: string) => detectDefaults.ExpoProject | undefined;
}

// ─── Flag validation ───

/**
 * Validate the parsed `tapsmith init` flags and shape them for the planner.
 * Values the parser cannot check (the platform list, the device type) are
 * rejected here with the InitError codes the `--json` contract promises.
 */
export function initArgsFromOptions(opts: InitCommandOptions): InitArgs {
  let platforms: Platform[] | undefined;
  if (opts.platform !== undefined) {
    platforms = opts.platform.split(',').map((p) => p.trim()) as Platform[];
    for (const p of platforms) {
      if (p !== 'android' && p !== 'ios') {
        throw new InitError('INVALID_PLATFORM', `Unknown platform "${p}"`, { fix: 'Use --platform android, --platform ios, or --platform android,ios' });
      }
    }
  }
  const deviceType = opts.deviceType;
  if (deviceType !== undefined && deviceType !== 'emulator' && deviceType !== 'physical' && deviceType !== 'both') {
    throw new InitError('INVALID_DEVICE_TYPE', `Unknown device type "${deviceType}"`, { fix: 'Use --device-type emulator|physical|both' });
  }

  const valueFlags = [opts.platform, opts.apk, opts.package, opts.app, opts.bundleId, opts.avd, opts.simulator, opts.deviceType];
  return {
    yes: opts.yes,
    json: opts.json,
    force: opts.force,
    platforms,
    apk: opts.apk,
    packageName: opts.package,
    app: opts.app,
    bundleId: opts.bundleId,
    avd: opts.avd,
    simulator: opts.simulator,
    deviceType,
    networkCapture: opts.networkCapture,
    exampleTest: opts.exampleTest,
    agentsMd: opts.agentsMd,
    anySetupFlag: valueFlags.some((v) => v !== undefined)
      || opts.force || opts.networkCapture || !opts.exampleTest || !opts.agentsMd,
  };
}

// ─── Resolution ───

export function resolveInitPlan(
  args: InitArgs,
  env: EnvScan,
  detect: DetectFns = detectDefaults,
  cwd: string = process.cwd(),
): InitPlan {
  const warnings: string[] = [];

  // Expo (PILOT-557): only needed for a missing build or id, and reading a
  // dynamic app config runs the project's Expo CLI, so detected on demand.
  let expoMemo: { value: detectDefaults.ExpoProject | undefined } | undefined;
  const expo = (): detectDefaults.ExpoProject | undefined => {
    expoMemo ??= { value: (detect.detectExpoProject ?? detectDefaults.detectExpoProject)(cwd) };
    return expoMemo.value;
  };

  // Platform: explicit flag, else infer from project layout.
  let platforms = args.platforms;
  if (!platforms) {
    const inferred: Platform[] = [];
    if (fs.existsSync(path.join(cwd, 'android'))) inferred.push('android');
    if (env.isMacOS && fs.existsSync(path.join(cwd, 'ios'))) inferred.push('ios');
    if (inferred.length === 0) {
      const expoProject = expo();
      if (expoProject) {
        const buildable: Array<'android' | 'ios'> = env.isMacOS ? ['android', 'ios'] : ['android'];
        throw new InitError('NO_PLATFORM', 'Could not infer target platform: this Expo project has no android/ or ios/ directory yet, so there is no build to test', {
          fix: `Build the app, then re-run init. ${detectDefaults.expoBuildHint(buildable, expoProject, 'Or pass --platform with --apk/--app pointing at an existing build.')}`,
        });
      }
      throw new InitError('NO_PLATFORM', 'Could not infer target platform (no android/ or ios/ directory found)', {
        fix: 'Pass --platform android, --platform ios, or --platform android,ios',
      });
    }
    platforms = inferred;
  }

  if (platforms.includes('ios') && !env.isMacOS) {
    throw new InitError('IOS_REQUIRES_MACOS', 'iOS setup is only supported on macOS', {
      fix: 'Run on a macOS machine, or configure only the android platform',
    });
  }

  let android: AndroidConfig | undefined;
  if (platforms.includes('android')) {
    let apkPath = args.apk;
    if (!apkPath) {
      const prefer = detect.preferDebugApk ?? detectDefaults.preferDebugApk;
      const candidates = prefer(detect.findApkCandidates(cwd));
      if (candidates.length === 0) {
        const expoProject = expo();
        if (expoProject) {
          throw new InitError('NO_APK', 'No Android APK found under android/**/build/outputs/apk/', {
            fix: detectDefaults.expoBuildHint(['android'], expoProject, 'Or pass --apk <path>.'),
          });
        }
        throw new InitError('NO_APK', 'No Android APK found under android/**/build/outputs/apk/', {
          fix: 'Build your app (e.g. cd android && ./gradlew assembleDebug; a React Native Debug build also needs Metro running, see https://tapsmith.dev/getting-started/#build-the-app-under-test), or pass --apk <path>',
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

    const apkAbs = path.resolve(cwd, apkPath);
    let packageName = args.packageName ?? detect.detectAndroidPackage(apkAbs);
    // The app config's id stands in only for a build that exists: a missing
    // APK still fails here, and a stand-in is said, since a build variant
    // (applicationIdSuffix) can carry another id (PILOT-557).
    const configPackage = !packageName && fs.existsSync(apkAbs) ? expo()?.androidPackage : undefined;
    if (configPackage) {
      packageName = configPackage;
      warnings.push(`Could not read the package name from ${apkPath} (needs aapt2 from the Android SDK build-tools), so used ${configPackage} from the Expo app config — check it matches this build, or pass --package <id>`);
    }
    if (!packageName) {
      throw new InitError('NO_PACKAGE', `Could not detect package name from ${apkPath} (aapt2 unavailable or APK missing)`, {
        fix: 'Pass --package <id>',
      });
    }

    const deviceType = args.deviceType ?? 'emulator';
    const useEmulators = deviceType === 'emulator' || deviceType === 'both';
    let avd = args.avd;
    if (useEmulators && !avd) {
      // With capture on, skip past Play-image AVDs (Android Studio's default,
      // usually listed first): HTTPS is never captured on them (PILOT-403).
      const capable = args.networkCapture
        ? env.avds.find((name) => avdCaptureSupport(env.avdImages.find((a) => a.name === name)) === 'capable')
        : undefined;
      avd = capable ?? env.avds[0];
    }
    // Nothing listed: either there are no AVDs, or `emulator` (which Tapsmith
    // launches AVDs with) was not found — the latter matters for an explicit
    // --avd too.
    if (useEmulators && env.avds.length === 0 && (!avd || env.avdImages.length > 0)) {
      warnings.push(noAvdsListedMessage(env.avdImages, avd));
    }
    if (useEmulators && avd && args.networkCapture) {
      const warning = avdCaptureWarning(avd, env.avdImages);
      if (warning) warnings.push(warning);
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
        const expoProject = expo();
        if (expoProject) {
          throw new InitError('NO_IOS_APP', 'No simulator .app bundle found under ios/', {
            fix: detectDefaults.expoBuildHint(['ios'], expoProject, 'Or pass --app <path>.'),
          });
        }
        throw new InitError('NO_IOS_APP', 'No simulator .app bundle found under ios/', {
          fix: 'Build your app for the simulator (in ios/: xcodebuild -workspace <App>.xcworkspace -scheme <App> -sdk iphonesimulator -derivedDataPath build; see https://tapsmith.dev/getting-started/#build-the-app-under-test), or pass --app <path>',
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

    const appAbs = path.resolve(cwd, appPath);
    let bundleId = args.bundleId ?? detect.detectIosBundleId(appAbs);
    const configBundleId = !bundleId && fs.existsSync(appAbs) ? expo()?.iosBundleId : undefined;
    if (configBundleId) {
      bundleId = configBundleId;
      warnings.push(`Could not read the bundle identifier from ${appPath}, so used ${configBundleId} from the Expo app config — check it matches this build, or pass --bundle-id <id>`);
    }
    if (!bundleId) {
      throw new InitError('NO_BUNDLE_ID', `Could not detect bundle identifier from ${appPath}`, {
        fix: 'Pass --bundle-id <id>',
      });
    }

    let simulator = args.simulator;
    if (!simulator) {
      simulator = simulatorChoices(env.simulators)[0]?.name;
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

/** Throws CONFIG_EXISTS unless force or no config present. Removes every existing config on force. */
export function assertConfigWritable(force: boolean, cwd: string = process.cwd()): void {
  const existing = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js']
    .filter((name) => fs.existsSync(path.join(cwd, name)));
  if (existing.length === 0) return;
  if (!force) {
    throw new InitError('CONFIG_EXISTS', `Found existing ${existing[0]}`, {
      fix: 'Pass --force to overwrite, or delete the existing config',
    });
  }
  // Remove every existing config, including tapsmith.config.ts itself, so the
  // subsequent write starts from a clean slate — writing over a symlink would
  // otherwise clobber its target, and restricted permissions could fail mid-write.
  for (const name of existing) {
    fs.rmSync(path.join(cwd, name), { force: true });
  }
}

/**
 * Writes the files. `missingTapsmith` is the install command when the project
 * cannot resolve `tapsmith`, which the files written here import (PILOT-551):
 * `--yes` never runs it — a scripted setup should not change package.json and
 * the lockfile unasked — so it becomes the first next step.
 */
export function executeInitPlan(
  plan: InitPlan,
  args: InitArgs,
  cwd: string = process.cwd(),
  missingTapsmith?: InstallCommand,
): InitResult {
  const filesCreated: string[] = [];
  const warnings = [...plan.warnings];

  const configPath = path.join(cwd, 'tapsmith.config.ts');
  assertConfigWritable(args.force, cwd);

  fs.writeFileSync(configPath, generateConfig(plan.platforms, plan.android, plan.ios, plan.networkCapture));
  filesCreated.push('tapsmith.config.ts');

  const unmatched = testsOutsideGeneratedMatchWarning(tapsmithTestsOutsideGeneratedMatch(cwd));
  if (unmatched) warnings.push(unmatched);

  if (args.exampleTest) {
    if (writeExampleTest(cwd) === 'exists') {
      warnings.push(`${EXAMPLE_TEST_PATH} already exists — left untouched`);
    } else {
      filesCreated.push(EXAMPLE_TEST_PATH);
    }
  }

  if (args.agentsMd) {
    writeAgentsMd(cwd);
    filesCreated.push('AGENTS.md');
  }

  if (missingTapsmith) {
    warnings.push(`Tapsmith isn't installed in this project, and the files init wrote import it: run ${missingTapsmith.display} before anything else`);
  }

  const nextSteps = [
    ...(missingTapsmith ? [`Install Tapsmith in this project: ${missingTapsmith.display}`] : []),
    'Verify the setup end-to-end: npx tapsmith verify --json',
    'Run tests: npx tapsmith test',
    'Register the MCP server for richer agent tooling: claude mcp add tapsmith -- npx tapsmith mcp-server',
  ];

  return { configPath, filesCreated, warnings, nextSteps };
}
