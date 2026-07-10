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
 * Android Studio installs the SDK *without* the command-line tools, so for
 * most Studio users `sdkmanager`/`avdmanager` don't exist at all. Rather than
 * bounce them to a download page, the command offers to bootstrap the
 * cmdline-tools zip from Google's repository into `$ANDROID_HOME` itself
 * (interactive consent, or `--install-tools` for scripts), and falls back to
 * Android Studio's bundled JDK when no `java` is on PATH.
 *
 * Non-goals:
 *   - Installing the Android SDK itself (an SDK root must already exist).
 *   - Managing emulator snapshots or hardware profiles beyond `-d`.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import Enquirer from 'enquirer';
import { scanAvdImageTags } from './doctor.js';

const enquirer = new Enquirer();

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
  /** Install the Android SDK cmdline-tools without prompting when missing. */
  installTools: boolean;
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
  let installTools = false;
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
    } else if (arg === '--install-tools') {
      installTools = true;
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

  return { api, name: resolvedName, device, abi: abi ?? defaultAbi(), force, installTools, help };
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

/** True when the bare command resolves on PATH. */
function isOnPath(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve an SDK tool and verify it is actually runnable. */
function resolveAvailableSdkTool(tool: string): string | undefined {
  const resolved = findSdkTool(tool);
  if (path.isAbsolute(resolved)) return resolved;
  return isOnPath(resolved) ? resolved : undefined;
}

// ─── cmdline-tools bootstrap ─────────────────────────────────────────────

const SDK_REPO_INDEX_URL = 'https://dl.google.com/android/repository/repository2-1.xml';
const SDK_TERMS_URL = 'https://developer.android.com/studio/terms';

/** Google's platform key in the cmdline-tools zip filename. */
export function cmdlineToolsPlatform(platform: NodeJS.Platform = process.platform): 'mac' | 'linux' | 'win' {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
}

/**
 * Pick the newest cmdline-tools zip for a platform from Google's repository
 * index. Filenames embed a monotonically increasing build number
 * (`commandlinetools-mac-15641748_latest.zip`).
 */
export function latestCmdlineToolsZip(repoIndexXml: string, platform: 'mac' | 'linux' | 'win'): string | undefined {
  const re = new RegExp(`commandlinetools-${platform}-(\\d+)_latest\\.zip`, 'g');
  let best: string | undefined;
  let bestBuild = -1;
  for (const match of repoIndexXml.matchAll(re)) {
    const build = Number(match[1]);
    if (build > bestBuild) {
      bestBuild = build;
      best = match[0];
    }
  }
  return best;
}

/**
 * Unpack a cmdline-tools zip into `<sdkRoot>/cmdline-tools/latest`.
 *
 * The zip's single top-level directory is `cmdline-tools/`; its contents move
 * under `latest/` (the layout sdkmanager itself requires). fflate does not
 * restore unix permission bits, so everything under `bin/` is chmodded
 * executable explicitly.
 */
export function extractCmdlineTools(zipData: Uint8Array, sdkRoot: string): string {
  const destDir = path.join(sdkRoot, 'cmdline-tools', 'latest');
  const entries = unzipSync(zipData);
  for (const [entryName, data] of Object.entries(entries)) {
    if (!entryName.startsWith('cmdline-tools/') || entryName.endsWith('/')) continue;
    const rel = entryName.slice('cmdline-tools/'.length);
    if (!rel || rel.split('/').includes('..')) continue;
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (rel.startsWith('bin/')) fs.chmodSync(target, 0o755);
  }
  return destDir;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function installCmdlineTools(sdkRoot: string): Promise<void> {
  console.log(dim('Looking up the latest version…'));
  const indexRes = await fetch(SDK_REPO_INDEX_URL);
  if (!indexRes.ok) throw new Error(`Could not reach Google's SDK repository (HTTP ${indexRes.status}). Check your network and retry.`);
  const zipName = latestCmdlineToolsZip(await indexRes.text(), cmdlineToolsPlatform());
  if (!zipName) throw new Error('Could not find a cmdline-tools package in Google\'s SDK repository index.');

  console.log(dim(`Downloading ${zipName} (~150 MB)…`));
  const zipData = await fetchBytes(`https://dl.google.com/android/repository/${zipName}`);

  const dest = extractCmdlineTools(zipData, sdkRoot);
  console.log(green(`✓ Command-line tools installed ${dim(`(${dest})`)}`));
}

/**
 * Make sure `avdmanager` (and `sdkmanager`, when a system image still needs
 * downloading) are available, offering to install the cmdline-tools into the
 * SDK root when they're not.
 */
async function ensureSdkTools(opts: CreateAvdOptions, sdkRoot: string | undefined, needSdkmanager: boolean): Promise<void> {
  const needed = needSdkmanager ? ['sdkmanager', 'avdmanager'] : ['avdmanager'];
  const missing = needed.filter((tool) => !resolveAvailableSdkTool(tool));
  if (missing.length === 0) return;

  const missingLabel = missing.join(' and ');
  if (!sdkRoot) {
    throw new Error(
      `${missingLabel} not found, and ANDROID_HOME is not set so Tapsmith cannot install the `
      + `command-line tools for you. Set ANDROID_HOME to your Android SDK, or: ${CMDLINE_TOOLS_HINT}`,
    );
  }

  console.log();
  console.log(`${bold('Setup')} ${missingLabel} not found — the Android SDK Command-line Tools are not installed.`);
  console.log(dim('(Android Studio does not install them by default.)'));
  console.log(dim(`Continuing accepts the Android SDK terms: ${SDK_TERMS_URL}`));

  let consented = opts.installTools;
  if (!consented && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const answer = await enquirer.prompt({
        type: 'confirm',
        name: 'install',
        message: `Download and install them into ${path.join(sdkRoot, 'cmdline-tools', 'latest')} now?`,
        initial: true,
      }) as { install: boolean };
      consented = answer.install;
    } catch {
      consented = false; // ctrl-c on the prompt
    }
  }

  if (!consented) {
    throw new Error(
      `Cannot continue without ${missingLabel}. Re-run with --install-tools to let Tapsmith `
      + `install the command-line tools into ${sdkRoot}, or install them yourself: ${CMDLINE_TOOLS_HINT}`,
    );
  }

  await installCmdlineTools(sdkRoot);

  const stillMissing = needed.filter((tool) => !resolveAvailableSdkTool(tool));
  if (stillMissing.length > 0) {
    throw new Error(`${stillMissing.join(' and ')} still not found after installing the command-line tools — ${CMDLINE_TOOLS_HINT}`);
  }
}

// ─── Java resolution ─────────────────────────────────────────────────────

/**
 * sdkmanager/avdmanager need a JDK, which Studio-only users often lack on
 * PATH. Fall back to Android Studio's bundled JetBrains Runtime via
 * JAVA_HOME when neither JAVA_HOME nor `java` is available.
 */
function toolEnv(): NodeJS.ProcessEnv {
  if (process.env.JAVA_HOME || isOnPath('java')) return process.env;
  const studioJbr = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  if (process.platform === 'darwin' && fs.existsSync(studioJbr)) {
    console.log(dim(`Using Android Studio's bundled JDK (${studioJbr})`));
    return { ...process.env, JAVA_HOME: studioJbr };
  }
  return process.env;
}

// ─── Subprocess helpers ──────────────────────────────────────────────────

/**
 * Run a tool with output streamed to the terminal. `stdinResponse` is written
 * to the child's stdin (avdmanager prompts "Do you wish to create a custom
 * hardware profile" even in scripted use).
 */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, stdinResponse?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdinResponse === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      env,
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

  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const imageAlreadyInstalled = !!sdkRoot && fs.existsSync(systemImageDir(sdkRoot, opts.api, opts.abi));

  await ensureSdkTools(opts, sdkRoot, !imageAlreadyInstalled);
  const env = toolEnv();

  console.log();
  if (imageAlreadyInstalled) {
    console.log(`${bold('Step 1/2')} System image already installed ${dim(`(${image})`)}`);
  } else {
    const sdkmanager = findSdkTool('sdkmanager');
    console.log(`${bold('Step 1/2')} Install system image ${dim(`(${image})`)}`);
    console.log(dim('sdkmanager may prompt you to accept the Android SDK license.'));
    await run(sdkmanager, [image], env);
  }

  console.log();
  console.log(`${bold('Step 2/2')} Create AVD ${dim(`(${opts.name}, device profile ${opts.device})`)}`);
  const avdmanager = findSdkTool('avdmanager');
  const args = ['create', 'avd', '-n', opts.name, '-k', image, '-d', opts.device];
  if (opts.force) args.push('--force');
  await run(avdmanager, args, env, 'no\n');

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
If the Android SDK command-line tools are missing, offers to install them into
ANDROID_HOME first.

${bold('Usage:')}
  tapsmith create-avd [options]

${bold('Options:')}
  --api <level>      Android API level (default: ${DEFAULT_API_LEVEL})
  --name <name>      AVD name (default: Tapsmith_Phone_API_<api>)
  --device <profile> avdmanager device profile (default: ${DEFAULT_DEVICE_PROFILE})
  --abi <abi>        System image ABI (default: ${defaultAbi()} for this machine)
  --force            Overwrite an existing AVD with the same name
  --install-tools    Install the SDK command-line tools without prompting if missing
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
