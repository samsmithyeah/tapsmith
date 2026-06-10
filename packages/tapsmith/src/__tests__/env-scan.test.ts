import { describe, it, expect } from 'vitest';
import { parseAdbDevicesOutput } from '../env-scan.js';

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
