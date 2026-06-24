/**
 * Auto-detection helpers for non-interactive `tapsmith init --yes`.
 * Pure parsers are separated from exec wrappers for testability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globSync } from 'glob';
import { tryExec } from './env-scan.js';

// ─── Android ───

/** Returns project-relative APK paths (posix-style globs, deterministic order). */
export function findApkCandidates(cwd: string): string[] {
  return globSync('android/**/build/outputs/apk/**/*.apk', {
    cwd,
    nodir: true,
    ignore: ['**/node_modules/**', '**/build/outputs/apk/androidTest/**', '**/*-androidTest.apk'],
  }).filter((candidate) => {
    const parts = candidate.split(/[\\/]/);
    return !parts.includes('androidTest') && !/-androidTest\.apk$/i.test(candidate);
  }).sort();
}

/** Prefer debug builds when the glob found both debug and release artifacts. */
export function preferDebugApk(candidates: string[]): string[] {
  const debug = candidates.filter((c) => /debug/i.test(c));
  return debug.length > 0 ? debug : candidates;
}

export function parseAapt2Badging(output: string): string | undefined {
  const match = output.match(/package: name='([^']+)'/);
  return match?.[1];
}

/** Locate aapt2 (PATH, then newest build-tools under ANDROID_HOME). */
export function resolveAapt2(): string {
  if (tryExec('aapt2', ['version']) !== undefined) return 'aapt2';
  // execFile resolves .exe on PATH, but existsSync needs the explicit suffix.
  const binName = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const androidHome = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];
  if (androidHome) {
    const buildTools = path.join(androidHome, 'build-tools');
    try {
      if (fs.existsSync(buildTools) && fs.statSync(buildTools).isDirectory()) {
        const versions = fs.readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions) {
          const candidate = path.join(buildTools, v, binName);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // Fall through when the SDK directory is unreadable.
    }
  }
  return 'aapt2';
}

export function detectAndroidPackage(apkPath: string): string | undefined {
  const output = tryExec(resolveAapt2(), ['dump', 'badging', apkPath]);
  return output ? parseAapt2Badging(output) : undefined;
}

// ─── iOS ───

/** Returns project-relative simulator .app bundle paths. */
export function findIosAppCandidates(cwd: string): string[] {
  return globSync('ios/**/*-iphonesimulator/*.app', {
    cwd,
    ignore: ['**/node_modules/**'],
  }).sort();
}

export function detectIosBundleId(appPath: string): string | undefined {
  const plistPath = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(plistPath)) return undefined;
  return tryExec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath]);
}
