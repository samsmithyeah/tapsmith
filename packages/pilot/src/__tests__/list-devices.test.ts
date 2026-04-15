import { describe, it, expect } from 'vitest';
import { buildDeviceRows } from '../list-devices.js';
import type { DeviceInfoProto } from '../grpc-client.js';
import type { PhysicalDeviceInfo } from '../ios-devicectl.js';

const daemonDevice = (overrides: Partial<DeviceInfoProto>): DeviceInfoProto => ({
  serial: '',
  model: '',
  state: '',
  isEmulator: false,
  platform: '',
  osVersion: '',
  ...overrides,
});

const physicalDevice = (overrides: Partial<PhysicalDeviceInfo>): PhysicalDeviceInfo => ({
  udid: '',
  name: '',
  osVersion: '',
  isPaired: true,
  ddiServicesAvailable: true,
  bootState: 'booted',
  developerModeStatus: 'enabled',
  transportType: 'wired',
  ...overrides,
});

describe('buildDeviceRows — platform labelling', () => {
  it('labels an iOS simulator as ios-sim', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM-UDID', model: 'iPhone 17 Pro', platform: 'ios', isEmulator: true, state: 'Booted' })],
      [],
    );
    expect(rows[0]!.platform).toBe('ios-sim');
  });

  it('labels a physical iPhone as ios-device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', model: "Sam's iPhone", platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.platform).toBe('ios-device');
  });

  it('labels Android emulators separately from real devices', () => {
    const rows = buildDeviceRows(
      [
        daemonDevice({ serial: 'HT123', platform: 'android', isEmulator: false, state: 'device' }),
        daemonDevice({ serial: 'emulator-5554', platform: 'android', isEmulator: true, state: 'device' }),
      ],
      [],
    );
    expect(rows[0]!.platform).toBe('android');
    expect(rows[1]!.platform).toBe('android-emu');
  });
});

describe('buildDeviceRows — readiness', () => {
  it('reports a USB-attached iOS physical device as ready', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(true);
    expect(rows[0]!.blockers).toEqual([]);
    expect(rows[0]!.osLabel).toBe('iOS 26.2.1');
  });

  it('flags an iOS physical device not attached via USB with an imperative fix', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1' })],
      new Set(), // idevice_id -l empty → phone isn't cabled
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers).toContain('Plug in via USB cable');
  });

  it('distinguishes a Wi-Fi-only iOS device from a fully-disconnected one', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', transportType: 'localNetwork' })],
      new Set(), // not cabled, but devicectl still sees it
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.includes('Wi-Fi only'))).toBe(true);
  });

  it('flags an unpaired iOS physical device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', isPaired: false })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.startsWith('Pair in Xcode'))).toBe(true);
  });

  it('flags an iOS device with Developer Mode off', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', developerModeStatus: 'disabled' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.startsWith('Enable Developer Mode'))).toBe(true);
  });

  it('does not false-alarm on ddiServicesAvailable=false (devicectl reports it unreliably)', () => {
    // Real-world case: a plugged-in, paired, Developer-Mode-on iPhone
    // whose DDI hasn't been mounted by Xcode this session still works
    // fine for `pilot test` — pilot mounts the DDI itself. list-devices
    // must not flag this as "need attention".
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', ddiServicesAvailable: false, osVersion: '26.2.1' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(true);
    expect(rows[0]!.blockers).toEqual([]);
  });

  it('iOS simulators are always ready (Pilot boots them on demand)', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM', platform: 'ios', isEmulator: true, state: 'Shutdown' })],
      [],
    );
    expect(rows[0]!.ready).toBe(true);
  });

  it('Android devices in `device` state are ready', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'device' })],
      [],
    );
    expect(rows[0]!.ready).toBe(true);
  });

  it('flags an unauthorized Android device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'unauthorized' })],
      [],
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.includes('USB debugging prompt'))).toBe(true);
  });

  it('flags an offline Android device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'offline' })],
      [],
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.includes('Reconnect cable'))).toBe(true);
  });

  it('builds a human-friendly Android OS label from the daemon-provided version', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'device', osVersion: '14' })],
      [],
    );
    expect(rows[0]!.osLabel).toBe('Android 14');
  });

  it('builds an iOS OS label for simulators from the daemon-provided runtime version', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM', platform: 'ios', isEmulator: true, state: 'Booted', osVersion: '18.1' })],
      [],
    );
    expect(rows[0]!.osLabel).toBe('iOS 18.1');
  });

  it('treats iOS physical devices as ready when devicectl enrichment is missing (non-macOS host)', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [], // no devicectl data → we can't judge, assume ready
    );
    expect(rows[0]!.ready).toBe(true);
  });
});

describe('buildDeviceRows — sort order', () => {
  it('ready devices come before not-ready devices', () => {
    const rows = buildDeviceRows(
      [
        daemonDevice({ serial: 'BLOCKED', platform: 'ios', isEmulator: false }),
        daemonDevice({ serial: 'READY', platform: 'ios', isEmulator: true, state: 'Booted' }),
      ],
      [physicalDevice({ udid: 'BLOCKED', osVersion: '26.2.1' })],
      new Set(), // BLOCKED is not attached via USB
    );
    expect(rows.map((r) => r.serial)).toEqual(['READY', 'BLOCKED']);
  });
});

describe('buildDeviceRows — empty input', () => {
  it('returns empty when no devices are connected', () => {
    expect(buildDeviceRows([], [])).toEqual([]);
  });
});
