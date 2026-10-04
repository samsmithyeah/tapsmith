import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectExpoProject, expoBuildHint, parseExpoAppConfig, readExpoAppConfig, type ExpoProject } from '../init-detect.js';

// ─── Fixtures ───

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string | object>, dirs: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-expo-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  for (const d of dirs) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

const APP_JSON = { expo: { name: 'myapp', android: { package: 'com.example.myapp' }, ios: { bundleIdentifier: 'com.example.myapp.ios' } } };

const managed: ExpoProject = { hasAndroidDir: false, hasIosDir: false, usesTapsmithHooks: false };

// ─── parseExpoAppConfig ───

describe('parseExpoAppConfig() (PILOT-557)', () => {
  it('reads the ids from an app.json wrapped in `expo`', () => {
    expect(parseExpoAppConfig(APP_JSON)).toEqual({ androidPackage: 'com.example.myapp', iosBundleId: 'com.example.myapp.ios' });
  });

  it('reads `expo config` output, which is not wrapped', () => {
    expect(parseExpoAppConfig(APP_JSON.expo)).toEqual({ androidPackage: 'com.example.myapp', iosBundleId: 'com.example.myapp.ios' });
  });

  it('ignores missing, empty and non-string ids', () => {
    expect(parseExpoAppConfig({ expo: { android: { package: 42 }, ios: { bundleIdentifier: '  ' } } })).toEqual({});
    expect(parseExpoAppConfig({ expo: { android: 'nope' } })).toEqual({});
    expect(parseExpoAppConfig(undefined)).toEqual({});
    expect(parseExpoAppConfig([1, 2])).toEqual({});
  });
});

// ─── detectExpoProject ───

describe('detectExpoProject() (PILOT-557)', () => {
  it('detects a managed project: expo dependency + app.json, no native dirs', () => {
    const dir = project({ 'package.json': { dependencies: { expo: '~55.0.0' } }, 'app.json': APP_JSON });
    expect(detectExpoProject(dir, () => APP_JSON)).toEqual({
      androidPackage: 'com.example.myapp',
      iosBundleId: 'com.example.myapp.ios',
      hasAndroidDir: false,
      hasIosDir: false,
      usesTapsmithHooks: false,
    });
  });

  it('accepts expo as a devDependency and app.config.ts as the app config', () => {
    const dir = project({ 'package.json': { devDependencies: { expo: '^55.0.0' } }, 'app.config.ts': 'export default {}' });
    expect(detectExpoProject(dir, () => undefined)).toMatchObject({ hasAndroidDir: false, hasIosDir: false });
  });

  it('is not fooled by a bare React Native app, which has an app.json but no expo dependency', () => {
    const dir = project({ 'package.json': { dependencies: { 'react-native': '0.80.0' } }, 'app.json': { name: 'MyApp', displayName: 'MyApp' } });
    expect(detectExpoProject(dir, () => { throw new Error('must not read the config'); })).toBeUndefined();
  });

  it('needs an app config beside the expo dependency', () => {
    const dir = project({ 'package.json': { dependencies: { expo: '~55.0.0' } } });
    expect(detectExpoProject(dir)).toBeUndefined();
  });

  it('returns undefined with no (or an unreadable) package.json', () => {
    expect(detectExpoProject(project({ 'app.json': APP_JSON }))).toBeUndefined();
    expect(detectExpoProject(project({ 'package.json': '{ not json', 'app.json': APP_JSON }))).toBeUndefined();
  });

  it('reports prebuilt native dirs and the warm-reset hooks dependency', () => {
    const dir = project(
      { 'package.json': { dependencies: { expo: '~55.0.0', '@tapsmith/react-native': '^0.5.0' } }, 'app.json': APP_JSON },
      ['android', 'ios'],
    );
    expect(detectExpoProject(dir, () => APP_JSON)).toMatchObject({ hasAndroidDir: true, hasIosDir: true, usesTapsmithHooks: true });
  });
});

// ─── readExpoAppConfig ───

describe('readExpoAppConfig() (PILOT-557)', () => {
  /** A stand-in for the project's Expo CLI: prints `printed` for `expo config`. */
  function fakeExpoCli(dir: string, script: string): void {
    fs.mkdirSync(path.join(dir, 'node_modules', 'expo', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'expo', 'package.json'), JSON.stringify({ name: 'expo', version: '55.0.0' }));
    fs.writeFileSync(path.join(dir, 'node_modules', 'expo', 'bin', 'cli'), script);
  }

  it('evaluates a dynamic app config with the project\'s own `expo config`', () => {
    const dir = project({ 'package.json': { dependencies: { expo: '~55.0.0' } }, 'app.config.ts': 'export default {}' });
    fakeExpoCli(dir, `
      const args = process.argv.slice(2).join(' ');
      if (args !== 'config --json --type public') process.exit(9);
      if (process.env.EXPO_NO_TELEMETRY !== '1') process.exit(8);
      process.stdout.write(JSON.stringify({ name: 'dyn', android: { package: 'com.dynamic.app' } }));
    `);
    expect(parseExpoAppConfig(readExpoAppConfig(dir))).toEqual({ androidPackage: 'com.dynamic.app' });
  });

  it('falls back to app.json when the Expo CLI fails', () => {
    const dir = project({ 'package.json': { dependencies: { expo: '~55.0.0' } }, 'app.json': APP_JSON });
    fakeExpoCli(dir, 'process.exit(1)');
    expect(readExpoAppConfig(dir)).toEqual(APP_JSON);
  });

  it('falls back to app.json when the Expo CLI prints something other than JSON', () => {
    const dir = project({ 'package.json': { dependencies: { expo: '~55.0.0' } }, 'app.json': APP_JSON });
    fakeExpoCli(dir, 'console.log("Starting project…")');
    expect(readExpoAppConfig(dir)).toEqual(APP_JSON);
  });

  it('reads app.json when expo is not installed', () => {
    const dir = project({ 'package.json': { dependencies: { expo: '~55.0.0' } }, 'app.json': APP_JSON });
    expect(readExpoAppConfig(dir)).toEqual(APP_JSON);
  });

  it('returns undefined when there is neither a CLI nor an app.json', () => {
    expect(readExpoAppConfig(project({ 'app.config.ts': 'export default {}' }))).toBeUndefined();
  });
});

// ─── expoBuildHint ───

describe('expoBuildHint() (PILOT-557)', () => {
  it('Android, managed: expo run:android generates android/ and says where the APK lands', () => {
    const hint = expoBuildHint('android', managed);
    expect(hint).toContain('`npx expo run:android --variant release`');
    expect(hint).toContain('does not have yet');
    expect(hint).toContain('android/app/build/outputs/apk/release/app-release.apk');
    expect(hint).not.toContain('gradlew');
    expect(hint).toContain('https://tapsmith.dev/getting-started/#react-native-and-expo');
  });

  it('Android, prebuilt: no "does not have android/ yet"', () => {
    expect(expoBuildHint('android', { ...managed, hasAndroidDir: true })).not.toContain('does not have yet');
  });

  it('iOS, managed: prebuild, then an xcodebuild into ios/build where init looks', () => {
    const hint = expoBuildHint('ios', managed);
    expect(hint).toContain('`npx expo prebuild --platform ios`');
    expect(hint).toContain('-derivedDataPath build');
    expect(hint).toContain('-configuration Release -sdk iphonesimulator');
    expect(hint).toContain('DerivedData');
  });

  it('iOS, prebuilt: no prebuild step', () => {
    expect(expoBuildHint('ios', { ...managed, hasIosDir: true })).not.toContain('prebuild');
  });

  it('with the hooks dependency, sets EXPO_PUBLIC_TAPSMITH_HOOKS=1 on the build and warns never to ship it', () => {
    const hooks = { ...managed, usesTapsmithHooks: true };
    expect(expoBuildHint('android', hooks)).toContain('`EXPO_PUBLIC_TAPSMITH_HOOKS=1 npx expo run:android --variant release`');
    expect(expoBuildHint('ios', hooks)).toContain('cd ios && EXPO_PUBLIC_TAPSMITH_HOOKS=1 xcodebuild');
    expect(expoBuildHint('android', hooks)).toMatch(/test builds only, never for store builds/);
  });

  it('without the hooks dependency, mentions the flag as the way to warm resets, not in the command', () => {
    const hint = expoBuildHint('android', managed);
    expect(hint).not.toContain('`EXPO_PUBLIC_TAPSMITH_HOOKS=1 npx');
    expect(hint).toContain('@tapsmith/react-native');
    expect(hint).toContain('EXPO_PUBLIC_TAPSMITH_HOOKS=1');
    expect(hint).toContain('https://tapsmith.dev/guides/warm-reset/');
  });
});
