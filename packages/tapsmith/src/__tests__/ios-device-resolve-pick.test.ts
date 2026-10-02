import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// `resolvePhysicalIosDevice()` (the physical-device auto-pick behind
// `tapsmith test` with no `device`) driven through the real devicectl parser:
// `xcrun devicectl` is replaced by one that writes a fixture to the
// `--json-output` path, and `idevice_id -l` by a fixed USB list.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const devicectl = vi.hoisted(() => ({ json: '', usb: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'xcrun' && args[0] === 'devicectl') {
        fs.writeFileSync(args[args.indexOf('--json-output') + 1], devicectl.json);
        return Buffer.from('');
      }
      if (cmd === 'idevice_id') return devicectl.usb;
      throw new Error(`unexpected command in test: ${cmd}`);
    }),
  };
});

const { resolvePhysicalIosDevice } = await import('../ios-device-resolve.js');
const { describeUnreachablePhysicalDevice, isPhysicalDevice, listPhysicalDevices } = await import('../ios-devicectl.js');

const CONNECTED = '00008140-000A1B2C3D4E001C';
const REMEMBERED = '00008140-000F9E8D7C6B001C';

/** The shared Xcode 27 fixture with every entry paired (the remembered phone included). */
function fixtureWithAllPaired(): string {
  const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'devicectl-list-devices-xcode27.json'), 'utf-8')) as {
    result: { devices: Array<{ connectionProperties: Record<string, unknown> }> }
  };
  for (const d of data.result.devices) d.connectionProperties['pairingState'] = 'paired';
  return JSON.stringify(data);
}

describe('resolvePhysicalIosDevice() picks only a connected device (PILOT-386)', () => {
  beforeEach(() => {
    devicectl.json = fixtureWithAllPaired();
    devicectl.usb = '';
  });

  it('the USB-attached connected phone is picked', () => {
    devicectl.usb = `${CONNECTED}\n`;
    expect(resolvePhysicalIosDevice()).toBe(CONNECTED);
  });

  it('with idevice_id seeing nothing, the remembered phone is not among the candidates', () => {
    // Before PILOT-386 every paired device was a fallback candidate, the
    // remembered, unplugged phone included (3 instead of 2).
    let message = '';
    try {
      resolvePhysicalIosDevice();
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/Multiple paired physical iOS devices detected \(2\)/);
    expect(message).not.toContain(REMEMBERED);
  });

  it('only remembered devices → the "no paired device" error, not a pick of an unplugged phone', () => {
    const data = JSON.parse(devicectl.json) as { result: { devices: Array<{ hardwareProperties: { udid: string } }> } };
    data.result.devices = data.result.devices.filter((d) => d.hardwareProperties.udid === REMEMBERED);
    devicectl.json = JSON.stringify(data);
    expect(() => resolvePhysicalIosDevice()).toThrow(/No connected, paired physical iOS device detected/);
  });

  it('a phone devicectl cannot reach is not a candidate even if idevice_id lists it — the daemon would not list it either', () => {
    devicectl.usb = `${REMEMBERED}\n`;
    expect(() => resolvePhysicalIosDevice()).toThrow(/Multiple paired physical iOS devices detected \(2\)/);
    expect(() => resolvePhysicalIosDevice()).not.toThrow(new RegExp(REMEMBERED));
  });

  it('isPhysicalDevice still knows a remembered phone, so a pinned one takes the devicectl path, not simctl', () => {
    expect(listPhysicalDevices().map((d) => d.udid)).toContain(REMEMBERED);
    expect(isPhysicalDevice(REMEMBERED)).toBe(true);
  });
});

describe('describeUnreachablePhysicalDevice() (PILOT-386)', () => {
  beforeEach(() => {
    devicectl.json = fs.readFileSync(path.join(fixtures, 'devicectl-list-devices-xcode27.json'), 'utf-8');
    devicectl.usb = '';
  });

  it('names a remembered phone as not connected, with what to do', () => {
    expect(describeUnreachablePhysicalDevice(REMEMBERED)).toMatch(
      /^Remembered iPhone \(00008140-000F9E8D7C6B001C\) is not connected: .*Plug it in with a USB cable/,
    );
  });

  it('says nothing for a connected phone, a simulator or an unknown UDID', () => {
    expect(describeUnreachablePhysicalDevice(CONNECTED)).toBeUndefined();
    expect(describeUnreachablePhysicalDevice('15CD8814-5BC0-4BDC-B688-E5D82BF4064C')).toBeUndefined();
    expect(describeUnreachablePhysicalDevice('NOPE')).toBeUndefined();
  });
});
