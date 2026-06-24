import { describe, it, expect } from 'vitest';
import { parseAdbDevicesOutput, parseSimctlDevicesJson } from '../env-scan.js';

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
