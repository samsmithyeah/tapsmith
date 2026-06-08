/**
 * Auto-build logic for the iOS simulator agent.
 *
 * When the prebuilt xctestrun's SDK version doesn't match the user's
 * installed Xcode SDK, we rebuild the agent from source and cache the
 * result in `~/.tapsmith/ios-simulator-agent/`. Subsequent runs skip
 * the build as long as the cached SDK version still matches.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveIosAgentDir } from './build-ios-agent.js';
import { extractSdkVersion, findSimulatorXctestrun, getInstalledSimulatorSdkVersion } from './ios-device-resolve.js';

// ─── Build ──────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(os.homedir(), '.tapsmith', 'ios-simulator-agent');

/**
 * Build the iOS simulator agent via `xcodebuild build-for-testing` and
 * cache the products under `~/.tapsmith/ios-simulator-agent/`.
 *
 * Returns the absolute path to the cached `.xctestrun` file.
 */
export async function buildSimulatorAgent(sdkVersion: string): Promise<string> {
  const agentDir = resolveIosAgentDir();
  const xcodeproj = path.join(agentDir, 'TapsmithAgent.xcodeproj');

  if (!fs.existsSync(xcodeproj)) {
    throw new Error(
      `TapsmithAgent.xcodeproj not found at ${xcodeproj}.\n` +
        '  Ensure the ios-agent source is available (monorepo checkout or npm package with bundled source).',
    );
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const buildDir = path.join(CACHE_DIR, 'build');

  const args = [
    'build-for-testing',
    '-project', xcodeproj,
    '-scheme', 'TapsmithAgentUITests',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', buildDir,
    'ARCHS=' + (process.arch === 'arm64' ? 'arm64' : 'x86_64'),
    'ONLY_ACTIVE_ARCH=NO',
    'CODE_SIGNING_ALLOWED=NO',
  ];

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'xcodebuild',
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const tail = (stdout || '').slice(-2000);
          reject(new Error(`xcodebuild failed:\n${tail}`));
        } else {
          resolve();
        }
      },
    );
    child.stderr?.pipe(process.stderr);
  });

  // Copy products to the cache directory.
  const productsDir = path.join(buildDir, 'Build', 'Products');

  // Copy the Debug-iphonesimulator/ directory.
  const simDir = path.join(productsDir, 'Debug-iphonesimulator');
  const cachedSimDir = path.join(CACHE_DIR, 'Debug-iphonesimulator');
  if (fs.existsSync(cachedSimDir)) {
    fs.rmSync(cachedSimDir, { recursive: true, force: true });
  }
  fs.cpSync(simDir, cachedSimDir, { recursive: true });

  // Clean up old xctestrun files before copying new ones.
  for (const old of fs.readdirSync(CACHE_DIR)) {
    if (old.endsWith('.xctestrun')) fs.rmSync(path.join(CACHE_DIR, old), { force: true });
  }

  // Copy the xctestrun file(s).
  const entries = fs.readdirSync(productsDir);
  let xctestrunDest: string | undefined;
  for (const entry of entries) {
    if (entry.endsWith('.xctestrun') && !entry.endsWith('.patched.xctestrun')) {
      const src = path.join(productsDir, entry);
      const dest = path.join(CACHE_DIR, entry);
      fs.copyFileSync(src, dest);
      // Pick the first (typically only) xctestrun as the return value.
      if (!xctestrunDest) xctestrunDest = dest;
    }
  }

  if (!xctestrunDest) {
    throw new Error(
      'xcodebuild succeeded but no .xctestrun file was found in Build/Products. ' +
        'This is unexpected — please file a bug.',
    );
  }

  // Write the SDK version marker so future runs can skip the build.
  fs.writeFileSync(path.join(CACHE_DIR, '.sdk-version'), sdkVersion);

  // Clean up the temporary build directory to save disk space.
  try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* non-fatal */ }

  return xctestrunDest;
}

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Ensure a simulator-compatible xctestrun is available, rebuilding the
 * agent from source when the SDK version doesn't match.
 *
 * This is the main entry point for the session-preflight / daemon startup
 * path. It never throws for "soft" problems (missing xcrun, unknown SDK)
 * — those fall back to the existing xctestrun as-is.
 */
export async function ensureSimulatorAgent(): Promise<string> {
  const found = findSimulatorXctestrun();
  const installedSdk = getInstalledSimulatorSdkVersion();

  if (!found) {
    if (installedSdk) {
      try {
        console.log(`No prebuilt iOS agent found. Building from source for SDK ${installedSdk}...`);
        return await buildSimulatorAgent(installedSdk);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to build iOS simulator agent from source: ${detail}`);
      }
    }
    throw new Error(
      'No iOS simulator agent xctestrun found. Install the @tapsmith/agent-ios-simulator package, ' +
        'or build from source: cd ios-agent && xcodebuild build-for-testing ' +
        '-destination \'platform=iOS Simulator,name=iPhone 16\'',
    );
  }

  if (!installedSdk) {
    // Can't detect SDK — return whatever we found.
    return found;
  }

  const foundSdk = extractSdkVersion(found);
  if (!foundSdk || foundSdk === installedSdk) {
    // Either we can't parse the SDK from the filename, or it already matches.
    return found;
  }

  // Check if we've already built for this SDK version.
  const sdkVersionFile = path.join(CACHE_DIR, '.sdk-version');
  try {
    const cachedSdk = fs.readFileSync(sdkVersionFile, 'utf8').trim();
    if (cachedSdk === installedSdk) {
      // Cache should hit — re-resolve.
      const cached = findSimulatorXctestrun();
      if (cached && extractSdkVersion(cached) === installedSdk) return cached;
    }
  } catch {
    // No cached version — fall through to build.
  }

  // SDK mismatch — rebuild.
  console.log(`Building iOS agent for SDK ${installedSdk}... (cached for future runs)`);
  return buildSimulatorAgent(installedSdk);
}
