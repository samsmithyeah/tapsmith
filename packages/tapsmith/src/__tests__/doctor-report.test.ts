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
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: readonly string[] = []) => {
      const key = [cmd, ...args].join(' ');
      exec.calls.push(key);
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

  it('a config that targets iOS on Linux fails: iOS needs macOS', async () => {
    setPlatform('linux');
    withAdb();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail', label: expect.stringContaining('macOS') });
    expect(ids(json)).toContain('adb');
    expect(code).toBe(1);
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

  it('an offline device gets the reconnect fix', async () => {
    withAdb('List of devices attached\nemulator-5556\toffline\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({ status: 'warn', fix: expect.stringContaining('adb kill-server') });
  });

  it('a usable device passes, and an unusable one beside it is mentioned', async () => {
    withAdb('List of devices attached\nemulator-5554\tdevice\nR58N123\tunauthorized\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({
      status: 'pass',
      label: '1 device connected',
      detail: 'emulator-5554; not usable: R58N123 (unauthorized)',
    });
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
  const find = (present: string[], env: NodeJS.ProcessEnv = {}, brew = false) =>
    findMitmRedirector(env, '/h', (p) => present.includes(p), () => brew);

  it('checks the daemon\'s locations in the daemon\'s order, then Homebrew', () => {
    expect(find(['/x'], { TAPSMITH_REDIRECTOR_APP: '/x' }, true)).toBe('TAPSMITH_REDIRECTOR_APP');
    expect(find([path.join('/Applications', bin)], { TAPSMITH_REDIRECTOR_APP: '/gone' }, true)).toBe('/Applications');
    expect(find([path.join('/h', '.tapsmith', 'redirector', bin)], {}, true)).toBe('~/.tapsmith/redirector');
    expect(find([], {}, true)).toBe('Homebrew');
    expect(find([])).toBeUndefined();
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
