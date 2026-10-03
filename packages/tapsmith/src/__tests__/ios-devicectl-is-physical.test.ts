import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

vi.mock('node:child_process');
vi.mock('node:fs');

import { isPhysicalDevice } from '../ios-devicectl.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFileSync signatures make proper mock typing impractical
const mockedExecFileSync = vi.mocked(childProcess.execFileSync) as any;
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

/** A `devicectl list devices` JSON payload listing one cabled iPhone. */
function devicectlListing(udid: string): string {
  return JSON.stringify({
    result: {
      devices: [{
        hardwareProperties: { platform: 'iOS', udid, reality: 'physical' },
        deviceProperties: { name: 'iPhone' },
        connectionProperties: { transportType: 'wired', tunnelState: 'connected', pairingState: 'paired' },
      }],
    },
  });
}

describe('isPhysicalDevice (PILOT-496)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('answers a simulator UDID without asking devicectl', () => {
    // Every simulator session asks this several times during setup; on a
    // hosted macOS runner each devicectl call ran into its 15 s timeout while
    // the fresh simulator kept CoreSimulator busy.
    expect(isPhysicalDevice('7D16E67F-1E34-43CB-BD36-B95CCE24981A')).toBe(false);
    expect(isPhysicalDevice('7d16e67f-1e34-43cb-bd36-b95cce24981a')).toBe(false);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('still asks devicectl for a hardware UDID, and finds the connected iPhone', () => {
    const udid = '00008140-000A1B2C3D4E001C';
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(devicectlListing(udid));
    expect(isPhysicalDevice(udid)).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['devicectl', 'list', 'devices']),
      expect.anything(),
    );
  });

  it('asks devicectl for a legacy 40-hex UDID', () => {
    const udid = 'a'.repeat(40);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(devicectlListing(udid));
    expect(isPhysicalDevice(udid)).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('is false for an empty serial without asking devicectl', () => {
    expect(isPhysicalDevice('')).toBe(false);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
