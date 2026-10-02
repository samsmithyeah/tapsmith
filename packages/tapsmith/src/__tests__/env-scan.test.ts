import { describe, it, expect } from 'vitest';
import { parseSimctlDevicesJson } from '../env-scan.js';
import { parseAdbDevicesOutput } from '../adb-devices.js';

describe('parseAdbDevicesOutput()', () => {
  it('parses connected devices and skips header/offline entries', () => {
    const output = [
      'List of devices attached',
      'emulator-5554\tdevice',
      'R5CT20ABCDE\tdevice',
      'emulator-5556\toffline',
      '',
    ].join('\n');

    expect(parseAdbDevicesOutput(output)).toEqual([
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'R5CT20ABCDE', state: 'device' },
      { serial: 'emulator-5556', state: 'offline' },
    ]);
  });

  it('returns empty array for header-only output', () => {
    expect(parseAdbDevicesOutput('List of devices attached\n')).toEqual([]);
  });

  // PILOT-457: the run paths kept only the first word, so `no permissions (…)`
  // became "no" and got no advice.
  it('keeps a multi-word state whole', () => {
    const output = [
      'List of devices attached',
      '0123456789ABCDEF\tno permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
      'R5CR1234XYZ\tunauthorized',
      '',
    ].join('\n');
    expect(parseAdbDevicesOutput(output)).toEqual([
      {
        serial: '0123456789ABCDEF',
        state: 'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
      },
      { serial: 'R5CR1234XYZ', state: 'unauthorized' },
    ]);
  });

  it('skips adb\'s daemon start-up notices before the header', () => {
    const output = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554\tdevice',
      '',
    ].join('\n');
    expect(parseAdbDevicesOutput(output)).toEqual([{ serial: 'emulator-5554', state: 'device' }]);
  });

  it('handles CRLF line endings', () => {
    expect(parseAdbDevicesOutput('List of devices attached\r\nemulator-5554\tdevice\r\n'))
      .toEqual([{ serial: 'emulator-5554', state: 'device' }]);
  });
});

describe('parseSimctlDevicesJson()', () => {
  it('parses simulator devices from simctl JSON', () => {
    const output = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { name: 'iPhone 16', udid: 'ABC', state: 'Shutdown' },
        ],
      },
    });

    expect(parseSimctlDevicesJson(output)).toEqual([
      { name: 'iPhone 16', udid: 'ABC', state: 'Shutdown', runtime: 'iOS 18 2' },
    ]);
  });

  it('returns an empty list for malformed or unexpected JSON', () => {
    expect(parseSimctlDevicesJson('not-json')).toEqual([]);
    expect(parseSimctlDevicesJson('null')).toEqual([]);
    expect(parseSimctlDevicesJson('[]')).toEqual([]);
    expect(parseSimctlDevicesJson(JSON.stringify({ devices: null }))).toEqual([]);
    expect(parseSimctlDevicesJson(JSON.stringify({ devices: [] }))).toEqual([]);
    expect(parseSimctlDevicesJson(JSON.stringify({ devices: { bad: {} } }))).toEqual([]);
  });
});
