import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAapt2Badging, findApkCandidates, findIosAppCandidates, preferDebugApk } from '../init-detect.js';

describe('parseAapt2Badging()', () => {
  it('extracts the package name', () => {
    const out = "package: name='com.example.app' versionCode='1' versionName='1.0'";
    expect(parseAapt2Badging(out)).toBe('com.example.app');
  });

  it('returns undefined when no package line present', () => {
    expect(parseAapt2Badging('garbage output')).toBeUndefined();
  });
});

describe('findApkCandidates()', () => {
  it('finds APKs under android/ build outputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    const apkDir = path.join(tmp, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
    fs.mkdirSync(apkDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), '');
    try {
      const found = findApkCandidates(tmp);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('app-debug.apk');
      expect(path.isAbsolute(found[0])).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty array when nothing matches', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    try {
      expect(findApkCandidates(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('preferDebugApk()', () => {
  it('narrows to debug APKs when both exist', () => {
    const candidates = ['android/app/build/outputs/apk/release/app-release.apk', 'android/app/build/outputs/apk/debug/app-debug.apk'];
    expect(preferDebugApk(candidates)).toEqual(['android/app/build/outputs/apk/debug/app-debug.apk']);
  });

  it('returns all candidates when none are debug', () => {
    const candidates = ['a/app-release.apk', 'b/app-prod.apk'];
    expect(preferDebugApk(candidates)).toEqual(candidates);
  });
});

describe('findIosAppCandidates()', () => {
  it('finds simulator .app bundles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    const appDir = path.join(tmp, 'ios', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app');
    fs.mkdirSync(appDir, { recursive: true });
    try {
      const found = findIosAppCandidates(tmp);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('MyApp.app');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
