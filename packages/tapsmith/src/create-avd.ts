/**
 * `tapsmith create-avd` — create an Android AVD suited for Tapsmith.
 *
 * HTTPS network capture requires `adb root`, which only Google APIs
 * (`google_apis`) and AOSP emulator images support — Google Play
 * (`google_apis_playstore`) images are production builds that block root, so
 * Tapsmith can neither install its CA certificate nor set up the iptables
 * redirect on them. Android Studio's Device Manager preselects Play images
 * for most phone profiles, which silently degrades capture to plain HTTP.
 *
 * This wrapper downloads the right system image for the host architecture
 * via `sdkmanager` (the user accepts Google's SDK license through their own
 * SDK — the image cannot be redistributed) and creates the AVD via
 * `avdmanager`, then prints a ready-to-paste config snippet.
 *
 * Non-goals:
 *   - Installing the Android SDK / cmdline-tools themselves.
 *   - Managing emulator snapshots or hardware profiles beyond `-d`.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanAvdImageTags } from './doctor.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;

// ─── Options ─────────────────────────────────────────────────────────────

export interface CreateAvdOptions {
  /** Android API level of the system image. */
  api: number;
  /** AVD name. Defaults to Tapsmith_Phone_API_<api>. */
  name: string;
  /** avdmanager device profile (hardware definition). */
  device: string;
  /** System image ABI. Defaults to the host architecture's ABI. */
  abi: string;
  /** Overwrite an existing AVD with the same name. */
  force: boolean;
  help: boolean;
}

export const DEFAULT_API_LEVEL = 36;
export const DEFAULT_DEVICE_PROFILE = 'medium_phone';

/** Map the host architecture to the matching emulator image ABI. */
export function defaultAbi(arch: string = process.arch): string {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function defaultAvdName(api: number): string {
  return `Tapsmith_Phone_API_${api}`;
}

/** sdkmanager package path for the Google APIs (rootable) system image. */
export function systemImagePackage(api: number, abi: string): string {
  return `system-images;android-${api};google_apis;${abi}`;
}

// avdmanager rejects names outside this set.
const AVD_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function parseCreateAvdArgs(argv: string[]): CreateAvdOptions {
  let api = DEFAULT_API_LEVEL;
  let name: string | undefined;
  let device = DEFAULT_DEVICE_PROFILE;
  let abi: string | undefined;
  let force = false;
  let help = false;

  const take = (i: number, flag: string): string => {
    const value = argv[i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
      i += 1;
    } else if (arg === '--force') {
      force = true;
      i += 1;
    } else if (arg === '--api') {
      api = parseApiLevel(take(i + 1, '--api'));
      i += 2;
    } else if (arg.startsWith('--api=')) {
      api = parseApiLevel(arg.slice('--api='.length));
      i += 1;
    } else if (arg === '--name') {
      name = take(i + 1, '--name');
      i += 2;
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      i += 1;
    } else if (arg === '--device') {
      device = take(i + 1, '--device');
      i += 2;
    } else if (arg.startsWith('--device=')) {
      device = arg.slice('--device='.length);
      i += 1;
    } else if (arg === '--abi') {
      abi = take(i + 1, '--abi');
      i += 2;
    } else if (arg.startsWith('--abi=')) {
      abi = arg.slice('--abi='.length);
      i += 1;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const resolvedName = name ?? defaultAvdName(api);
  if (!AVD_NAME_RE.test(resolvedName)) {
    throw new Error(`Invalid AVD name "${resolvedName}" — use only letters, digits, ".", "_" and "-"`);
  }

  return { api, name: resolvedName, device, abi: abi ?? defaultAbi(), force, help };
}

function parseApiLevel(value: string): number {
  const api = Number.parseInt(value, 10);
  if (!Number.isInteger(api) || api <= 0 || String(api) !== value.trim()) {
    throw new Error(`Invalid API level "${value}" — expected a positive integer (e.g. --api 36)`);
  }
  return api;
}

// ─── SDK tool resolution ─────────────────────────────────────────────────

/**
 * Locate an Android SDK command-line tool (`sdkmanager` / `avdmanager`).
 *
 * Checks the standard cmdline-tools locations under `$ANDROID_HOME` /
 * `$ANDROID_SDK_ROOT` first, then falls back to bare invocation so a tool
 * already on PATH still works.
 */
export function findSdkTool(tool: string, env: NodeJS.ProcessEnv = process.env): string {
  const suffix = process.platform === 'win32' ? '.bat' : '';
  const sdkRoot = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (sdkRoot) {
    const candidates = [
      path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', `${tool}${suffix}`),
      path.join(sdkRoot, 'cmdline-tools', 'bin', `${tool}${suffix}`),
      path.join(sdkRoot, 'tools', 'bin', `${tool}${suffix}`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return `${tool}${suffix}`;
}

/**
 * Where sdkmanager unpacks a system image. Present iff the image is already
 * installed, letting createAvd skip the sdkmanager step (and its
 * cmdline-tools requirement) entirely.
 */
export function systemImageDir(sdkRoot: string, api: number, abi: string): string {
  return path.join(sdkRoot, 'system-images', `android-${api}`, 'google_apis', abi);
}

// Android Studio installs the SDK without cmdline-tools by default, so this
// is the most common failure mode for Studio-managed SDKs.
const CMDLINE_TOOLS_HINT =
  'Install "Android SDK Command-line Tools (latest)" from Android Studio '
  + '(Settings → Languages & Frameworks → Android SDK → SDK Tools tab), '
  + 'or download them from https://developer.android.com/tools/sdkmanager '
  + 'and set ANDROID_HOME.';

// ─── Subprocess helpers ──────────────────────────────────────────────────

/**
 * Run a tool with output streamed to the terminal. `stdinResponse` is written
 * to the child's stdin (avdmanager prompts "Do you wish to create a custom
 * hardware profile" even in scripted use).
 */
function run(command: string, args: string[], stdinResponse?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdinResponse === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    if (stdinResponse !== undefined && child.stdin) {
      child.stdin.write(stdinResponse);
      child.stdin.end();
    }
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`${command} not found. ${CMDLINE_TOOLS_HINT}`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

// ─── Main flow ───────────────────────────────────────────────────────────

export async function createAvd(opts: CreateAvdOptions): Promise<void> {
  const image = systemImagePackage(opts.api, opts.abi);

  const existing = scanAvdImageTags().find((avd) => avd.name === opts.name);
  if (existing && !opts.force) {
    throw new Error(
      `AVD "${opts.name}" already exists`
      + (existing.tagId ? ` (image tag: ${existing.tagId})` : '')
      + '. Re-run with --force to overwrite it, or pick another name with --name.',
    );
  }

  const avdmanager = findSdkTool('avdmanager');

  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const imageAlreadyInstalled = !!sdkRoot && fs.existsSync(systemImageDir(sdkRoot, opts.api, opts.abi));

  console.log();
  if (imageAlreadyInstalled) {
    console.log(`${bold('Step 1/2')} System image already installed ${dim(`(${image})`)}`);
  } else {
    const sdkmanager = findSdkTool('sdkmanager');
    console.log(`${bold('Step 1/2')} Install system image ${dim(`(${image})`)}`);
    console.log(dim('sdkmanager may prompt you to accept the Android SDK license.'));
    await run(sdkmanager, [image]);
  }

  console.log();
  console.log(`${bold('Step 2/2')} Create AVD ${dim(`(${opts.name}, device profile ${opts.device})`)}`);
  const args = ['create', 'avd', '-n', opts.name, '-k', image, '-d', opts.device];
  if (opts.force) args.push('--force');
  await run(avdmanager, args, 'no\n');

  console.log();
  console.log(green(`✓ AVD ${opts.name} created`));
  console.log();
  console.log('Point Tapsmith at it in tapsmith.config.ts:');
  console.log();
  console.log(dim('  export default defineConfig({'));
  console.log(`    avd: ${dim("'")}${opts.name}${dim("',")}`);
  console.log(dim('  })'));
  console.log();
  console.log(dim(`Google APIs images support adb root, so HTTPS network capture works out of the box.`));
}

// ─── CLI entry ───────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold('tapsmith create-avd')} — Create an Android AVD that supports HTTPS network capture.

Downloads a Google APIs system image (rootable, unlike the Google Play images
Android Studio preselects) with sdkmanager and creates the AVD with avdmanager.
Requires the Android SDK command-line tools (ANDROID_HOME or on PATH).

${bold('Usage:')}
  tapsmith create-avd [options]

${bold('Options:')}
  --api <level>      Android API level (default: ${DEFAULT_API_LEVEL})
  --name <name>      AVD name (default: Tapsmith_Phone_API_<api>)
  --device <profile> avdmanager device profile (default: ${DEFAULT_DEVICE_PROFILE})
  --abi <abi>        System image ABI (default: ${defaultAbi()} for this machine)
  --force            Overwrite an existing AVD with the same name
  --help, -h         Show this help
`);
}

export async function runCreateAvd(argv: string[]): Promise<void> {
  let opts: CreateAvdOptions;
  try {
    opts = parseCreateAvdArgs(argv);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    printHelp();
    process.exit(1);
  }
  if (opts.help) {
    printHelp();
    return;
  }

  try {
    await createAvd(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(msg));
    process.exit(1);
  }
}
