import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findDaemonBin } from './daemon-bin.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';

// @clack/prompts is ESM-only — loaded dynamically in runInit() and
// assigned here so every helper in this module can reference it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let p: any;

// ─── Helpers ───

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function tryExec(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function bail(): never {
  p.cancel('Setup cancelled.');
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function guard<T>(value: T | symbol): T {
  if (typeof value === 'symbol') bail();
  return value as T;
}

// ─── Environment scanning ───

interface EnvScan {
  nodeVersion: string;
  daemonBin: string | undefined;
  agentApk: boolean;
  agentTestApk: boolean;
  adbVersion: string | undefined;
  androidHome: string | undefined;
  xcodeVersion: string | undefined;
  simulators: SimulatorInfo[];
  avds: string[];
  isMacOS: boolean;
}

interface SimulatorInfo {
  name: string;
  udid: string;
  state: string;
  runtime: string;
}

function scanEnvironment(): EnvScan {
  const isMacOS = process.platform === 'darwin';
  const nodeVersion = process.versions.node;

  let daemonBin: string | undefined;
  try {
    daemonBin = findDaemonBin();
  } catch {
    // not found
  }

  const agentApk = !!findAgentApk();
  const agentTestApk = !!findAgentTestApk();

  let adbVersion: string | undefined;
  const adbOut = tryExec('adb', ['--version']);
  if (adbOut) {
    const match = adbOut.match(/Version\s+([\d.]+)/);
    adbVersion = match?.[1] ?? 'installed';
  }

  const androidHome = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];

  let xcodeVersion: string | undefined;
  if (isMacOS) {
    const xcOut = tryExec('xcodebuild', ['-version']);
    if (xcOut) {
      const match = xcOut.match(/Xcode\s+([\d.]+)/);
      xcodeVersion = match?.[1] ?? 'installed';
    }
  }

  const simulators: SimulatorInfo[] = [];
  if (isMacOS) {
    const simOut = tryExec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
    if (simOut) {
      try {
        const data = JSON.parse(simOut);
        const devices = data.devices as Record<string, Array<{ name: string; udid: string; state: string }>>;
        for (const [runtime, devs] of Object.entries(devices)) {
          for (const d of devs) {
            const runtimeName = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, ' ');
            simulators.push({ name: d.name, udid: d.udid, state: d.state, runtime: runtimeName });
          }
        }
      } catch {
        // parse failure
      }
    }
  }

  let avds: string[] = [];
  const avdOut = tryExec('emulator', ['-list-avds']);
  if (avdOut) {
    avds = avdOut.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  return { nodeVersion, daemonBin, agentApk, agentTestApk, adbVersion, androidHome, xcodeVersion, simulators, avds, isMacOS };
}

function displayEnvironment(env: EnvScan): void {
  const lines: string[] = [];
  const ok = (msg: string): string => `  \x1b[32m✓\x1b[0m ${msg}`;
  const warn = (msg: string): string => `  \x1b[33m⚠\x1b[0m ${msg}`;
  const fail = (msg: string): string => `  \x1b[31m✗\x1b[0m ${msg}`;

  const major = parseInt(env.nodeVersion.split('.')[0], 10);
  lines.push(major >= 18 ? ok(`Node.js ${env.nodeVersion}`) : fail(`Node.js ${env.nodeVersion} (requires >= 18)`));
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

  p.log.step('Environment\n' + lines.join('\n'));
}

// ─── Platform-specific questions ───

type Platform = 'android' | 'ios';

interface AndroidConfig {
  apkPath: string;
  packageName?: string;
  useEmulators: boolean;
  avd?: string;
}

interface IosConfig {
  appPath: string;
  bundleId?: string;
  simulator?: string;
  usePhysicalDevice: boolean;
  deviceAppPath?: string;
}

async function configureAndroid(env: EnvScan): Promise<AndroidConfig> {
  p.log.step('\x1b[1mAndroid\x1b[0m');

  const apkPath = guard(await p.text({
    message: 'Where is your Android APK?',
    placeholder: './android/app/build/outputs/apk/debug/app-debug.apk',
    validate: (val: string | undefined) => {
      if (!val || val.trim().length === 0) return 'APK path is required';
      return undefined;
    },
  }));

  let packageName: string | undefined;
  const aapt = tryExec('aapt2', ['dump', 'badging', apkPath]);
  if (aapt) {
    const match = aapt.match(/package: name='([^']+)'/);
    if (match) {
      packageName = match[1];
      p.log.info(`Detected package: ${packageName}`);
    }
  }
  if (!packageName) {
    packageName = guard(await p.text({
      message: 'What is your app\'s package name?',
      placeholder: 'com.example.myapp',
      validate: (val: string | undefined) => {
        if (!val || val.trim().length === 0) return 'Package name is required';
        return undefined;
      },
    }));
  }

  const deviceType = guard(await p.select({
    message: 'How will you run tests?',
    options: [
      { value: 'emulators', label: 'Emulators', hint: 'Tapsmith auto-launches emulators' },
      { value: 'physical', label: 'Physical devices', hint: 'USB-connected devices' },
      { value: 'both', label: 'Both' },
    ],
  }));

  const useEmulators = deviceType === 'emulators' || deviceType === 'both';
  let avd: string | undefined;

  if (useEmulators && env.avds.length > 0) {
    avd = guard(await p.select({
      message: 'Which AVD should Tapsmith auto-launch?',
      options: env.avds.map((a: string) => ({ value: a, label: a })),
    }));
  } else if (useEmulators) {
    p.log.warn('No AVDs found. Create one in Android Studio, then set `avd` in your config.');
  }

  if (deviceType === 'physical' || deviceType === 'both') {
    p.log.info('Make sure USB debugging is enabled on your device.');
  }

  return { apkPath, packageName, useEmulators, avd };
}

async function configureIos(env: EnvScan): Promise<IosConfig> {
  p.log.step('\x1b[1miOS\x1b[0m');

  const appPath = guard(await p.text({
    message: 'Where is your iOS .app bundle? (simulator build)',
    placeholder: './ios/build/Build/Products/Debug-iphonesimulator/MyApp.app',
    validate: (val: string | undefined) => {
      if (!val || val.trim().length === 0) return '.app path is required';
      return undefined;
    },
  }));

  let bundleId: string | undefined;
  const plistPath = path.join(appPath, 'Info.plist');
  if (fs.existsSync(plistPath)) {
    const plistOut = tryExec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath]);
    if (plistOut) {
      bundleId = plistOut;
      p.log.info(`Detected bundle ID: ${bundleId}`);
    }
  }
  if (!bundleId) {
    bundleId = guard(await p.text({
      message: 'What is your app\'s bundle identifier?',
      placeholder: 'com.example.myapp',
      validate: (val: string | undefined) => {
        if (!val || val.trim().length === 0) return 'Bundle ID is required';
        return undefined;
      },
    }));
  }

  const deviceType = guard(await p.select({
    message: 'How will you run iOS tests?',
    options: [
      { value: 'simulators', label: 'Simulators' },
      { value: 'physical', label: 'Physical devices', hint: 'requires code signing' },
      { value: 'both', label: 'Both' },
    ],
  }));

  let simulator: string | undefined;
  if (deviceType === 'simulators' || deviceType === 'both') {
    if (env.simulators.length > 0) {
      const seen = new Map<string, SimulatorInfo>();
      for (const sim of env.simulators) {
        const existing = seen.get(sim.name);
        if (!existing || sim.runtime > existing.runtime) {
          seen.set(sim.name, sim);
        }
      }
      const unique = [...seen.values()].slice(0, 20);
      simulator = guard(await p.select({
        message: 'Which simulator?',
        options: unique.map((s: SimulatorInfo) => ({
          value: s.name,
          label: s.name,
          hint: s.runtime,
        })),
        maxItems: 10,
      }));
    } else {
      p.log.warn('No iOS simulators found. Install one via Xcode.');
      simulator = 'iPhone 17';
    }
  }

  const usePhysicalDevice = deviceType === 'physical' || deviceType === 'both';
  let deviceAppPath: string | undefined;

  if (usePhysicalDevice) {
    p.log.step('Physical iOS device preflight');

    const spin = p.spinner();
    spin.start('Running preflight checks...');

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

      const lines: string[] = [];
      let failures = 0;
      for (const r of results) {
        if (r.ok) {
          lines.push(`  \x1b[32m✓\x1b[0m ${r.label}`);
        } else {
          failures++;
          lines.push(`  \x1b[31m✗\x1b[0m ${r.label}${r.fix ? '\n    ' + r.fix.join('\n    ') : ''}`);
        }
      }
      spin.stop(failures > 0
        ? `${failures} preflight check(s) failed`
        : 'Preflight passed');
      p.log.message(lines.join('\n'));
    } catch (err) {
      spin.stop('Preflight failed');
      p.log.warn(`Could not run preflight: ${err instanceof Error ? err.message : String(err)}`);
    }

    const buildAgent = guard(await p.confirm({
      message: 'Build the iOS agent for physical devices? (requires Xcode, ~30s)',
      initialValue: true,
    }));

    if (buildAgent) {
      const spin2 = p.spinner();
      spin2.start('Building iOS agent...');
      try {
        const { buildIosAgent } = await import('./build-ios-agent.js');
        await buildIosAgent({ quiet: true });
        spin2.stop('iOS agent built');
      } catch (err) {
        spin2.stop('Build failed');
        p.log.warn(`iOS agent build failed: ${err instanceof Error ? err.message : String(err)}`);
        p.log.info('You can run `npx tapsmith build-ios-agent` later.');
      }
    }

    deviceAppPath = guard(await p.text({
      message: 'Where is your device build .app? (must be an iphoneos build, not simulator)',
      placeholder: './ios/build/Build/Products/Release-iphoneos/MyApp.app',
      validate: (val: string | undefined) => {
        if (!val || val.trim().length === 0) return 'Device app path is required';
        if (val.includes('iphonesimulator')) return 'This looks like a simulator build — physical devices need an iphoneos build';
        return undefined;
      },
    }));
  }

  return { appPath, bundleId, simulator, usePhysicalDevice, deviceAppPath };
}

// ─── Network capture setup ───

async function setupNetworkCapture(
  platforms: Platform[],
  env: EnvScan,
  iosHasPhysicalDevice: boolean,
): Promise<boolean> {
  const enableNetwork = guard(await p.confirm({
    message: 'Enable network trace capture? (records HTTP/HTTPS traffic during tests)',
    initialValue: false,
  }));

  if (!enableNetwork) return false;

  // Quick inline checks instead of delegating to the verbose setup commands
  const lines: string[] = [];

  if (platforms.includes('android')) {
    lines.push('  \x1b[32m✓\x1b[0m Android — works automatically');
  }

  if (platforms.includes('ios') && env.isMacOS) {
    const hasMitmproxy = !!tryExec('brew', ['list', 'mitmproxy']);
    if (hasMitmproxy) {
      lines.push('  \x1b[32m✓\x1b[0m iOS simulator — mitmproxy ready');
    } else {
      lines.push('  \x1b[33m⚠\x1b[0m iOS simulator — run `brew install mitmproxy` then `npx tapsmith setup-ios`');
    }
  }

  if (iosHasPhysicalDevice) {
    lines.push('  \x1b[33m⚠\x1b[0m iOS physical — run `npx tapsmith configure-ios-network <udid>` per device');
  }

  if (lines.length > 0) {
    p.log.step('Network capture\n' + lines.join('\n'));
  }

  return true;
}

// ─── Config generation ───

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

  const pkg = android?.packageName ?? ios?.bundleId;
  if (pkg) lines.push(`  package: '${esc(pkg)}',`);
  if (enableNetwork) lines.push("  trace: { mode: 'retain-on-failure' },");

  if (platforms.length === 1) {
    if (android) {
      lines.push(`  apk: '${esc(android.apkPath)}',`);
      if (android.useEmulators) {
        lines.push('  launchEmulators: true,');
        if (android.avd) lines.push(`  avd: '${esc(android.avd)}',`);
      }
    }
    if (ios) {
      lines.push(`  app: '${esc(ios.appPath)}',`);
      if (ios.simulator) lines.push(`  simulator: '${esc(ios.simulator)}',`);
    }
  }

  if (platforms.length > 1 && android && ios) {
    lines.push('  projects: [');

    lines.push('    {');
    lines.push("      name: 'android',");
    lines.push("      testMatch: ['**/*.test.ts'],");
    lines.push('      use: {');
    lines.push("        platform: 'android',");
    lines.push(`        apk: '${android.apkPath}',`);
    if (android.useEmulators) {
      lines.push('        launchEmulators: true,');
      if (android.avd) lines.push(`        avd: '${android.avd}',`);
    }
    lines.push('      },');
    lines.push('    },');

    lines.push('    {');
    lines.push("      name: 'ios',");
    lines.push("      testMatch: ['**/*.test.ts'],");
    lines.push('      use: {');
    lines.push("        platform: 'ios',");
    lines.push(`        app: '${ios.appPath}',`);
    if (ios.simulator) lines.push(`        simulator: '${ios.simulator}',`);
    lines.push('      },');
    lines.push('    },');

    if (ios.usePhysicalDevice && ios.deviceAppPath) {
      lines.push('    {');
      lines.push("      name: 'ios-device',");
      lines.push("      testMatch: ['**/*.test.ts'],");
      lines.push('      workers: 1,');
      lines.push('      use: {');
      lines.push("        platform: 'ios',");
      lines.push(`        app: '${esc(ios.deviceAppPath)}',`);
      lines.push('      },');
      lines.push('    },');
    }

    lines.push('  ],');
  }

  lines.push('})');
  lines.push('');
  return lines.join('\n');
}

export function generateExampleTest(): string {
  return `import { test, expect } from 'tapsmith'

test('app launches successfully', async ({ device }) => {
  const element = device.getByRole('any')
  await expect(element).toBeVisible()
})
`;
}

// ─── Main wizard ───

export async function runInit(): Promise<void> {
  p = await import('@clack/prompts');

  p.intro(`\x1b[1mTapsmith\x1b[0m v${getVersion()}`);

  // Check for existing config
  const configNames = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js'];
  const existingConfig = configNames.find((name) => fs.existsSync(path.resolve(process.cwd(), name)));
  if (existingConfig) {
    const overwrite = guard(await p.confirm({
      message: `Found existing ${existingConfig}. Overwrite it?`,
      initialValue: false,
    }));
    if (!overwrite) {
      p.outro('Keeping existing config. Run `npx tapsmith doctor` to verify your setup.');
      return;
    }
  }

  // Step 1: Environment scan
  const spin = p.spinner();
  spin.start('Scanning environment...');
  const env = scanEnvironment();
  spin.stop('Environment scanned');
  displayEnvironment(env);

  // Step 2: Platform selection
  const availablePlatforms: Array<{ value: Platform; label: string; hint?: string }> = [];
  if (env.adbVersion) {
    availablePlatforms.push({ value: 'android', label: 'Android' });
  } else {
    availablePlatforms.push({ value: 'android', label: 'Android', hint: 'ADB not found — install Android SDK platform-tools' });
  }
  if (env.isMacOS) {
    if (env.xcodeVersion) {
      availablePlatforms.push({ value: 'ios', label: 'iOS' });
    } else {
      availablePlatforms.push({ value: 'ios', label: 'iOS', hint: 'Xcode not found' });
    }
  }

  if (availablePlatforms.length === 0) {
    p.log.error('No platform tools detected. Install ADB (Android) or Xcode (iOS) first.');
    p.outro('');
    process.exit(1);
  }

  const selectedPlatforms: Platform[] = guard(await p.multiselect({
    message: 'Which platforms will you test?',
    options: availablePlatforms,
    required: true,
  }));

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
  const enableNetwork = await setupNetworkCapture(selectedPlatforms, env, iosHasPhysicalDevice);

  // Step 6: iOS simulator agent check
  if (selectedPlatforms.includes('ios') && iosConfig && !iosConfig.usePhysicalDevice) {
    try {
      const { findSimulatorXctestrun } = await import('./ios-device-resolve.js');
      const xctestrun = findSimulatorXctestrun();
      if (!xctestrun) {
        const buildSim = guard(await p.confirm({
          message: 'No iOS simulator agent found. Build it now? (~30s, requires Xcode)',
          initialValue: true,
        }));

        if (buildSim) {
          const simSpin = p.spinner();
          simSpin.start('Building iOS simulator agent...');
          try {
            const { resolveIosAgentDir } = await import('./build-ios-agent.js');
            const iosAgentDir = resolveIosAgentDir();
            const dest = iosConfig.simulator
              ? `platform=iOS Simulator,name=${iosConfig.simulator}`
              : 'platform=iOS Simulator';
            execFileSync('bash', ['-c',
              `cd "${iosAgentDir}" && ` +
              `./create-xcode-project.sh 2>/dev/null; ` +
              `xcodebuild build-for-testing ` +
              `-project TapsmithAgent.xcodeproj ` +
              `-scheme TapsmithAgentUITests ` +
              `-destination '${dest}' 2>&1`,
            ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
            simSpin.stop('iOS simulator agent built');
          } catch (err) {
            simSpin.stop('Build failed');
            p.log.warn(`iOS simulator agent build failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch {
      // ios-device-resolve import failed — skip
    }
  }

  // Step 7: Generate config
  const configContent = generateConfig(selectedPlatforms, androidConfig, iosConfig, enableNetwork);
  p.log.step('Generated config:');
  p.note(configContent, 'tapsmith.config.ts');

  const confirmConfig = guard(await p.confirm({
    message: 'Write tapsmith.config.ts?',
    initialValue: true,
  }));

  if (confirmConfig) {
    fs.writeFileSync(path.resolve(process.cwd(), 'tapsmith.config.ts'), configContent);
    p.log.success('tapsmith.config.ts created');
  }

  // Step 8: Example test
  const createTest = guard(await p.confirm({
    message: 'Generate example test file?',
    initialValue: true,
  }));

  if (createTest) {
    const testDir = path.resolve(process.cwd(), 'tests');
    const testPath = path.resolve(testDir, 'example.test.ts');

    if (fs.existsSync(testPath)) {
      p.log.warn('tests/example.test.ts already exists, skipping.');
    } else {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testPath, generateExampleTest());
      p.log.success('tests/example.test.ts created');
    }
  }

  // Step 9: Next steps
  const nextSteps = [
    'Run your tests:     npx tapsmith test',
    'List devices:       npx tapsmith list-devices',
    'Health check:       npx tapsmith doctor',
  ];

  if (selectedPlatforms.length > 1) {
    nextSteps.push('');
    nextSteps.push('Run Android only:   npx tapsmith test --project android');
    nextSteps.push('Run iOS only:       npx tapsmith test --project ios');
  }

  p.note(nextSteps.join('\n'), 'Next steps');
  p.outro('Happy testing!');
}
