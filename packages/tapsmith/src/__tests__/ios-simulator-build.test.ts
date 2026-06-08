import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { extractSdkVersion } from '../ios-device-resolve.js';

describe('extractSdkVersion()', () => {
  it('extracts SDK version from simulator xctestrun filename', () => {
    expect(extractSdkVersion(
      '/path/to/TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator18.5-arm64.xctestrun',
    )).toBe('18.5');
  });

  it('extracts SDK version from full path with nested dirs', () => {
    expect(extractSdkVersion(
      '/Users/sam/.tapsmith/ios-simulator-agent/TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun',
    )).toBe('26.0');
  });

  it('returns undefined for non-simulator xctestrun', () => {
    expect(extractSdkVersion(
      '/path/to/TapsmithAgentUITests_iphoneos26.4-arm64.xctestrun',
    )).toBeUndefined();
  });

  it('returns undefined for unrelated filenames', () => {
    expect(extractSdkVersion('/path/to/some-file.txt')).toBeUndefined();
  });
});

// ─── getInstalledSimulatorSdkVersion tests ──────────────────────────────

vi.mock('node:child_process');

const execFileSyncMock = vi.mocked(execFileSync);

describe('getInstalledSimulatorSdkVersion()', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
  });

  it('returns SDK version from xcrun', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    const { getInstalledSimulatorSdkVersion } = await import('../ios-simulator-build.js');
    expect(getInstalledSimulatorSdkVersion()).toBe('26.0');
  });

  it('returns undefined when xcrun fails', async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('xcrun not found'); });
    const { getInstalledSimulatorSdkVersion } = await import('../ios-simulator-build.js');
    expect(getInstalledSimulatorSdkVersion()).toBeUndefined();
  });
});
