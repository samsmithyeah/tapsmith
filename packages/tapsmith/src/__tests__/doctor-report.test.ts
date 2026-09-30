/**
 * doctor's full report against a faked machine (PILOT-263): which sections
 * run for which config, what a missing toolchain costs, and the fixes it
 * prints. Every external command goes through a mocked `execFileSync`, HOME
 * is a temp dir, and `process.platform` is set per test, so nothing here
 * depends on the host running the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exec = vi.hoisted(() => ({
  table: new Map<string, string>(),
  calls: [] as string[],
  timeouts: new Map<string, number | undefined>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: readonly string[] = [], opts?: { timeout?: number }) => {
      const key = [cmd, ...args].join(' ');
      exec.calls.push(key);
      exec.timeouts.set(key, opts?.timeout);
      const out = exec.table.get(key);
      if (out === undefined) {
        const err = new Error(`spawn ${cmd} ENOENT`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return out;
    }),
  };
});

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/opt/tapsmith-core' }));
vi.mock('../agent-resolve.js', () => ({
  findAgentApk: () => '/n/@tapsmith/agent-android/app.apk',
  findAgentTestApk: () => '/n/@tapsmith/agent-android/test.apk',
}));
const xctestrun = vi.hoisted(() => ({ found: undefined as string | undefined }));
vi.mock('../ios-device-resolve.js', () => ({
  findSimulatorXctestrun: () => xctestrun.found,
  extractSdkVersion: () => '26.0',
  getInstalledSimulatorSdkVersion: () => '26.0',
}));

import { stripAnsi } from '../cli-json.js';
import { findMitmRedirector, runDoctor, type DoctorJson } from '../doctor.js';

// ─── Fake machine ───

const ADB_VERSION = 'Android Debug Bridge version 1.0.41\nVersion 37.0.0-1\n';
const XCODE_VERSION = 'Xcode 26.0\nBuild version 17A324\n';
const SIMCTL_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown' }] },
});

function withAdb(devices = 'List of devices attached\nemulator-5554\tdevice\n'): void {
  exec.table.set('adb --version', ADB_VERSION);
  exec.table.set('adb devices', devices);
}

function withXcode(): void {
  exec.table.set('xcodebuild -version', XCODE_VERSION);
  exec.table.set('xcrun simctl list devices available -j', SIMCTL_JSON);
}

let dir: string;
let home: string;
const savedCwd = process.cwd();
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const savedEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...savedPlatform, value: platform });
}

function writeConfig(body: string, name = 'tapsmith.config.mjs', where = dir): string {
  fs.mkdirSync(where, { recursive: true });
  const file = path.join(where, name);
  fs.writeFileSync(file, body);
  return file;
}

async function doctorJson(opts: { config?: string } = {}): Promise<{ code: number; json: DoctorJson }> {
  let out = '';
  const code = await runDoctor({ json: true, ...opts }, { stdout: (t) => { out += t; } });
  return { code, json: JSON.parse(out) as DoctorJson };
}

async function doctorText(opts: { config?: string } = {}): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    const code = await runDoctor({ json: false, ...opts });
    return { code, text: stripAnsi(lines.join('\n')) };
  } finally {
    spy.mockRestore();
  }
}

const ids = (json: DoctorJson): string[] => json.checks.map((c) => c.id);
const check = (json: DoctorJson, id: string) => json.checks.find((c) => c.id === id);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-doctor-report-')));
  home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  process.chdir(project);
  dir = project;
  process.env.HOME = home;
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  delete process.env.ANDROID_AVD_HOME;
  delete process.env.TAPSMITH_REDIRECTOR_APP;
  exec.table.clear();
  exec.calls.length = 0;
  exec.timeouts.clear();
  xctestrun.found = '/h/.tapsmith/ios-simulator-agent/x_iphonesimulator26.0.xctestrun';
  setPlatform('darwin');
});

afterEach(() => {
  process.chdir(savedCwd);
  Object.defineProperty(process, 'platform', savedPlatform);
  process.env = { ...savedEnv };
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

// ─── Item 6: platform gating ───

describe('doctor platform gating (PILOT-263 item 6)', () => {
  it('an Android-only config on a Mac without Xcode passes and says why iOS was skipped', async () => {
    withAdb();
    writeConfig("export default { apk: 'app.apk' }\n");
    fs.writeFileSync(path.join(dir, 'app.apk'), '');
    const { code, json } = await doctorJson();
    expect(ids(json)).not.toContain('xcode');
    expect(ids(json)).not.toContain('simctl');
    expect(ids(json)).not.toContain('ios-sim-agent');
    expect(ids(json)).not.toContain('mitmproxy');
    expect(ids(json)).not.toContain('network-extension');
    expect(json.ok).toBe(true);
    expect(code).toBe(0);
    expect(exec.calls).not.toContain('xcodebuild -version');

    const { text } = await doctorText();
    expect(text).toMatch(/iOS\n\s+– skipped: the config targets Android only/);
  });

  it('an iOS-only config without adb skips Android, and says so', async () => {
    withXcode();
    writeConfig("export default { platform: 'ios', app: 'x.app' }\n");
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('adb');
    expect(ids(json)).not.toContain('android-agent');
    expect(ids(json)).toContain('xcode');
    const { text } = await doctorText();
    expect(text).toMatch(/Android\n\s+– skipped: the config targets iOS only/);
  });

  it('a config that targets Android fails when adb is missing', async () => {
    writeConfig('export default {}\n');
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  it('a config that targets iOS fails when Xcode is missing, and does not re-run the Xcode tools', async () => {
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail', fix: expect.stringContaining('Xcode') });
    expect(ids(json)).not.toContain('simctl');
    expect(code).toBe(1);
  });

  it('a config that targets only iOS fails on Linux: iOS needs macOS', async () => {
    setPlatform('linux');
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail', label: expect.stringContaining('macOS') });
    expect(code).toBe(1);
  });

  it('a mixed Android + iOS config on Linux warns about the iOS projects but passes (Android CI)', async () => {
    setPlatform('linux');
    withAdb();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'warn', label: expect.stringContaining('macOS'), fix: expect.stringContaining('--project') });
    expect(check(json, 'adb')).toMatchObject({ status: 'pass' });
    expect(code).toBe(0);
  });

  it('a mixed config on a Mac without Xcode warns that iOS was skipped, and still checks Android', async () => {
    withAdb();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'warn', label: expect.stringContaining('iOS checks skipped') });
    expect(ids(json)).toContain('android-devices');
    expect(code).toBe(0);
  });

  it('a mixed config without adb warns that Android was skipped', async () => {
    withXcode();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({ status: 'warn', label: expect.stringContaining('Android checks skipped') });
    expect(code).toBe(0);
  });

  it('with no config, a failing simctl beside a working Xcode is a warning, not exit 1', async () => {
    withAdb();
    exec.table.set('xcodebuild -version', XCODE_VERSION);
    const { code, json } = await doctorJson();
    expect(check(json, 'simctl')).toMatchObject({ status: 'warn', fix: expect.stringContaining('xcrun simctl list devices') });
    expect(code).toBe(0);
  });

  it('a config that targets iOS fails on a failing simctl', async () => {
    exec.table.set('xcodebuild -version', XCODE_VERSION);
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'simctl')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  it('iOS-only fields without platform fail, as tapsmith test does', async () => {
    withXcode();
    writeConfig("export default { app: 'x.app', simulator: 'iPhone 16' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'config-platform')).toMatchObject({
      status: 'fail',
      label: expect.stringContaining('app, simulator'),
      fix: "Add platform: 'ios' to the config",
    });
    expect(code).toBe(1);
  });

  it('names the project that sets iOS-only fields without platform', async () => {
    withAdb();
    withXcode();
    writeConfig("export default { projects: [{ name: 'droid' }, { name: 'phone', use: { app: 'x.app' } }, { name: 'ok', use: { platform: 'ios', app: 'y.app' } }] }\n");
    const { json } = await doctorJson();
    const rows = json.checks.filter((c) => c.id === 'config-platform');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: expect.stringContaining('Project phone'), fix: expect.stringContaining('phone') });
  });

  it('with no config, a missing adb is a warning that Android was skipped, not a silent skip', async () => {
    withXcode();
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({
      status: 'warn',
      label: expect.stringContaining('Android checks skipped'),
      fix: expect.stringContaining('platform-tools'),
    });
    expect(ids(json)).not.toContain('android-agent');
    expect(code).toBe(0);
  });

  it('with no config, a missing Xcode is a warning, never exit 1', async () => {
    withAdb();
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({
      status: 'warn',
      label: expect.stringContaining('iOS checks skipped'),
      fix: expect.stringContaining('Xcode'),
    });
    expect(ids(json)).not.toContain('simctl');
    expect(ids(json)).not.toContain('mitmproxy');
    expect(json.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(code).toBe(0);
  });

  it('with no config on Linux, iOS is skipped with a note', async () => {
    setPlatform('linux');
    withAdb();
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('xcode');
    const { text } = await doctorText();
    expect(text).toMatch(/iOS\n\s+– skipped: iOS testing needs macOS/);
  });

  it('a config that cannot be loaded is judged like no config: by the tools found', async () => {
    withAdb();
    withXcode();
    writeConfig('export default {\n');
    const { json } = await doctorJson();
    expect(check(json, 'config-load')).toMatchObject({ status: 'fail' });
    expect(ids(json)).toContain('adb');
    expect(ids(json)).toContain('xcode');
  });
});

// ─── Item 1: config discovery ───

describe('doctor config check (PILOT-263 item 1)', () => {
  it('recognises tapsmith.config.js', async () => {
    withAdb();
    writeConfig('export default {}\n', 'tapsmith.config.js');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    const { json } = await doctorJson();
    expect(check(json, 'config')).toEqual({ id: 'config', status: 'pass', label: 'Config file found', detail: 'tapsmith.config.js' });
  });

  it('follows -c from another directory', async () => {
    withAdb();
    const file = writeConfig('export default {}\n', 'ci.config.mjs', path.join(dir, 'configs'));
    const { json } = await doctorJson({ config: path.relative(dir, file) });
    expect(check(json, 'config')).toMatchObject({ status: 'pass', detail: path.join('configs', 'ci.config.mjs') });
  });

  it('a -c path that does not exist is reported once, by config-load', async () => {
    withAdb();
    const { json } = await doctorJson({ config: 'missing.config.ts' });
    expect(check(json, 'config-load')).toMatchObject({ status: 'fail' });
    expect(ids(json)).not.toContain('config');
  });

  it('a config that exists but fails to load is still found', async () => {
    withAdb();
    writeConfig('export default {\n');
    const { json } = await doctorJson();
    expect(check(json, 'config')).toMatchObject({ status: 'pass', detail: 'tapsmith.config.mjs' });
  });
});

// ─── Item 4: device states ───

describe('doctor Android devices (PILOT-263 item 4)', () => {
  beforeEach(() => { writeConfig('export default {}\n'); });

  it('an attached but unauthorized device is named, with the fix, not "no devices"', async () => {
    withAdb('List of devices attached\nR58N123\tunauthorized\n');
    const { json } = await doctorJson();
    const c = check(json, 'android-devices');
    expect(c).toMatchObject({ status: 'warn', detail: 'R58N123 (unauthorized)' });
    expect(c?.label).not.toMatch(/No Android devices connected/);
    expect(c?.fix).toMatch(/USB debugging prompt/);
    expect(json.inventory.connectedDevices).toEqual([{ serial: 'R58N123', state: 'unauthorized' }]);
  });

  it('an offline phone gets the reconnect fix', async () => {
    withAdb('List of devices attached\nR58N123\toffline\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({ status: 'warn', fix: expect.stringContaining('adb kill-server') });
  });

  it('a usable device with an unusable one beside it warns, with the unusable one\'s fix', async () => {
    withAdb('List of devices attached\nemulator-5554\tdevice\nR58N123\tunauthorized\n');
    const { code, json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({
      status: 'warn',
      label: '1 device connected, 1 not usable',
      detail: 'emulator-5554; not usable: R58N123 (unauthorized)',
      fix: expect.stringContaining('USB debugging prompt'),
    });
    expect(code).toBe(0);
  });

  it('only usable devices pass', async () => {
    withAdb('List of devices attached\nemulator-5554\tdevice\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toEqual({ id: 'android-devices', status: 'pass', label: '1 device connected', detail: 'emulator-5554' });
  });

  it('an offline emulator is told to wait for boot, and "no permissions" gets the udev fix', async () => {
    withAdb('List of devices attached\nemulator-5556\toffline\n0123ABC\tno permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html]\n');
    const { json } = await doctorJson();
    const fix = check(json, 'android-devices')?.fix ?? '';
    expect(fix).toMatch(/emulator-5556 is still booting/);
    expect(fix).not.toMatch(/Reconnect cable/);
    expect(fix).toMatch(/udev rule/);
  });

  it('nothing attached is still "No Android devices connected"', async () => {
    withAdb('List of devices attached\n\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({ status: 'warn', label: 'No Android devices connected' });
  });

  it('the inventory reuses the adb and simctl output the checks read', async () => {
    withAdb();
    withXcode();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { json } = await doctorJson();
    expect(json.inventory.connectedDevices).toEqual([{ serial: 'emulator-5554', state: 'device' }]);
    expect(json.inventory.simulators).toEqual([{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26 0' }]);
    expect(exec.calls.filter((c) => c === 'adb devices')).toHaveLength(1);
    expect(exec.calls.filter((c) => c === 'adb --version')).toHaveLength(1);
    expect(exec.calls.filter((c) => c === 'xcrun simctl list devices available -j')).toHaveLength(1);
    expect(exec.calls.filter((c) => c === 'xcodebuild -version')).toHaveLength(1);
  });

  it('lists a skipped platform\'s devices in the inventory too, with a bounded command', async () => {
    withAdb();
    withXcode();
    writeConfig('export default {}\n');
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('simctl');
    expect(json.inventory.simulators).toEqual([{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26 0' }]);
    // A wedged CoreSimulator or adb server must not hang doctor.
    for (const key of ['xcrun simctl list devices available -j', 'adb devices', 'adb --version']) {
      expect(exec.timeouts.get(key), key).toBeGreaterThan(0);
    }
  });
});

// ─── Items 2, 3, minor: fixes that work ───

describe('doctor fixes (PILOT-263 items 2, 3)', () => {
  it('a missing MITM CA is not a warning and never points at an iOS command', async () => {
    withAdb();
    writeConfig('export default {}\n');
    const { json } = await doctorJson();
    const c = check(json, 'mitm-ca');
    expect(c?.status).toBe('pass');
    expect(JSON.stringify(c)).not.toMatch(/ios|setup/i);
  });

  it('a missing simulator agent is fixed without init, and names this machine\'s package', async () => {
    withXcode();
    xctestrun.found = undefined;
    writeConfig("export default { platform: 'ios' }\n");
    const { json } = await doctorJson();
    const c = check(json, 'ios-sim-agent');
    expect(c?.status).toBe('warn');
    expect(c?.fix).not.toMatch(/init/);
    expect(c?.fix).toContain(`@tapsmith/agent-ios-simulator-${process.arch}`);
    expect(c?.fix).toMatch(/first iOS simulator test run/);
  });

  it('finds the mitmproxy redirector the way the daemon does, without Homebrew', async () => {
    withXcode();
    writeConfig("export default { platform: 'ios' }\n");
    const app = path.join(home, 'Redirector');
    fs.writeFileSync(app, '');
    process.env.TAPSMITH_REDIRECTOR_APP = app;
    const { json } = await doctorJson();
    expect(check(json, 'mitmproxy')).toMatchObject({ status: 'pass', detail: 'TAPSMITH_REDIRECTOR_APP' });
  });
});

describe('findMitmRedirector()', () => {
  const bin = path.join('Mitmproxy Redirector.app', 'Contents', 'MacOS', 'Mitmproxy Redirector');
  const tar = path.join('mitmproxy.app', 'Contents', 'Resources', 'mitmproxy_macos', 'Mitmproxy Redirector.app.tar');
  const caskTar = path.join('/opt/homebrew/Caskroom/mitmproxy', '11.0.2', tar);
  const find = (present: string[], env: NodeJS.ProcessEnv = {}, caskVersions: string[] = []) =>
    findMitmRedirector(env, '/h', (p) => present.includes(p), (dir) => (dir === '/opt/homebrew/Caskroom/mitmproxy' ? caskVersions : []));

  it('checks the daemon\'s locations in the daemon\'s order', () => {
    expect(find(['/x', caskTar], { TAPSMITH_REDIRECTOR_APP: '/x' }, ['11.0.2'])).toBe('TAPSMITH_REDIRECTOR_APP');
    expect(find([path.join('/Applications', bin), caskTar], { TAPSMITH_REDIRECTOR_APP: '/gone' }, ['11.0.2'])).toBe('/Applications');
    expect(find([path.join('/h', '.tapsmith', 'redirector', bin), caskTar], {}, ['11.0.2'])).toBe('~/.tapsmith/redirector');
    expect(find([caskTar], {}, ['11.0.2'])).toBe('Homebrew cask');
    expect(find([])).toBeUndefined();
  });

  it('does not count a Homebrew install without the cask\'s redirector tarball', () => {
    // The formula (or a cask whose layout changed) has no tarball, so the daemon cannot extract one.
    expect(find([], {}, ['11.0.2'])).toBeUndefined();
  });
});

// ─── Item 5: human output ───

describe('doctor text output (PILOT-263 item 5)', () => {
  it('prints the fix line under an error', async () => {
    writeConfig("export default { platform: 'ios' }\n");
    const { text } = await doctorText();
    expect(text).toMatch(/✗ Xcode not installed[^\n]*\n\s+↳ Install Xcode/);
  });

  it('prints every JSON fix in the text output', async () => {
    withAdb('List of devices attached\nR58N123\tunauthorized\n');
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { json } = await doctorJson();
    const { text } = await doctorText();
    const fixes = json.checks.filter((c) => c.fix).map((c) => c.fix!);
    expect(fixes.length).toBeGreaterThan(2);
    for (const fix of fixes) expect(text).toContain(`↳ ${fix.split('\n')[0]}`);
  });
});
