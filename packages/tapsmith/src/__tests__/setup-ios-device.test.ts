import { describe, it, expect, vi } from 'vitest';
import {
  buildSetupDeviceJson,
  runSetupIosDevice,
  type SetupDeviceDeps,
  type CheckResult,
} from '../setup-ios-device.js';
import type { PhysicalDeviceInfo } from '../ios-devicectl.js';

const device = (over: Partial<PhysicalDeviceInfo> = {}): PhysicalDeviceInfo => ({
  udid: '00008110-000A',
  name: "Sam's iPhone",
  osVersion: '26.1',
  isPaired: true,
  ddiServicesAvailable: false,
  bootState: 'booted',
  developerModeStatus: 'enabled',
  transportType: 'wired',
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
    const json = buildSetupDeviceJson(passing, { ok: true, devices: [device()], label: 'Physical iOS device paired' });
    expect(Object.keys(json)).toEqual(['ok', 'checks', 'devices']);
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
      { ok: true, devices: [device()], label: 'Physical iOS device paired' },
    );
    expect(json.ok).toBe(false);
    expect(json.checks[0]).toMatchObject({ id: 'iproxy', status: 'fail' });
    expect(buildSetupDeviceJson(passing, { ok: true, devices: [device()], label: 'x' }).ok).toBe(true);
  });

  it('no device listed is a failed device-connected check with its fix', () => {
    const json = buildSetupDeviceJson(passing, { ok: false, devices: [], label: 'Physical iOS device paired', fix: ['No physical iOS device found.', '  1) Plug it in'] });
    expect(json.ok).toBe(false);
    expect(json.checks.at(-1)).toEqual({
      id: 'device-connected', status: 'fail', label: 'Physical iOS device paired', fix: 'No physical iOS device found.\n  1) Plug it in',
    });
    expect(json.devices).toEqual([]);
  });

  it('an unpaired device makes ok false, fails device-connected naming it, and carries its own fix', () => {
    const json = buildSetupDeviceJson(passing, {
      ok: true, devices: [device(), device({ udid: 'U2', name: 'iPad', isPaired: false })], label: 'Physical iOS device paired',
    });
    expect(json.ok).toBe(false);
    expect(json.checks.at(-1)).toEqual({
      id: 'device-connected', status: 'fail', label: 'Physical iOS device paired',
      detail: 'not paired: iPad (U2)', fix: expect.stringContaining('Use for Development'),
    });
    expect(json.devices[1]).toMatchObject({ paired: false, fix: expect.stringContaining('Use for Development') });
  });

  it.each([
    ['all passing', passing, { ok: true, devices: [device()], label: 'x' }],
    ['a required check failing', [{ id: 'iproxy', result: { label: 'iproxy', ok: false } }], { ok: true, devices: [device()], label: 'x' }],
    ['no device', passing, { ok: false, devices: [], label: 'x' }],
    ['an unpaired device', passing, { ok: true, devices: [device({ isPaired: false })], label: 'x' }],
  ])('ok is false exactly when some check fails (%s)', (_name, results, deviceCheck) => {
    const json = buildSetupDeviceJson(results, deviceCheck);
    expect(json.ok).toBe(!json.checks.some((c) => c.status === 'fail'));
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
        deviceCheck: () => ({ ok: true, devices: [device()], label: 'Physical iOS device paired' }),
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
    const h = harness({ deviceCheck: () => ({ ok: false, devices: [], label: 'Physical iOS device paired', fix: ['plug it in'] }) });
    expect(await runSetupIosDevice({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ ok: false, devices: [] });
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
        deviceCheck: () => ({ ok: true, devices: [device({ isPaired: false })], label: 'Physical iOS device paired' }),
      }).deps)).toBe(1);
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
