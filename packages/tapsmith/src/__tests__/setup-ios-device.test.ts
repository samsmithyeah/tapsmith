import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSetupDeviceJson,
  checkDeviceConnection,
  checkIosAgentBuilt,
  checkProfileExpiry,
  runSetupIosDevice,
  type SetupDeviceDeps,
  type CheckResult,
} from '../setup-ios-device.js';
import type { PhysicalDeviceInfo } from '../ios-devicectl.js';
import { tapsmithPackageVersion } from '../ios-agent-paths.js';

const device = (over: Partial<PhysicalDeviceInfo> = {}): PhysicalDeviceInfo => ({
  udid: '00008110-000A',
  name: "Sam's iPhone",
  osVersion: '26.1',
  isPaired: true,
  ddiServicesAvailable: false,
  bootState: 'booted',
  developerModeStatus: 'enabled',
  transportType: 'wired',
  isConnected: true,
  ...over,
});

const passing: Array<{ id: string; result: CheckResult }> = [
  { id: 'xcode-clt', result: { label: 'Xcode command-line tools', ok: true, detail: '/Applications/Xcode.app/Contents/Developer' } },
  { id: 'ios-agent-runner', result: { label: 'Signed iOS agent runner', ok: false, advisory: true, fix: ['Not built yet.', '  tapsmith ios build-agent'] } },
];

// A public contract (docs/api-reference.md, CLI → JSON output): a change here
// must be deliberate.
describe('buildSetupDeviceJson() (ios setup-device --json schema)', () => {
  it('has exactly ok, checks and devices, with the documented keys', () => {
    const json = buildSetupDeviceJson(passing, { ok: true, notConnected: [], devices: [device()], label: 'Physical iOS device paired' });
    expect(Object.keys(json)).toEqual(['ok', 'checks', 'devices', 'notConnected']);
    expect(json.ok).toBe(true);
    expect(json.checks).toEqual([
      { id: 'xcode-clt', status: 'pass', label: 'Xcode command-line tools', detail: '/Applications/Xcode.app/Contents/Developer' },
      { id: 'ios-agent-runner', status: 'warn', label: 'Signed iOS agent runner', fix: 'Not built yet.\n  tapsmith ios build-agent' },
      { id: 'device-connected', status: 'pass', label: 'Physical iOS device paired' },
    ]);
    expect(json.devices).toEqual([{
      udid: '00008110-000A', name: "Sam's iPhone", osVersion: '26.1', paired: true, developerMode: 'enabled', transport: 'wired',
    }]);
  });

  it('a failed required check is fail and makes ok false; an advisory one is warn and does not', () => {
    const json = buildSetupDeviceJson(
      [{ id: 'iproxy', result: { label: 'libimobiledevice (iproxy)', ok: false, fix: ['brew install libimobiledevice'] } }],
      { ok: true, notConnected: [], devices: [device()], label: 'Physical iOS device paired' },
    );
    expect(json.ok).toBe(false);
    expect(json.checks[0]).toMatchObject({ id: 'iproxy', status: 'fail' });
    expect(buildSetupDeviceJson(passing, { ok: true, notConnected: [], devices: [device()], label: 'x' }).ok).toBe(true);
  });

  it('no device listed is a failed device-connected check with its fix', () => {
    const json = buildSetupDeviceJson(passing, { ok: false, notConnected: [], devices: [], label: 'Physical iOS device paired', fix: ['No physical iOS device found.', '  1) Plug it in'] });
    expect(json.ok).toBe(false);
    expect(json.checks.at(-1)).toEqual({
      id: 'device-connected', status: 'fail', label: 'Physical iOS device paired', fix: 'No physical iOS device found.\n  1) Plug it in',
    });
    expect(json.devices).toEqual([]);
  });

  it('an unpaired device makes ok false, fails device-connected naming it, and carries its own fix', () => {
    const json = buildSetupDeviceJson(passing, {
      ok: true, notConnected: [], devices: [device(), device({ udid: 'U2', name: 'iPad', isPaired: false })], label: 'Physical iOS device paired',
    });
    expect(json.ok).toBe(false);
    expect(json.checks.at(-1)).toEqual({
      id: 'device-connected', status: 'fail', label: 'Physical iOS device paired',
      detail: 'not paired: iPad (U2)', fix: expect.stringContaining('Use for Development'),
    });
    expect(json.devices[1]).toMatchObject({ paired: false, fix: expect.stringContaining('Use for Development') });
  });

  it('a device with Developer Mode off makes ok false, fails device-connected naming it, and carries the Settings fix (PILOT-264)', () => {
    const json = buildSetupDeviceJson(passing, {
      ok: true, notConnected: [], devices: [device(), device({ udid: 'U3', name: 'iPad', developerModeStatus: 'disabled' })], label: 'Physical iOS device paired',
    });
    expect(json.ok).toBe(false);
    expect(json.checks.at(-1)).toEqual({
      id: 'device-connected', status: 'fail', label: 'Physical iOS device paired',
      detail: 'Developer Mode off: iPad (U3)', fix: expect.stringContaining('Settings → Privacy & Security → Developer Mode'),
    });
    expect(json.devices[1]).toMatchObject({ developerMode: 'disabled', fix: expect.stringContaining('Developer Mode') });
    expect(json.devices[0]).not.toHaveProperty('fix');
  });

  it('a device both unpaired and with Developer Mode off lists both, with both fixes', () => {
    const json = buildSetupDeviceJson(passing, {
      ok: true, notConnected: [], devices: [device({ udid: 'U4', name: 'Old', isPaired: false, developerModeStatus: 'disabled' })], label: 'x',
    });
    expect(json.checks.at(-1)).toMatchObject({
      status: 'fail',
      detail: 'not paired: Old (U4); Developer Mode off: Old (U4)',
      fix: expect.stringMatching(/Use for Development[\s\S]*Developer Mode/),
    });
    expect(json.devices[0].fix).toMatch(/Use for Development[\s\S]*Developer Mode/);
  });

  it('Developer Mode "unknown" (not reported, e.g. before iOS 16) does not fail', () => {
    const json = buildSetupDeviceJson(passing, { ok: true, notConnected: [], devices: [device({ developerModeStatus: 'unknown' })], label: 'x' });
    expect(json.ok).toBe(true);
    expect(json.checks.at(-1)).toMatchObject({ status: 'pass' });
  });

  it.each([
    ['all passing', passing, { ok: true, notConnected: [], devices: [device()], label: 'x' }],
    ['a required check failing', [{ id: 'iproxy', result: { label: 'iproxy', ok: false } }], { ok: true, notConnected: [], devices: [device()], label: 'x' }],
    ['no device', passing, { ok: false, notConnected: [], devices: [], label: 'x' }],
    ['an unpaired device', passing, { ok: true, notConnected: [], devices: [device({ isPaired: false })], label: 'x' }],
    ['Developer Mode off', passing, { ok: true, notConnected: [], devices: [device({ developerModeStatus: 'disabled' })], label: 'x' }],
  ])('ok is false exactly when some check fails (%s)', (_name, results, deviceCheck) => {
    const json = buildSetupDeviceJson(results, deviceCheck);
    expect(json.ok).toBe(!json.checks.some((c) => c.status === 'fail'));
  });
});

// PILOT-386: devicectl also lists devices the Mac only remembers (unplugged, or
// paired with another Mac). Only devices connected now count toward the verdict.
describe('checkDeviceConnection() judges only connected devices (PILOT-386)', () => {
  const remembered = device({ udid: 'GONE', name: 'Old iPhone', isPaired: false, isConnected: false, transportType: 'unknown' });

  it('a remembered, unpaired device beside a ready one does not fail setup-device', () => {
    const check = checkDeviceConnection([device(), remembered]);
    expect(check).toMatchObject({ ok: true, devices: [device()], notConnected: [remembered] });
    const json = buildSetupDeviceJson(passing, check);
    expect(json.ok).toBe(true);
    expect(json.checks.at(-1)).toMatchObject({ id: 'device-connected', status: 'pass' });
    expect(json.devices.map((d) => d.udid)).toEqual(['00008110-000A']);
    expect(json.notConnected).toEqual([{ udid: 'GONE', name: 'Old iPhone' }]);
  });

  it('only remembered devices fails, naming them as not connected rather than unpaired', () => {
    const check = checkDeviceConnection([remembered, device({ udid: 'GONE-2', name: 'iPad', isConnected: false })]);
    expect(check.ok).toBe(false);
    expect(check.devices).toEqual([]);
    const fix = (check.fix ?? []).join('\n');
    expect(fix).toContain('No physical iOS device is connected');
    expect(fix).toContain('Old iPhone (GONE), iPad (GONE-2)');
    expect(fix).toContain('Plug the device into this Mac via USB');
    expect(fix).not.toContain('Use for Development');
    const json = buildSetupDeviceJson(passing, check);
    expect(json.ok).toBe(false);
    expect(json.notConnected.map((d) => d.udid)).toEqual(['GONE', 'GONE-2']);
  });

  it('a remembered device that is still paired does not pass setup-device on its own', () => {
    expect(checkDeviceConnection([device({ isConnected: false })]).ok).toBe(false);
  });

  it('a cabled device that is not trusted yet is still judged, and still fails as unpaired', () => {
    const check = checkDeviceConnection([device({ isPaired: false })]);
    expect(check.devices).toHaveLength(1);
    expect(buildSetupDeviceJson(passing, check).ok).toBe(false);
  });

  it('nothing listed at all keeps the plain "no device found" steps', () => {
    const check = checkDeviceConnection([]);
    expect(check).toMatchObject({ ok: false, devices: [], notConnected: [] });
    expect(check.fix?.[0]).toBe('No physical iOS device found. To connect one:');
  });

  it('text mode exits 0 and shows the remembered device dimmed as ignored', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const code = await runSetupIosDevice({ json: false }, {
        platform: 'darwin',
        hostChecks: () => passing,
        deviceCheck: () => checkDeviceConnection([device(), remembered]),
      });
      expect(code).toBe(0);
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('Old iPhone');
      expect(text).toContain('not connected — ignored');
      expect(text).not.toContain('not paired');
    } finally {
      log.mockRestore();
    }
  });
});

describe('runSetupIosDevice() --json', () => {
  const harness = (over: Partial<SetupDeviceDeps>): { deps: Partial<SetupDeviceDeps>; out: () => string; err: () => string } => {
    let out = '';
    let err = '';
    return {
      deps: {
        platform: 'darwin',
        hostChecks: () => passing,
        deviceCheck: () => ({ ok: true, notConnected: [], devices: [device()], label: 'Physical iOS device paired' }),
        stdout: (t) => { out += t; },
        stderr: (t) => { err += t; },
        ...over,
      },
      out: () => out,
      err: () => err,
    };
  };

  it('prints only the JSON report and exits 0 when the required checks pass', async () => {
    const h = harness({});
    expect(await runSetupIosDevice({ json: true }, h.deps)).toBe(0);
    expect((JSON.parse(h.out()) as { ok: boolean }).ok).toBe(true);
    expect(h.err()).toBe('');
  });

  it('exits 1 with the report (not an error envelope) when a required check fails', async () => {
    const h = harness({ deviceCheck: () => ({ ok: false, notConnected: [], devices: [], label: 'Physical iOS device paired', fix: ['plug it in'] }) });
    expect(await runSetupIosDevice({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ ok: false, notConnected: [], devices: [] });
  });

  it('off macOS, prints the UNSUPPORTED_PLATFORM envelope', async () => {
    const h = harness({ platform: 'linux' });
    expect(await runSetupIosDevice({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toEqual({
      error: { code: 'UNSUPPORTED_PLATFORM', message: 'tapsmith ios setup-device is only supported on macOS.', fix: expect.any(String) },
    });
    expect(h.err()).toBe('');
  });

  it('reports a check that throws as UNEXPECTED_ERROR', async () => {
    const h = harness({ deviceCheck: () => { throw new Error('devicectl exploded'); } });
    expect(await runSetupIosDevice({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ error: { code: 'UNEXPECTED_ERROR', message: expect.stringContaining('devicectl exploded') } });
  });

  it('text mode on macOS exits 0 when the required checks pass and 1 when one fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runSetupIosDevice({ json: false }, harness({}).deps)).toBe(0);
      expect(await runSetupIosDevice({ json: false }, harness({
        hostChecks: () => [{ id: 'iproxy', result: { label: 'libimobiledevice (iproxy)', ok: false, fix: ['brew install libimobiledevice'] } }],
      }).deps)).toBe(1);
      expect(await runSetupIosDevice({ json: false }, harness({
        deviceCheck: () => ({ ok: true, notConnected: [], devices: [device({ isPaired: false })], label: 'Physical iOS device paired' }),
      }).deps)).toBe(1);
      // PILOT-264: a paired device with Developer Mode off is not "ready".
      log.mockClear();
      expect(await runSetupIosDevice({ json: false }, harness({
        deviceCheck: () => ({ ok: true, notConnected: [], devices: [device({ developerModeStatus: 'disabled' })], label: 'Physical iOS device paired' }),
      }).deps)).toBe(1);
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('Developer Mode off');
      expect(text).toContain('Settings → Privacy & Security → Developer Mode');
      expect(text).not.toContain('ready for tapsmith test');
      // Advisory failures do not block.
      expect(await runSetupIosDevice({ json: false }, harness({
        hostChecks: () => [{ id: 'ios-agent-runner', result: { label: 'Signed iOS agent runner', ok: false, advisory: true } }],
      }).deps)).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('text mode is unchanged: off macOS the message goes to stderr', async () => {
    const h = harness({ platform: 'linux' });
    expect(await runSetupIosDevice({ json: false }, h.deps)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('only supported on macOS');
  });
});

describe('text-mode closing advice (PILOT-264)', () => {
  it('says the device and runner are auto-detected instead of telling the user to set them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await runSetupIosDevice({ json: false }, {
        platform: 'darwin',
        hostChecks: () => passing,
        deviceCheck: () => ({ ok: true, notConnected: [], devices: [device()], label: 'Physical iOS device paired' }),
      })).toBe(0);
      // Strip ANSI so the assertions read the words.
      const text = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      expect(text).toContain('ready for tapsmith test');
      expect(text).toMatch(/finds the device and the signed agent runner itself/);
      expect(text).not.toMatch(/device: '<UDID>'/);
      expect(text).not.toMatch(/iosXctestrun: '<path>'/);
    } finally {
      log.mockRestore();
    }
  });
});

// ─── Runner lookup (shared with tapsmith test) ───

describe('checkIosAgentBuilt / checkProfileExpiry find the npm build (PILOT-264)', () => {
  let tmp: string;
  let savedHome: string | undefined;
  const npmAgent = () => path.join(tmp, 'home', '.tapsmith', 'ios-agent');
  const npmBuild = (version: string) => {
    const products = path.join(npmAgent(), '.build-device', 'Build', 'Products');
    fs.mkdirSync(products, { recursive: true });
    fs.writeFileSync(path.join(npmAgent(), '.tapsmith-version'), version);
    fs.writeFileSync(path.join(products, 'Agent_iphoneos26.4-arm64.xctestrun'), '<plist/>');
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-setup-')));
    fs.mkdirSync(path.join(tmp, 'home'));
    fs.mkdirSync(path.join(tmp, 'project'));
    savedHome = process.env.HOME;
    process.env.HOME = path.join(tmp, 'home');
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the npm build as built, with its ~ path', () => {
    npmBuild(tapsmithPackageVersion());
    const result = checkIosAgentBuilt(path.join(tmp, 'project'));
    expect(result).toMatchObject({ ok: true });
    expect(result.detail).toBe('~/.tapsmith/ios-agent/.build-device/Build/Products/Agent_iphoneos26.4-arm64.xctestrun');
  });

  it('flags an npm build from another version as needing a rebuild', () => {
    npmBuild('0.0.1-old');
    const result = checkIosAgentBuilt(path.join(tmp, 'project'));
    expect(result).toMatchObject({ ok: false, advisory: true });
    expect(result.fix?.join('\n')).toMatch(/built by Tapsmith 0\.0\.1-old[\s\S]*tapsmith ios build-agent/);
  });

  it('with a stale npm build, the profile-expiry row points at the rebuild instead of saying nothing is built', () => {
    npmBuild('0.0.1-old');
    expect(checkProfileExpiry(path.join(tmp, 'project')).detail).toBe('not checked: the runner needs a rebuild (above)');
  });

  it('still says "not built yet" with nothing built', () => {
    const result = checkIosAgentBuilt(path.join(tmp, 'project'));
    expect(result).toMatchObject({ ok: false, advisory: true });
    expect(result.fix?.[0]).toMatch(/Not built yet/);
  });

  it('profile expiry looks at the same build (no profile inside → could not determine, not "no runner")', () => {
    expect(checkProfileExpiry(path.join(tmp, 'project')).detail).toMatch(/no signed runner/);
    npmBuild(tapsmithPackageVersion());
    expect(checkProfileExpiry(path.join(tmp, 'project')).detail).toMatch(/could not determine/);
  });
});
