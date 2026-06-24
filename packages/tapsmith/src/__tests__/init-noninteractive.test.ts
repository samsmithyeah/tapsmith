import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseInitArgs, resolveInitPlan, executeInitPlan, assertConfigWritable, InitError } from '../init-noninteractive.js';
import type { EnvScan } from '../env-scan.js';

const baseEnv: EnvScan = {
  nodeVersion: '22.0.0',
  daemonBin: '/bin/tapsmith-core',
  agentApk: true,
  agentTestApk: true,
  adbVersion: '35.0.1',
  androidHome: '/sdk',
  xcodeVersion: '16.0',
  simulators: [
    { name: 'iPhone 16', udid: 'A', state: 'Shutdown', runtime: 'iOS 18 0' },
    { name: 'iPhone 16', udid: 'B', state: 'Shutdown', runtime: 'iOS 18 2' },
  ],
  avds: ['Pixel_7', 'Pixel_8'],
  isMacOS: true,
};

const detectStubs = {
  findApkCandidates: () => ['android/app/build/outputs/apk/debug/app-debug.apk'],
  detectAndroidPackage: () => 'com.example.app',
  findIosAppCandidates: () => ['ios/build/Build/Products/Debug-iphonesimulator/MyApp.app'],
  detectIosBundleId: () => 'com.example.myapp',
};

/** vitest's toThrow() doesn't support objectContaining — capture and assert. */
function expectInitError(fn: () => unknown, code: string): InitError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InitError);
  expect((caught as InitError).code).toBe(code);
  return caught as InitError;
}

describe('parseInitArgs()', () => {
  it('parses all flags', () => {
    const args = parseInitArgs([
      '--yes', '--json', '--force', '--platform', 'android,ios',
      '--apk', './a.apk', '--package', 'com.x', '--app', './X.app',
      '--bundle-id', 'com.x.ios', '--avd', 'Pixel_7', '--simulator', 'iPhone 16',
      '--device-type', 'both', '--network-capture', '--no-example-test', '--no-agents-md',
    ]);
    expect(args).toMatchObject({
      yes: true, json: true, force: true,
      platforms: ['android', 'ios'],
      apk: './a.apk', packageName: 'com.x', app: './X.app',
      bundleId: 'com.x.ios', avd: 'Pixel_7', simulator: 'iPhone 16',
      deviceType: 'both', networkCapture: true, exampleTest: false, agentsMd: false,
    });
  });

  it('supports --flag=value form', () => {
    expect(parseInitArgs(['--platform=android']).platforms).toEqual(['android']);
  });

  it('throws InitError on unknown flag', () => {
    expect(() => parseInitArgs(['--bogus'])).toThrow(InitError);
  });

  it('throws InitError on invalid platform or device-type', () => {
    expect(() => parseInitArgs(['--platform', 'windows'])).toThrow(InitError);
    expect(() => parseInitArgs(['--device-type', 'cloud'])).toThrow(InitError);
  });

  it('detects whether any setup flag was given', () => {
    expect(parseInitArgs([]).anySetupFlag).toBe(false);
    expect(parseInitArgs(['--json']).anySetupFlag).toBe(false);
    expect(parseInitArgs(['--apk', './a.apk']).anySetupFlag).toBe(true);
  });
});

describe('resolveInitPlan()', () => {
  it('auto-detects an Android setup with --yes', () => {
    const plan = resolveInitPlan(parseInitArgs(['--yes', '--platform', 'android']), baseEnv, detectStubs);
    expect(plan.android).toMatchObject({
      apkPath: 'android/app/build/outputs/apk/debug/app-debug.apk',
      packageName: 'com.example.app',
      avd: 'Pixel_7',
      useEmulators: true,
      usePhysicalDevices: false,
    });
    expect(plan.ios).toBeUndefined();
  });

  it('resolves APK paths against cwd before package detection', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    let probedApk: string | undefined;
    const detect = {
      ...detectStubs,
      findApkCandidates: () => ['android/app-debug.apk'],
      detectAndroidPackage: (apkPath: string) => {
        probedApk = apkPath;
        return 'com.example.app';
      },
    };
    try {
      resolveInitPlan(parseInitArgs(['--yes', '--platform', 'android']), baseEnv, detect, tmp);
      expect(probedApk).toBe(path.resolve(tmp, 'android/app-debug.apk'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('picks the newest-runtime simulator for iOS', () => {
    const plan = resolveInitPlan(parseInitArgs(['--yes', '--platform', 'ios']), baseEnv, detectStubs);
    expect(plan.ios).toMatchObject({
      appPath: 'ios/build/Build/Products/Debug-iphonesimulator/MyApp.app',
      bundleId: 'com.example.myapp',
      simulator: 'iPhone 16',
      usePhysicalDevice: false,
    });
  });

  it('resolves iOS app paths against cwd before bundle id detection', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    let probedApp: string | undefined;
    const detect = {
      ...detectStubs,
      findIosAppCandidates: () => ['ios/MyApp.app'],
      detectIosBundleId: (appPath: string) => {
        probedApp = appPath;
        return 'com.example.myapp';
      },
    };
    try {
      resolveInitPlan(parseInitArgs(['--yes', '--platform', 'ios']), baseEnv, detect, tmp);
      expect(probedApp).toBe(path.resolve(tmp, 'ios/MyApp.app'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('explicit flags beat detection', () => {
    const plan = resolveInitPlan(
      parseInitArgs(['--yes', '--platform', 'android', '--apk', './custom.apk', '--package', 'com.custom', '--avd', 'Pixel_8']),
      baseEnv,
      detectStubs,
    );
    expect(plan.android).toMatchObject({ apkPath: './custom.apk', packageName: 'com.custom', avd: 'Pixel_8' });
  });

  it('errors with candidates when multiple APKs and no --apk', () => {
    const detect = {
      ...detectStubs,
      findApkCandidates: () => ['android/a/app-debug.apk', 'android/b/app-debug.apk'],
    };
    const err = expectInitError(
      () => resolveInitPlan(parseInitArgs(['--yes', '--platform', 'android']), baseEnv, detect),
      'AMBIGUOUS_APK',
    );
    expect(err.candidates).toHaveLength(2);
    expect(err.fix).toContain('--apk');
  });

  it('errors NO_APK when nothing found', () => {
    const detect = { ...detectStubs, findApkCandidates: () => [] };
    expectInitError(
      () => resolveInitPlan(parseInitArgs(['--yes', '--platform', 'android']), baseEnv, detect),
      'NO_APK',
    );
  });

  it('infers platform from project layout when --platform omitted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    fs.mkdirSync(path.join(tmp, 'android'));
    try {
      const plan = resolveInitPlan(parseInitArgs(['--yes']), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['android']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('errors NO_PLATFORM when nothing inferable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    try {
      expectInitError(() => resolveInitPlan(parseInitArgs(['--yes']), baseEnv, detectStubs, tmp), 'NO_PLATFORM');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects iOS physical-only as interactive-only', () => {
    expectInitError(() => resolveInitPlan(
      parseInitArgs(['--yes', '--platform', 'ios', '--device-type', 'physical']),
      baseEnv,
      detectStubs,
    ), 'IOS_PHYSICAL_INTERACTIVE_ONLY');
  });

  it('rejects iOS setup on non-macOS hosts before probing iOS artifacts', () => {
    const detect = {
      ...detectStubs,
      findIosAppCandidates: () => {
        throw new Error('should not probe iOS artifacts');
      },
    };
    const err = expectInitError(() => resolveInitPlan(
      parseInitArgs(['--yes', '--platform', 'ios']),
      { ...baseEnv, isMacOS: false },
      detect,
    ), 'IOS_REQUIRES_MACOS');
    expect(err.fix).toContain('macOS');
  });

  it('downgrades iOS both to simulators with a warning', () => {
    const plan = resolveInitPlan(
      parseInitArgs(['--yes', '--platform', 'ios', '--device-type', 'both']),
      baseEnv,
      detectStubs,
    );
    expect(plan.ios?.usePhysicalDevice).toBe(false);
    expect(plan.warnings.some((w) => w.includes('physical'))).toBe(true);
  });

  it('omits avd with a warning when none available', () => {
    const plan = resolveInitPlan(
      parseInitArgs(['--yes', '--platform', 'android']),
      { ...baseEnv, avds: [] },
      detectStubs,
    );
    expect(plan.android?.avd).toBeUndefined();
    expect(plan.warnings.some((w) => w.includes('AVD'))).toBe(true);
  });
});

describe('executeInitPlan()', () => {
  function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-exec-'));
  }

  it('writes config, example test, and AGENTS.md', () => {
    const tmp = makeTmp();
    try {
      const args = parseInitArgs(['--yes', '--platform', 'android']);
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toContain("package: 'com.example.app',");
      expect(fs.existsSync(path.join(tmp, 'tests', 'example.test.ts'))).toBe(true);
      expect(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8')).toContain('tapsmith:begin');
      expect(result.filesCreated).toEqual(expect.arrayContaining(['tapsmith.config.ts', 'tests/example.test.ts', 'AGENTS.md']));
      expect(result.configPath).toBe(path.join(tmp, 'tapsmith.config.ts'));
      expect(result.nextSteps.some((s) => s.includes('tapsmith verify'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects --no-example-test and --no-agents-md', () => {
    const tmp = makeTmp();
    try {
      const args = parseInitArgs(['--yes', '--platform', 'android', '--no-example-test', '--no-agents-md']);
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      executeInitPlan(plan, args, tmp);
      expect(fs.existsSync(path.join(tmp, 'tests'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing config without --force', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing');
      const args = parseInitArgs(['--yes', '--platform', 'android']);
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      expectInitError(() => executeInitPlan(plan, args, tmp), 'CONFIG_EXISTS');
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toBe('// existing');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('overwrites with --force', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing');
      const args = parseInitArgs(['--yes', '--force', '--platform', 'android']);
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toContain('defineConfig');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes alternate config extensions when force is enabled', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.mjs'), '// existing mjs');
      assertConfigWritable(true, tmp);
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.mjs'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.ts'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips existing example test without error', () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'tests'));
      fs.writeFileSync(path.join(tmp, 'tests', 'example.test.ts'), '// mine');
      const args = parseInitArgs(['--yes', '--platform', 'android']);
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tests', 'example.test.ts'), 'utf8')).toBe('// mine');
      expect(result.filesCreated).not.toContain('tests/example.test.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
