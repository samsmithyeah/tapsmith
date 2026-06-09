import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ─── Mocks ──────────────────────────────────────────────────────────────

vi.mock('node:child_process');
vi.mock('node:fs');

const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mockResolve }),
}));

const { homedir } = vi.hoisted(() => ({
  homedir: vi.fn(() => '/Users/test'),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir };
});

const existsSync = vi.mocked(fs.existsSync);
const readdirSync = vi.mocked(fs.readdirSync);
const statSync = vi.mocked(fs.statSync);
const execFileSyncMock = vi.mocked(execFileSync);

// ─── extractSdkVersion (pure function, no mocks needed) ────────────────

// Static import is fine — extractSdkVersion does not touch fs/os/module.
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

describe('getInstalledSimulatorSdkVersion()', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
  });

  it('returns SDK version from xcrun', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileSyncMock.mockReturnValue('26.0\n');
    const { getInstalledSimulatorSdkVersion } = await import('../ios-device-resolve.js');
    expect(getInstalledSimulatorSdkVersion()).toBe('26.0');
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });

  it('returns undefined when xcrun fails', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    execFileSyncMock.mockImplementation(() => { throw new Error('xcrun not found'); });
    const { getInstalledSimulatorSdkVersion } = await import('../ios-device-resolve.js');
    expect(getInstalledSimulatorSdkVersion()).toBeUndefined();
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });

  it('returns undefined on non-darwin platforms', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { getInstalledSimulatorSdkVersion } = await import('../ios-device-resolve.js');
    expect(getInstalledSimulatorSdkVersion()).toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  });
});

// ─── findSimulatorXctestrun SDK-aware resolution ────────────────────────

describe('findSimulatorXctestrun() SDK-aware resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSync.mockReset();
    readdirSync.mockReset();
    statSync.mockReset();
    mockResolve.mockReset();
    execFileSyncMock.mockReset();
    homedir.mockReturnValue('/Users/test');
  });

  it('prefers exact SDK match from npm package subdirectory', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const sdk26Dir = '/node_modules/@tapsmith/agent-ios-simulator-arm64/sdk-26.0';
    const xctestrun26 = 'TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun';

    readdirSync.mockImplementation(((dir: string) => {
      const d = String(dir);
      if (d.endsWith('ios-simulator-agent')) throw new Error('ENOENT');
      if (d === '/node_modules/@tapsmith/agent-ios-simulator-arm64') return ['sdk-18.5', 'sdk-26.0'];
      if (d === sdk26Dir) return [xctestrun26];
      throw new Error('ENOENT');
    }// eslint-disable-next-line @typescript-eslint/no-explicit-any -- readdirSync overloads
) as any);
    existsSync.mockImplementation((p) => String(p) === sdk26Dir);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(sdk26Dir, xctestrun26));
  });

  it('falls back to flat layout for backward compat with old packages', async () => {
    execFileSyncMock.mockReturnValue('18.5\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const pkgDir = '/node_modules/@tapsmith/agent-ios-simulator-arm64';
    const xctestrun = 'TapsmithAgentUITests_iphonesimulator18.5-arm64.xctestrun';

    readdirSync.mockImplementation(((dir: string) => {
      const d = String(dir);
      if (d.endsWith('ios-simulator-agent')) throw new Error('ENOENT');
      if (d === pkgDir) return [xctestrun, 'Debug-iphonesimulator'];
      throw new Error('ENOENT');
    }// eslint-disable-next-line @typescript-eslint/no-explicit-any -- readdirSync overloads
) as any);
    existsSync.mockReturnValue(false);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(pkgDir, xctestrun));
  });
});
