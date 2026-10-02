import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDevicectlDeviceList } from '../ios-devicectl.js';

// Real `xcrun devicectl list devices --json-output` from Xcode 27.0 (devicectl
// 642.16), trimmed to five entries: a shutdown simulator, a simulator edited to
// booted, and three physical iPhones in the same captured shape (synthetic
// UDIDs) — one cabled and paired, one the Mac only remembers (unplugged and
// unpaired: `tunnelState: "unavailable"`, no transport), one cabled but not
// trusted yet. The daemon's parser (packages/tapsmith-core/src/ios/device.rs)
// is tested against this same file, so the SDK and the daemon cannot disagree
// about which devices are connected physical devices (PILOT-386, PILOT-395).
const XCODE27_FIXTURE = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'devicectl-list-devices-xcode27.json'),
  'utf-8',
);
const CONNECTED = '00008140-000A1B2C3D4E001C';
const REMEMBERED = '00008140-000F9E8D7C6B001C';
const UNTRUSTED = '00008110-0001A2B3C4D5002E';

describe('parseDevicectlDeviceList on the shared Xcode 27 fixture (PILOT-386, PILOT-395)', () => {
  it('keeps only real hardware: neither the shutdown nor the booted simulator is a physical device', () => {
    expect(parseDevicectlDeviceList(XCODE27_FIXTURE).map((d) => d.udid)).toEqual([CONNECTED, REMEMBERED, UNTRUSTED]);
  });

  it('marks the remembered device not connected, and the cabled ones (paired or not) connected', () => {
    const byUdid = new Map(parseDevicectlDeviceList(XCODE27_FIXTURE).map((d) => [d.udid, d]));
    expect(byUdid.get(CONNECTED)).toMatchObject({ isConnected: true, isPaired: true, transportType: 'wired' });
    expect(byUdid.get(REMEMBERED)).toMatchObject({ isConnected: false, isPaired: false, transportType: 'unknown' });
    // Plugged in but not trusted yet: still connected, so setup-device can
    // tell the user to pair it.
    expect(byUdid.get(UNTRUSTED)).toMatchObject({ isConnected: true, isPaired: false });
  });
});

describe('parseDevicectlDeviceList', () => {
  it('parses a real unpaired iPhone entry', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            connectionProperties: {
              pairingState: 'unpaired',
              transportType: 'wired',
            },
            deviceProperties: {
              name: "Sam\u2019s iPhone",
              bootState: 'booted',
              ddiServicesAvailable: false,
              osVersionNumber: '26.2.1',
              developerModeStatus: 'enabled',
            },
            hardwareProperties: {
              platform: 'iOS',
              productType: 'iPhone17,1',
              udid: '00008140-00096C9014F3001C',
            },
            identifier: 'EBAACA98-F83F-5F5A-85A7-23F989DD5585',
          },
        ],
      },
    });
    const result = parseDevicectlDeviceList(json);
    expect(result).toHaveLength(1);
    const d = result[0]!;
    expect(d.udid).toBe('00008140-00096C9014F3001C');
    expect(d.name).toBe("Sam\u2019s iPhone");
    expect(d.isPaired).toBe(false);
    expect(d.ddiServicesAvailable).toBe(false);
    expect(d.osVersion).toBe('26.2.1');
    expect(d.bootState).toBe('booted');
    expect(d.developerModeStatus).toBe('enabled');
    expect(d.transportType).toBe('wired');
  });

  it('captures transportType for wireless-paired devices', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            connectionProperties: { pairingState: 'paired', transportType: 'localNetwork' },
            deviceProperties: { name: 'iPhone' },
            hardwareProperties: { platform: 'iOS', udid: 'UDID' },
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json)[0]?.transportType).toBe('localNetwork');
  });

  it('falls back to "unknown" when developerModeStatus is absent', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            connectionProperties: { pairingState: 'paired' },
            deviceProperties: { name: 'iPhone', bootState: 'booted' },
            hardwareProperties: { platform: 'iOS', udid: 'UDID' },
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json)[0]?.developerModeStatus).toBe('unknown');
  });

  it('filters out non-iOS entries (Apple Watch, Mac)', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            hardwareProperties: { platform: 'iOS', udid: 'IOS-UDID' },
            deviceProperties: { name: 'iPhone', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
          {
            hardwareProperties: { platform: 'watchOS', udid: 'WATCH-UDID' },
            deviceProperties: { name: 'Apple Watch', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
          {
            hardwareProperties: { platform: 'macOS', udid: 'MAC-UDID' },
            deviceProperties: { name: 'Mac', bootState: 'booted' },
            connectionProperties: { pairingState: 'paired' },
          },
        ],
      },
    });
    const result = parseDevicectlDeviceList(json);
    expect(result.map((d) => d.udid)).toEqual(['IOS-UDID']);
  });

  it('filters out simulators (Xcode 27 reality flag, or the CoreSimulator provider on older devicectl)', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            hardwareProperties: { platform: 'iOS', udid: 'REAL-UDID', reality: 'physical' },
            deviceProperties: { name: 'iPhone', bootState: 'booted', provider: 'com.apple.CoreDevice.RemotePairingDeviceProvider' },
            connectionProperties: { pairingState: 'paired', transportType: 'wired' },
          },
          {
            hardwareProperties: { platform: 'iOS', udid: 'SIM-UDID', reality: 'simulated' },
            deviceProperties: { name: 'iPhone 17', bootState: 'booted', provider: 'com.apple.CoreSimulator.SimulatorCoreDevicePlugin' },
            connectionProperties: { pairingState: 'paired', transportType: 'sameMachine' },
          },
          {
            // Older devicectl without `reality`: the CoreSimulator provider alone marks it.
            hardwareProperties: { platform: 'iOS', udid: 'SIM-2' },
            deviceProperties: { name: 'iPhone 16', bootState: 'shutdown', provider: 'com.apple.CoreSimulator.SimulatorCoreDevicePlugin' },
            connectionProperties: { pairingState: 'paired', transportType: 'sameMachine' },
          },
          {
            // No reality field and no provider (pre-Xcode-27 output): real hardware.
            hardwareProperties: { platform: 'iOS', udid: 'OLD-XCODE-UDID' },
            deviceProperties: { name: 'iPhone 15', bootState: 'booted' },
            connectionProperties: {},
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json).map((d) => d.udid)).toEqual(['REAL-UDID', 'OLD-XCODE-UDID']);
  });

  it('a device counts as connected unless devicectl says its tunnel is unavailable and gives no transport', () => {
    const entry = (udid: string, connectionProperties: Record<string, unknown>) => ({
      hardwareProperties: { platform: 'iOS', udid },
      deviceProperties: { name: udid },
      connectionProperties,
    });
    const json = JSON.stringify({
      result: {
        devices: [
          entry('TUNNEL-UP', { tunnelState: 'connected', transportType: 'wired' }),
          // The normal idle state of a cabled, trusted phone.
          entry('TUNNEL-IDLE', { tunnelState: 'disconnected', transportType: 'wired' }),
          entry('WIFI', { tunnelState: 'disconnected', transportType: 'localNetwork' }),
          entry('GONE', { tunnelState: 'unavailable' }),
          // A transport means CoreDevice is reaching it now, even without a
          // tunnel (e.g. a MobileDevice-only entry for an older iOS).
          entry('CABLED-NO-TUNNEL', { tunnelState: 'unavailable', transportType: 'wired' }),
          // Older devicectl without tunnelState: never hidden on missing data.
          entry('NO-STATE', {}),
        ],
      },
    });
    expect(parseDevicectlDeviceList(json).map((d) => [d.udid, d.isConnected])).toEqual([
      ['TUNNEL-UP', true],
      ['TUNNEL-IDLE', true],
      ['WIFI', true],
      ['GONE', false],
      ['CABLED-NO-TUNNEL', true],
      ['NO-STATE', true],
    ]);
  });

  it('returns empty array for missing / malformed result', () => {
    expect(parseDevicectlDeviceList('{}')).toEqual([]);
    expect(parseDevicectlDeviceList('{"result":{"devices":"not-an-array"}}')).toEqual([]);
    expect(parseDevicectlDeviceList('{"result":{}}')).toEqual([]);
  });

  it('skips devices with empty udid', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            hardwareProperties: { platform: 'iOS' }, // no udid
            deviceProperties: { name: 'mystery', bootState: 'booted' },
          },
        ],
      },
    });
    expect(parseDevicectlDeviceList(json)).toEqual([]);
  });
});
