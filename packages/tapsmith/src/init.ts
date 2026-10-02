import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Enquirer from 'enquirer';
import figlet from 'figlet';
import { tryExec, scanEnvironment, type EnvScan, type SimulatorInfo } from './env-scan.js';
import { detectAndroidPackage, detectIosBundleId } from './init-detect.js';
import type { InitCommandOptions } from './cli-program.js';
import { formatJson, jsonError } from './cli-json.js';
import { avdCaptureSupport, avdCaptureWarning, noAvdsListedMessage, type AvdImageInfo } from './avd-images.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;

const enquirer = new Enquirer();

// ─── Helpers ───

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function displayEnvironment(env: EnvScan): void {
  const ok = (msg: string): string => `  ${green('✓')} ${msg}`;
  const warn = (msg: string): string => `  ${YELLOW}⚠${RESET} ${msg}`;
  const fail = (msg: string): string => `  ${RED}✗${RESET} ${msg}`;
  const lines: string[] = [];

  const major = parseInt(env.nodeVersion.split('.')[0], 10);
  lines.push(major >= 22 ? ok(`Node.js ${env.nodeVersion}`) : fail(`Node.js ${env.nodeVersion} (requires >= 22)`));
  lines.push(env.daemonBin ? ok('Tapsmith daemon') : fail('Tapsmith daemon not found'));

  if (env.agentApk && env.agentTestApk) lines.push(ok('Android agent (bundled)'));
  else if (env.agentApk || env.agentTestApk) lines.push(warn('Android agent (incomplete)'));

  lines.push(env.adbVersion ? ok(`ADB ${env.adbVersion}`) : warn('ADB not found'));
  if (env.androidHome) lines.push(ok('ANDROID_HOME'));

  if (env.isMacOS) {
    lines.push(env.xcodeVersion ? ok(`Xcode ${env.xcodeVersion}`) : warn('Xcode not found'));
    if (env.simulators.length > 0) lines.push(ok(`${env.simulators.length} iOS simulators available`));
  }

  if (env.avds.length > 0) lines.push(ok(`${env.avds.length} Android AVDs available`));

  console.log();
  console.log(`  ${bold('Environment')}`);
  console.log(lines.join('\n'));
  console.log();
}

// ─── Prompt helpers ───

async function ask<T>(question: Record<string, unknown>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- enquirer's PromptOptions union is too narrow for dynamic question objects
  const result = await enquirer.prompt({ ...question, name: '_' } as any) as Record<string, T>;
  return result['_'];
}

// ─── Platform-specific questions ───

export type Platform = 'android' | 'ios';

export interface AndroidConfig {
  apkPath: string;
  packageName?: string;
  useEmulators: boolean;
  usePhysicalDevices: boolean;
  avd?: string;
}

export interface IosConfig {
  /** Simulator build. Unset only when the user runs on physical devices alone. */
  appPath?: string;
  bundleId?: string;
  /** The device build's bundle id, when it differs from `bundleId` (per-configuration ids). */
  deviceBundleId?: string;
  simulator?: string;
  usePhysicalDevice: boolean;
  /** Device-signed (iphoneos) build; set whenever `usePhysicalDevice` is. */
  deviceAppPath?: string;
}

// ─── AVD choice and HTTPS capture (PILOT-403) ───

/**
 * The wizard's AVD picker: list order kept, Google Play images marked (HTTPS
 * is never captured on them), and a capture-capable AVD pre-selected. The
 * capture question comes later and defaults to yes, so the picker always
 * prefers a capable AVD.
 */
export function avdPickerChoices(
  avds: string[],
  avdImages: AvdImageInfo[],
): { choices: Array<{ name: string; message: string; hint?: string }>; initial: number } {
  const support = avds.map((name) => avdCaptureSupport(avdImages.find((a) => a.name === name)));
  const choices = avds.map((name, i) => (support[i] === 'play-image'
    ? { name, message: name, hint: 'no HTTPS capture' }
    : { name, message: name }));
  const firstCapable = support.indexOf('capable');
  return { choices, initial: firstCapable === -1 ? 0 : firstCapable };
}

/** The wizard's network-capture summary line for the Android emulator. */
export function androidEmulatorCaptureLine(avd: string | undefined, avdImages: AvdImageInfo[]): string {
  // The picker always returns an AVD, so no AVD means `emulator -list-avds`
  // listed none — configureAndroid has already printed why.
  if (!avd) return `  ${YELLOW}⚠${RESET} Android emulator — no AVD selected (see the AVD warning above)`;
  const warning = avdCaptureWarning(avd, avdImages);
  return warning
    ? `  ${YELLOW}⚠${RESET} Android emulator — ${warning}`
    : `  ${green('✓')} Android emulator (${avd}) — works automatically`;
}

async function configureAndroid(env: EnvScan): Promise<AndroidConfig> {
  console.log(`  ${bold('Android')}`);

  const apkPath = await ask<string>({
    type: 'input',
    message: 'Where is your Android APK?',
    initial: './android/app/build/outputs/apk/debug/app-debug.apk',
    validate: (val: string) => val.trim().length > 0 || 'APK path is required',
  });

  let packageName: string | undefined;
  const detected = detectAndroidPackage(apkPath);
  if (detected) {
    packageName = detected;
    console.log(dim(`  Detected package: ${detected}`));
  }
  if (!packageName) {
    packageName = await ask<string>({
      type: 'input',
      message: 'What is your app\'s package name?',
      initial: 'com.example.myapp',
      validate: (val: string) => val.trim().length > 0 || 'Package name is required',
    });
  }

  const deviceType = await ask<string>({
    type: 'select',
    message: 'How will you run Android tests?',
    choices: [
      { name: 'emulators', message: 'Emulators', hint: 'Tapsmith auto-launches emulators' },
      { name: 'physical', message: 'Physical devices', hint: 'USB-connected devices' },
      { name: 'both', message: 'Both' },
    ],
  });

  const useEmulators = deviceType === 'emulators' || deviceType === 'both';
  let avd: string | undefined;

  if (useEmulators && env.avds.length > 0) {
    const { choices, initial } = avdPickerChoices(env.avds, env.avdImages);
    avd = await ask<string>({
      type: 'select',
      message: 'Which AVD should Tapsmith auto-launch?',
      choices,
      initial,
    });
  } else if (useEmulators) {
    console.log(`  ${YELLOW}⚠${RESET} ${noAvdsListedMessage(env.avdImages)}`);
  }

  if (deviceType === 'physical' || deviceType === 'both') {
    console.log(dim('  Make sure USB debugging is enabled on your device.'));
  }

  const usePhysicalDevices = deviceType === 'physical' || deviceType === 'both';
  return { apkPath, packageName, useEmulators, usePhysicalDevices, avd };
}

export async function configureIos(env: EnvScan): Promise<IosConfig> {
  console.log(`  ${bold('iOS')}`);

  // Device type first: a physical-only user has no use for a simulator
  // build, and the device build is what their config must point at.
  const deviceType = await ask<string>({
    type: 'select',
    message: 'How will you run iOS tests?',
    choices: [
      { name: 'simulators', message: 'Simulators' },
      { name: 'physical', message: 'Physical devices', hint: 'requires code signing' },
      { name: 'both', message: 'Both' },
    ],
  });
  const useSimulators = deviceType === 'simulators' || deviceType === 'both';

  let appPath: string | undefined;
  let simBundleId: string | undefined;
  if (useSimulators) {
    appPath = await ask<string>({
      type: 'input',
      message: 'Where is your iOS .app bundle? (simulator build)',
      initial: './ios/build/Build/Products/Debug-iphonesimulator/MyApp.app',
      validate: (val: string) => val.trim().length > 0 || '.app path is required',
    });
    simBundleId = detectBundleId(appPath);
  }

  let simulator: string | undefined;
  if (useSimulators) {
    if (env.simulators.length > 0) {
      const seen = new Map<string, SimulatorInfo>();
      for (const sim of env.simulators) {
        const existing = seen.get(sim.name);
        if (!existing || sim.runtime.localeCompare(existing.runtime, undefined, { numeric: true }) > 0) {
          seen.set(sim.name, sim);
        }
      }
      const unique = [...seen.values()].slice(0, 20);
      simulator = await ask<string>({
        type: 'select',
        message: 'Which simulator?',
        choices: unique.map((s) => ({ name: s.name, message: s.name, hint: s.runtime })),
      });
    } else {
      console.log(`  ${YELLOW}⚠${RESET} No iOS simulators found. Install one via Xcode.`);
      simulator = 'iPhone 17';
    }
  }

  const usePhysicalDevice = deviceType === 'physical' || deviceType === 'both';
  let deviceAppPath: string | undefined;
  let deviceBundleIdRead: string | undefined;

  if (usePhysicalDevice) {
    console.log(`\n  ${bold('Physical iOS device preflight')}`);

    try {
      const {
        checkXcodeCommandLineTools,
        checkDevicectl,
        checkIproxy,
        checkSigningIdentities,
        checkDeviceConnection,
      } = await import('./setup-ios-device.js');

      const results = [
        checkXcodeCommandLineTools(),
        checkDevicectl(),
        checkIproxy(),
        checkSigningIdentities(),
        checkDeviceConnection(),
      ];

      let failures = 0;
      for (const r of results) {
        if (r.ok) {
          console.log(`  ${green('✓')} ${r.label}`);
        } else {
          failures++;
          console.log(`  ${RED}✗${RESET} ${r.label}${r.fix ? '\n    ' + r.fix.join('\n    ') : ''}`);
        }
      }
      if (failures > 0) {
        console.log(`\n  ${YELLOW}⚠${RESET} ${failures} preflight check(s) failed. Fix these before testing on physical devices.`);
      }
    } catch (err) {
      console.log(`  ${YELLOW}⚠${RESET} Could not run preflight: ${err instanceof Error ? err.message : String(err)}`);
    }

    const buildAgent = await ask<boolean>({
      type: 'confirm',
      message: 'Build the iOS agent for physical devices? (requires Xcode, ~30s)',
      initial: true,
    });

    if (buildAgent) {
      console.log(dim('  Building iOS agent...'));
      try {
        const { buildIosAgent } = await import('./build-ios-agent.js');
        await buildIosAgent({ quiet: true });
        console.log(`  ${green('✓')} iOS agent built`);
      } catch (err) {
        console.log(`  ${YELLOW}⚠${RESET} iOS agent build failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log(dim('  You can run `npx tapsmith ios build-agent` later.'));
      }
    }

    deviceAppPath = await ask<string>({
      type: 'input',
      message: 'Where is your device build .app? (must be an iphoneos build, not simulator)',
      initial: './ios/build/Build/Products/Release-iphoneos/MyApp.app',
      validate: (val: string) => {
        if (val.trim().length === 0) return 'Device app path is required';
        if (val.includes('iphonesimulator')) return 'This looks like a simulator build — physical devices need an iphoneos build';
        return true;
      },
    });
    deviceBundleIdRead = detectBundleId(deviceAppPath);
  }

  // Each build's id is read from its Info.plist, else asked for. Simulator
  // and device builds can carry different ids (Debug vs Release), so one
  // never silently stands in for the other; the unread one's prompt is only
  // pre-filled with it.
  const both = useSimulators && usePhysicalDevice;
  const askBundleId = async (message: string, initial: string | undefined): Promise<string> => (await ask<string>({
    type: 'input',
    message,
    initial: initial ?? 'com.example.myapp',
    validate: (val: string) => val.trim().length > 0 || 'Bundle ID is required',
  })).trim();
  if (useSimulators && !simBundleId) {
    simBundleId = await askBundleId(
      both ? 'What is your simulator build\'s bundle identifier?' : 'What is your app\'s bundle identifier?',
      deviceBundleIdRead,
    );
  }
  if (usePhysicalDevice && !deviceBundleIdRead) {
    deviceBundleIdRead = await askBundleId(
      both ? 'What is your device build\'s bundle identifier?' : 'What is your app\'s bundle identifier?',
      simBundleId,
    );
  }
  const bundleId = simBundleId ?? deviceBundleIdRead;
  const deviceBundleId = both && deviceBundleIdRead !== simBundleId ? deviceBundleIdRead : undefined;

  return { appPath, bundleId, deviceBundleId, simulator, usePhysicalDevice, deviceAppPath };
}

function detectBundleId(appPath: string): string | undefined {
  const detected = detectIosBundleId(appPath);
  if (detected) console.log(dim(`  Detected bundle ID: ${detected}`));
  return detected;
}

// ─── Network capture setup ───

async function setupNetworkCapture(
  platforms: Platform[],
  env: EnvScan,
  androidConfig: AndroidConfig | undefined,
  iosHasPhysicalDevice: boolean,
): Promise<boolean> {
  const enableNetwork = await ask<boolean>({
    type: 'confirm',
    message: 'Enable network trace capture? (records HTTP/HTTPS traffic during tests)',
    initial: true,
  });

  if (!enableNetwork) return false;

  const lines: string[] = [];

  if (platforms.includes('android') && androidConfig) {
    if (androidConfig.useEmulators) {
      lines.push(androidEmulatorCaptureLine(androidConfig.avd, env.avdImages));
    }
    if (androidConfig.usePhysicalDevices) {
      lines.push(`  ${YELLOW}⚠${RESET} Android physical — add the Tapsmith CA to your app's res/xml/network_security_config.xml:`);
      lines.push(dim('    <network-security-config>'));
      lines.push(dim('      <debug-overrides><trust-anchors>'));
      lines.push(dim('        <certificates src="user" />'));
      lines.push(dim('      </trust-anchors></debug-overrides>'));
      lines.push(dim('    </network-security-config>'));
    }
  }

  if (platforms.includes('ios') && env.isMacOS) {
    const hasMitmproxy = !!tryExec('brew', ['list', 'mitmproxy']);
    if (hasMitmproxy) {
      lines.push(`  ${green('✓')} iOS simulator — mitmproxy ready`);
    } else {
      lines.push(`  ${YELLOW}⚠${RESET} iOS simulator — run \`brew install mitmproxy\` then \`npx tapsmith ios network setup-simulator\``);
    }
  }

  if (iosHasPhysicalDevice) {
    lines.push(`  ${YELLOW}⚠${RESET} iOS physical — run \`npx tapsmith ios network configure <udid>\` per device`);
  }

  if (lines.length > 0) {
    console.log(`\n  ${bold('Network capture')}`);
    console.log(lines.join('\n'));
  }

  return true;
}

// ─── iOS simulator agent ───

export async function ensureSimulatorAgent(
  simulator: string | undefined,
): Promise<{ status: 'present' | 'built' | 'failed'; error?: string }> {
  const { findSimulatorXctestrun } = await import('./ios-device-resolve.js');
  if (findSimulatorXctestrun()) return { status: 'present' };
  try {
    const { resolveIosAgentDir } = await import('./build-ios-agent.js');
    const iosAgentDir = resolveIosAgentDir();
    const createScript = path.join(iosAgentDir, 'create-xcode-project.sh');
    if (fs.existsSync(createScript)) {
      try { execFileSync('sh', [createScript], { cwd: iosAgentDir, stdio: 'ignore' }); } catch { /* optional — xcodebuild will fail below if needed */ }
    }
    const dest = simulator ? `platform=iOS Simulator,name=${simulator}` : 'platform=iOS Simulator';
    execFileSync('xcodebuild', [
      'build-for-testing',
      '-project', path.join(iosAgentDir, 'TapsmithAgent.xcodeproj'),
      '-scheme', 'TapsmithAgentUITests',
      '-destination', dest,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    return { status: 'built' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Config generation ───

/**
 * The iOS targets the user picked. A scope with no `simulator` is a
 * physical-device run (the runner auto-detects the paired device), so a
 * simulator target needs both the simulator build and a simulator, and the
 * device target must not inherit either.
 */
function iosTargets(ios: IosConfig | undefined): { sim?: { app: string; simulator: string }; deviceApp?: string } {
  return {
    sim: ios?.appPath && ios.simulator ? { app: ios.appPath, simulator: ios.simulator } : undefined,
    deviceApp: ios?.usePhysicalDevice ? ios.deviceAppPath : undefined,
  };
}

/**
 * The `--project` names generateConfig() writes, with a label for the
 * wizard's next steps. Empty when the config has no projects.
 */
export function generatedProjects(
  platforms: Platform[],
  ios: IosConfig | undefined,
): Array<{ name: string; label: string }> {
  const { sim, deviceApp } = iosTargets(ios);
  const device = !!deviceApp;
  const multi = platforms.length > 1;
  if (!multi && !(platforms[0] === 'ios' && sim && device)) return [];
  const out: Array<{ name: string; label: string }> = [];
  if (multi) out.push({ name: 'android', label: 'Run Android only' });
  if (sim) out.push({ name: 'ios', label: device ? 'Run iOS simulator only' : 'Run iOS only' });
  if (device) out.push({ name: 'ios-device', label: sim ? 'Run iOS device only' : 'Run iOS only' });
  return out;
}

export function generateConfig(
  platforms: Platform[],
  android: AndroidConfig | undefined,
  ios: IosConfig | undefined,
  enableNetwork: boolean,
): string {
  const lines: string[] = [];
  lines.push("import { defineConfig } from 'tapsmith'");
  lines.push('');
  lines.push('export default defineConfig({');

  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  if (enableNetwork) lines.push("  trace: { mode: 'retain-on-failure' },");

  const { sim: iosSim, deviceApp: iosDeviceApp } = iosTargets(ios);
  const iosDevicePkg = ios?.deviceBundleId ?? ios?.bundleId;

  const iosProjects = (out: string[], iosCfg: IosConfig): void => {
    if (iosSim) {
      out.push('    {');
      out.push("      name: 'ios',");
      out.push("      testMatch: ['**/*.test.ts'],");
      out.push('      use: {');
      out.push("        platform: 'ios',");
      if (iosCfg.bundleId) out.push(`        package: '${esc(iosCfg.bundleId)}',`);
      out.push(`        app: '${esc(iosSim.app)}',`);
      out.push(`        simulator: '${esc(iosSim.simulator)}',`);
      out.push('      },');
      out.push('    },');
    }
    if (iosDeviceApp) {
      out.push('    {');
      out.push("      name: 'ios-device',");
      out.push("      testMatch: ['**/*.test.ts'],");
      out.push('      workers: 1,');
      out.push('      use: {');
      out.push("        platform: 'ios',");
      if (iosDevicePkg) out.push(`        package: '${esc(iosDevicePkg)}',`);
      out.push(`        app: '${esc(iosDeviceApp)}',`);
      out.push('      },');
      out.push('    },');
    }
  };

  if (platforms.length === 1 && android) {
    if (android.packageName) lines.push(`  package: '${esc(android.packageName)}',`);
    lines.push(`  apk: '${esc(android.apkPath)}',`);
    if (android.useEmulators && android.avd) {
      lines.push(`  avd: '${esc(android.avd)}',`);
    }
  }

  if (platforms.length === 1 && ios) {
    if (iosSim && iosDeviceApp) {
      // Simulator and device: one project each, as in the multi-platform
      // config and docs/ios-physical-devices.md.
      lines.push('  projects: [');
      iosProjects(lines, ios);
      lines.push('  ],');
    } else {
      lines.push("  platform: 'ios',");
      const pkg = iosDeviceApp ? iosDevicePkg : ios.bundleId;
      if (pkg) lines.push(`  package: '${esc(pkg)}',`);
      if (iosDeviceApp) {
        lines.push(`  app: '${esc(iosDeviceApp)}',`);
      } else if (ios.appPath) {
        lines.push(`  app: '${esc(ios.appPath)}',`);
        if (ios.simulator) lines.push(`  simulator: '${esc(ios.simulator)}',`);
      }
    }
  }

  if (platforms.length > 1 && android && ios) {
    lines.push('  projects: [');

    lines.push('    {');
    lines.push("      name: 'android',");
    lines.push("      testMatch: ['**/*.test.ts'],");
    lines.push('      use: {');
    lines.push("        platform: 'android',");
    if (android.packageName) lines.push(`        package: '${esc(android.packageName)}',`);
    lines.push(`        apk: '${esc(android.apkPath)}',`);
    if (android.useEmulators && android.avd) {
      lines.push(`        avd: '${esc(android.avd)}',`);
    }
    lines.push('      },');
    lines.push('    },');

    iosProjects(lines, ios);

    lines.push('  ],');
  }

  lines.push('})');
  lines.push('');
  return lines.join('\n');
}

export function generateExampleTest(): string {
  return `import { test, expect } from 'tapsmith'

test('app launches successfully', async ({ device }) => {
  // Smoke check: the app rendered at least one text element after launch.
  // Replace this with assertions specific to your app's first screen.
  await expect(device.getByRole('text').first()).toBeVisible()
})
`;
}

// ─── Main wizard ───

const UNEXPECTED_FIX = 'Run: npx tapsmith doctor --json to check the environment';

export async function runInit(opts: InitCommandOptions): Promise<void> {
  const { initArgsFromOptions, resolveInitPlan, executeInitPlan, InitError } = await import('./init-noninteractive.js');

  let parsed;
  try {
    parsed = initArgsFromOptions(opts);
  } catch (err) {
    const initErr = err instanceof InitError
      ? err
      : new InitError('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err), { fix: UNEXPECTED_FIX });
    emitInitError(initErr, opts.json);
    process.exit(1);
    return;
  }

  const nonInteractive = parsed.yes || parsed.anySetupFlag;

  if (!nonInteractive && parsed.json && process.stdin.isTTY) {
    // The wizard's prompts cannot be JSON, and --json promises nothing else on stdout.
    const err = new InitError(
      'JSON_REQUIRES_YES',
      '--json needs a non-interactive run: the interactive wizard has no JSON output',
      { fix: 'Run: npx tapsmith init --yes --json (or pass a setup flag such as --platform)' },
    );
    emitInitError(err, true);
    process.exit(1);
  }

  if (!nonInteractive && !process.stdin.isTTY) {
    const err = new InitError(
      'NON_INTERACTIVE_TTY',
      'tapsmith init is an interactive wizard and stdin is not a TTY',
      { fix: 'Run non-interactively: npx tapsmith init --yes (see npx tapsmith init --help for all flags)' },
    );
    emitInitError(err, parsed.json);
    process.exit(1);
  }

  if (nonInteractive) {
    try {
      const env = scanEnvironment();
      const plan = resolveInitPlan(parsed, env);

      // Guard BEFORE the iOS agent build so a 5-minute xcodebuild is never
      // launched against a project that already has a config (unless --force).
      const { assertConfigWritable } = await import('./init-noninteractive.js');
      assertConfigWritable(parsed.force);

      if (plan.platforms.includes('ios')) {
        const agentResult = await ensureSimulatorAgent(plan.ios?.simulator);
        if (agentResult.status === 'failed') {
          plan.warnings.push(`iOS simulator agent build failed (${agentResult.error ?? 'unknown error'}) — it will be retried on first test run`);
        }
      }

      const result = executeInitPlan(plan, parsed);

      if (parsed.json) {
        process.stdout.write(formatJson(result));
      } else {
        for (const f of result.filesCreated) console.log(`  ${green('✓')} ${f}`);
        for (const w of result.warnings) console.log(`  ${YELLOW}⚠${RESET} ${w}`);
        console.log();
        console.log(`  ${bold('Next steps')}`);
        for (const s of result.nextSteps) console.log(`  - ${s}`);
      }
      return;
    } catch (err) {
      const initErr = err instanceof InitError
        ? err
        : new InitError('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err), { fix: UNEXPECTED_FIX });
      emitInitError(initErr, parsed.json);
      process.exit(1);
    }
  }

  // Interactive wizard (unchanged path)
  try {
    await runInitInner();
  } catch (err) {
    console.log();
    if (err === '' || (err instanceof Error && err.message === '')) {
      console.log(dim('  Setup cancelled.'));
    } else {
      console.error(`  ${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
    process.exit(1);
  }
}

function emitInitError(err: { code: string; message: string; fix?: string; candidates?: string[] }, json: boolean): void {
  if (json) {
    process.stdout.write(formatJson(jsonError(err.code, err.message, { fix: err.fix, candidates: err.candidates })));
  } else {
    console.error(`  ${RED}✗${RESET} ${err.message}`);
    if (err.candidates) for (const c of err.candidates) console.error(`      - ${c}`);
    if (err.fix) console.error(`  ${YELLOW}→${RESET} ${err.fix}`);
  }
}

async function runInitInner(): Promise<void> {
  console.log();
  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  console.log(banner.split('\n').map((l) => `${GREEN}${l}${RESET}`).join('\n'));
  console.log(dim(`v${getVersion()}`));

  // Check for existing config
  const configNames = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js'];
  const existingConfig = configNames.find((name) => fs.existsSync(path.resolve(process.cwd(), name)));
  if (existingConfig) {
    const overwrite = await ask<boolean>({
      type: 'confirm',
      message: `Found existing ${existingConfig}. Overwrite it?`,
      initial: false,
    });
    if (!overwrite) {
      console.log(dim('  Keeping existing config. Run `npx tapsmith doctor` to verify your setup.'));
      return;
    }
  }

  // Step 1: Environment scan
  const env = scanEnvironment();
  displayEnvironment(env);

  // Step 2: Platform selection
  const platformChoices: Array<{ name: string; message: string; hint?: string }> = [
    { name: 'android', message: 'Android' },
  ];
  if (env.isMacOS) {
    platformChoices.push({ name: 'ios', message: 'iOS' });
    platformChoices.push({ name: 'both', message: 'Both' });
  }

  const platformChoice = await ask<string>({
    type: 'select',
    message: 'Which platform(s) will you test?',
    choices: platformChoices,
  });

  const selectedPlatforms: Platform[] = platformChoice === 'both'
    ? ['android', 'ios']
    : [platformChoice as Platform];

  // Step 3 & 4: Platform configuration
  let androidConfig: AndroidConfig | undefined;
  let iosConfig: IosConfig | undefined;

  if (selectedPlatforms.includes('android')) {
    androidConfig = await configureAndroid(env);
  }
  if (selectedPlatforms.includes('ios')) {
    iosConfig = await configureIos(env);
  }

  // Step 5: Network capture
  const iosHasPhysicalDevice = iosConfig?.usePhysicalDevice ?? false;
  const enableNetwork = await setupNetworkCapture(selectedPlatforms, env, androidConfig, iosHasPhysicalDevice);

  // Step 6: iOS simulator agent check
  if (selectedPlatforms.includes('ios') && iosConfig && (iosConfig.simulator || !iosConfig.usePhysicalDevice)) {
    try {
      const { findSimulatorXctestrun } = await import('./ios-device-resolve.js');
      const xctestrun = findSimulatorXctestrun();
      if (!xctestrun) {
        const buildSim = await ask<boolean>({
          type: 'confirm',
          message: 'No iOS simulator agent found. Build it now? (~30s, requires Xcode)',
          initial: true,
        });

        if (buildSim) {
          console.log(dim('  Building iOS simulator agent...'));
          const result = await ensureSimulatorAgent(iosConfig.simulator);
          if (result.status === 'built' || result.status === 'present') {
            console.log(`  ${green('✓')} iOS simulator agent built`);
          } else if (result.error) {
            console.log(`  ${YELLOW}⚠${RESET} Build failed: ${result.error}`);
          } else {
            console.log(`  ${YELLOW}⚠${RESET} Build failed`);
          }
        }
      }
    } catch {
      // ios-device-resolve import failed — skip
    }
  }

  // Step 7: Generate config
  const configContent = generateConfig(selectedPlatforms, androidConfig, iosConfig, enableNetwork);

  try {
    fs.writeFileSync(path.resolve(process.cwd(), 'tapsmith.config.ts'), configContent);
    console.log(`  ${green('✓')} tapsmith.config.ts created`);
  } catch (err) {
    console.log(`  ${RED}✗${RESET} Failed to write tapsmith.config.ts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 8: Example test
  const createTest = await ask<boolean>({
    type: 'confirm',
    message: 'Generate example test file?',
    initial: true,
  });

  if (createTest) {
    const testDir = path.resolve(process.cwd(), 'tests');
    const testPath = path.resolve(testDir, 'example.test.ts');

    if (fs.existsSync(testPath)) {
      console.log(`  ${YELLOW}⚠${RESET} tests/example.test.ts already exists, skipping.`);
    } else {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testPath, generateExampleTest());
      console.log(`  ${green('✓')} tests/example.test.ts created`);
    }
  }

  // Step 8.5: AGENTS.md for coding agents
  const writeAgents = await ask<boolean>({
    type: 'confirm',
    message: 'Add a Tapsmith section to AGENTS.md? (helps AI coding agents use Tapsmith correctly)',
    initial: true,
  });
  if (writeAgents) {
    const { writeAgentsMd } = await import('./agents-md.js');
    writeAgentsMd(process.cwd());
    console.log(`  ${green('✓')} AGENTS.md updated`);
  }

  // Step 9: Next steps
  console.log();
  console.log(`  ${bold('Next steps')}`);
  console.log(`  Run your tests:     ${green('npx tapsmith test')}`);
  console.log(`  List devices:       ${green('npx tapsmith list-devices')}`);
  console.log(`  Health check:       ${green('npx tapsmith doctor')}`);

  const projects = generatedProjects(selectedPlatforms, iosConfig);
  if (projects.length > 0) {
    console.log();
    const width = Math.max(...projects.map((p) => p.label.length)) + 1;
    for (const { name, label } of projects) {
      console.log(`  ${`${label}:`.padEnd(width + 2)} ${green(`npx tapsmith test --project ${name}`)}`);
    }
  }

  console.log();
  console.log(dim('  Happy testing!'));
  console.log();
}
