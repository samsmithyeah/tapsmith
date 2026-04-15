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

describe('buildDeviceRows', () => {
  it('labels an iOS simulator as ios-sim', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM-UDID', model: 'iPhone 17 Pro', platform: 'ios', isEmulator: true, state: 'Booted' })],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe('ios-sim');
    expect(rows[0]!.name).toBe('iPhone 17 Pro');
    expect(rows[0]!.state).toBe('Booted');
    expect(rows[0]!.notes).toEqual([]);
  });

  it('labels a USB-attached physical iPhone as ios-device and enriches from devicectl', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'PHYS-UDID', model: "Sam's iPhone", platform: 'ios', isEmulator: false, state: 'Discovered' })],
      [physicalDevice({ udid: 'PHYS-UDID', name: "Sam's iPhone", osVersion: '26.2.1' })],
      new Set(['PHYS-UDID']),
    );
    expect(rows[0]!.platform).toBe('ios-device');
    expect(rows[0]!.state).toBe('booted');
    expect(rows[0]!.notes).toEqual(['iOS 26.2.1']);
  });

  it('flags a physical device without pairing', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1', isPaired: false })],
      new Set(['UDID']),
    );
    expect(rows[0]!.notes).toEqual(['iOS 26.2.1', 'not paired']);
  });

  it('flags a physical device with developer mode off', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1', developerModeStatus: 'disabled' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.notes).toContain('developer mode off');
  });

  it('flags a devicectl-visible device that isn\'t actually attached via USB', () => {
    // CoreDevice keeps Wi-Fi-paired devices listed forever; devicectl's
    // own transportType reports `localNetwork` even for cabled devices
    // once Wi-Fi pairing exists. `idevice_id -l` (libimobiledevice) is
    // the ground-truth signal for "is there a USB data connection right
    // now?", and Pilot's agent tunnel is USB-only.
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1', transportType: 'localNetwork' })],
      new Set(), // not in USB set
    );
    expect(rows[0]!.notes).toContain('not attached via USB');
  });

  it('does NOT flag as wireless when USB attached', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      // devicectl reports localNetwork even for cabled devices — the
      // USB set is the source of truth, not the transport type.
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1', transportType: 'localNetwork' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.notes).not.toContain('not attached via USB');
  });

  it('does NOT flag DDI-not-mounted — the listing is passive', () => {
    // `ddiServicesAvailable` is false whenever CoreDevice isn't actively
    // holding a DDI assertion. That's the common idle state even for
    // perfectly healthy devices; `setup-ios-device` surfaces it with a
    // fix-it hint, but `list-devices` should stay quiet about it.
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1', ddiServicesAvailable: false })],
    );
    expect(rows[0]!.notes).not.toContain('DDI not mounted');
  });

  it('labels Android physical vs emulator', () => {
    const rows = buildDeviceRows(
      [
        daemonDevice({ serial: 'HT123', model: 'Pixel 9', platform: 'android', isEmulator: false, state: 'device' }),
        daemonDevice({ serial: 'emulator-5554', model: 'Pixel 5 (API 35)', platform: 'android', isEmulator: true, state: 'device' }),
      ],
      [],
    );
    expect(rows[0]!.platform).toBe('android');
    expect(rows[1]!.platform).toBe('android-emu');
  });

  it('handles a daemon entry with no devicectl enrichment', () => {
    // macOS without Xcode Command Line Tools, or a daemon running on a
    // non-Mac host: we still want to print the daemon's view without
    // decorating it.
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false, state: 'Discovered' })],
      [],
    );
    expect(rows[0]!.platform).toBe('ios-device');
    expect(rows[0]!.state).toBe('Discovered');
    expect(rows[0]!.notes).toEqual([]);
  });

  it('returns empty when no devices are connected', () => {
    expect(buildDeviceRows([], [])).toEqual([]);
  });
});
