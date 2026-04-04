import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

vi.mock('node:child_process');
vi.mock('node:fs');
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, tmpdir: vi.fn(() => '/tmp') };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFileSync signatures make proper mock typing impractical
const mockedExecFileSync = vi.mocked(childProcess.execFileSync) as any;
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedWriteFileSync = vi.mocked(fs.writeFileSync);

// Import after mocks are set up
import {
  listSimulators,
  listBootedSimulators,
  listCompatibleBootedSimulators,
  bootSimulator,
  shutdownSimulator,
  installApp,
  isAppInstalled,
  findSimulator,
  provisionSimulator,
  createSimulator,
  cloneSimulator,
  deleteSimulator,
  probeSimulatorHealth,
  filterHealthySimulators,
  cleanupStaleSimulators,
  recordClonedSimulators,
  unrecordSimulators,
  provisionSimulators,
} from '../ios-simulator.js';
import type { SimulatorInfo } from '../ios-simulator.js';

// ─── Fixtures ───

function makeSim(overrides: Partial<SimulatorInfo> = {}): SimulatorInfo {
  return {
    udid: 'AAAA-1111',
    name: 'iPhone 16',
    state: 'Booted',
    isAvailable: true,
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    ...overrides,
  };
}

function makeSimctlOutput(sims: Array<Partial<SimulatorInfo & { deviceTypeIdentifier?: string }>>): string {
  const devices: Record<string, unknown[]> = {};
  for (const s of sims) {
    const runtime = s.runtime ?? 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
    if (!devices[runtime]) devices[runtime] = [];
    devices[runtime].push({
      udid: s.udid ?? 'AAAA-1111',
      name: s.name ?? 'iPhone 16',
      state: s.state ?? 'Booted',
      isAvailable: s.isAvailable ?? true,
      deviceTypeIdentifier: s.deviceTypeIdentifier ?? s.deviceType ?? '',
    });
  }
  return JSON.stringify({ devices });
}

function mockListSimulators(sims: Array<Partial<SimulatorInfo>>): void {
  mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'xcrun' && args?.[0] === 'simctl' && args?.[1] === 'list') {
      return makeSimctlOutput(sims);
    }
    return '';
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: manifest doesn't exist
  mockedReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
});

// ─── listSimulators ───

describe('listSimulators', () => {
  it('parses simctl JSON output', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16', state: 'Booted' },
      { udid: 'B', name: 'iPhone 16 Pro', state: 'Shutdown' },
    ]);

    const result = listSimulators();
    expect(result).toHaveLength(2);
    expect(result[0].udid).toBe('A');
    expect(result[1].state).toBe('Shutdown');
  });

  it('filters out unavailable simulators', () => {
    mockListSimulators([
      { udid: 'A', isAvailable: true },
      { udid: 'B', isAvailable: false },
    ]);

    const result = listSimulators();
    expect(result).toHaveLength(1);
    expect(result[0].udid).toBe('A');
  });

  it('returns empty array on simctl failure', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('simctl not found'); });
    expect(listSimulators()).toEqual([]);
  });

  it('returns empty array on malformed JSON', () => {
    mockedExecFileSync.mockReturnValue('not json' as unknown as Buffer);
    expect(listSimulators()).toEqual([]);
  });
});

// ─── listBootedSimulators ───

describe('listBootedSimulators', () => {
  it('returns only booted simulators', () => {
    mockListSimulators([
      { udid: 'A', state: 'Booted' },
      { udid: 'B', state: 'Shutdown' },
      { udid: 'C', state: 'Booted' },
    ]);

    const result = listBootedSimulators();
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.udid)).toEqual(['A', 'C']);
  });
});

// ─── listCompatibleBootedSimulators ───

describe('listCompatibleBootedSimulators', () => {
  it('filters by runtime of the primary simulator', () => {
    mockListSimulators([
      { udid: 'A', state: 'Booted', runtime: 'iOS-26-4' },
      { udid: 'B', state: 'Booted', runtime: 'iOS-26-1' },
      { udid: 'C', state: 'Booted', runtime: 'iOS-26-4' },
    ]);

    const result = listCompatibleBootedSimulators('A');
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.udid)).toEqual(['A', 'C']);
  });

  it('returns empty when primary not found', () => {
    mockListSimulators([
      { udid: 'A', state: 'Booted' },
    ]);

    expect(listCompatibleBootedSimulators('MISSING')).toEqual([]);
  });
});

// ─── bootSimulator ───

describe('bootSimulator', () => {
  it('calls simctl boot', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    bootSimulator('AAAA');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'xcrun', ['simctl', 'boot', 'AAAA'],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it('ignores already-booted error', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Unable to boot device in current state: Booted'), {
        stderr: Buffer.from(''),
      });
    });
    expect(() => bootSimulator('AAAA')).not.toThrow();
  });

  it('throws on real boot errors', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Device not found'), { stderr: Buffer.from('') });
    });
    expect(() => bootSimulator('AAAA')).toThrow('Device not found');
  });
});

// ─── installApp / isAppInstalled ───

describe('installApp', () => {
  it('calls simctl install', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    installApp('AAAA', '/path/to/App.app');
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'xcrun', ['simctl', 'install', 'AAAA', '/path/to/App.app'],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });
});

describe('isAppInstalled', () => {
  it('returns true when get_app_container succeeds', () => {
    mockedExecFileSync.mockReturnValue('' as unknown as Buffer);
    expect(isAppInstalled('AAAA', 'com.example')).toBe(true);
  });

  it('returns false when get_app_container fails', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('not installed'); });
    expect(isAppInstalled('AAAA', 'com.example')).toBe(false);
  });
});

// ─── findSimulator ───

describe('findSimulator', () => {
  it('finds by exact UDID', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16' },
      { udid: 'B', name: 'iPhone 16 Pro' },
    ]);

    expect(findSimulator('B')?.name).toBe('iPhone 16 Pro');
  });

  it('finds by name, preferring booted', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16', state: 'Shutdown' },
      { udid: 'B', name: 'iPhone 16', state: 'Booted' },
    ]);

    expect(findSimulator('iPhone 16')?.udid).toBe('B');
  });

  it('returns first match when none are booted', () => {
    mockListSimulators([
      { udid: 'A', name: 'iPhone 16', state: 'Shutdown' },
      { udid: 'B', name: 'iPhone 16', state: 'Shutdown' },
    ]);

    expect(findSimulator('iPhone 16')?.udid).toBe('A');
  });

  it('returns undefined when no match', () => {
    mockListSimulators([]);
    expect(findSimulator('iPhone 99')).toBeUndefined();
  });
});

// ─── provisionSimulator ───

describe('provisionSimulator', () => {
  it('boots a shutdown simulator and installs app', () => {
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      calls.push([cmd as string, ...a]);
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([{ udid: 'A', name: 'iPhone 16', state: 'Shutdown' }]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    const udid = provisionSimulator('iPhone 16', '/app.app');
    expect(udid).toBe('A');
    expect(calls.some((c) => c.includes('boot'))).toBe(true);
    expect(calls.some((c) => c.includes('install'))).toBe(true);
  });

  it('throws when no simulator matches', () => {
    mockListSimulators([]);
    expect(() => provisionSimulator('iPhone 99')).toThrow(/No iOS simulator found/);
  });
});

// ─── createSimulator / cloneSimulator / deleteSimulator ───

describe('createSimulator', () => {
  it('returns the new UDID', () => {
    mockedExecFileSync.mockReturnValue('NEW-UDID\n' as unknown as Buffer);
    expect(createSimulator('Test', 'type', 'runtime')).toBe('NEW-UDID');
  });
});

describe('cloneSimulator', () => {
  it('returns the cloned UDID', () => {
    mockedExecFileSync.mockReturnValue('CLONE-UDID\n' as unknown as Buffer);
    expect(cloneSimulator('SOURCE', 'Clone Name')).toBe('CLONE-UDID');
  });
});

describe('deleteSimulator', () => {
  it('shuts down then deletes', () => {
    const calls: string[][] = [];
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd as string, ...(args as string[])]);
      return '' as unknown as Buffer;
    });

    deleteSimulator('AAAA');
    const ops = calls.filter((c) => c[0] === 'xcrun').map((c) => c[2]);
    expect(ops).toEqual(['shutdown', 'delete']);
  });

  it('does not throw on failure', () => {
    mockedExecFileSync.mockImplementation(() => { throw new Error('fail'); });
    expect(() => deleteSimulator('AAAA')).not.toThrow();
  });
});

// ─── probeSimulatorHealth ───

describe('probeSimulatorHealth', () => {
  it('returns healthy for booted sim with responsive launchd', () => {
    mockListSimulators([{ udid: 'A', state: 'Booted' }]);
    // Allow launchctl to succeed
    const origImpl = mockedExecFileSync.getMockImplementation()!;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'xcrun' && (args as string[])?.[1] === 'spawn') {
        return '' as unknown as Buffer;
      }
      return origImpl(cmd, args, opts);
    });

    expect(probeSimulatorHealth('A')).toEqual({ udid: 'A', healthy: true });
  });

  it('returns unhealthy when sim does not exist', () => {
    mockListSimulators([]);
    const result = probeSimulatorHealth('MISSING');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('no longer exists');
  });

  it('returns unhealthy when sim is shutdown', () => {
    mockListSimulators([{ udid: 'A', state: 'Shutdown' }]);
    const result = probeSimulatorHealth('A');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('Shutdown');
  });
});

// ─── filterHealthySimulators ───

describe('filterHealthySimulators', () => {
  it('separates healthy from unhealthy', () => {
    const origImpl = mockedExecFileSync.getMockImplementation();
    mockedExecFileSync.mockImplementation((cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'xcrun' && (args as string[])?.[0] === 'simctl' && (args as string[])?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', state: 'Booted' },
          { udid: 'B', state: 'Shutdown' },
        ]) as unknown as Buffer;
      }
      // Let launchctl succeed for Booted sim
      return '' as unknown as Buffer;
    });

    const result = filterHealthySimulators(['A', 'B']);
    expect(result.healthyUdids).toEqual(['A']);
    expect(result.unhealthySimulators).toHaveLength(1);
    expect(result.unhealthySimulators[0].udid).toBe('B');
  });
});

// ─── Manifest ───

describe('simulator manifest', () => {
  it('recordClonedSimulators writes entries to manifest', () => {
    mockedReadFileSync.mockReturnValue('[]');
    recordClonedSimulators(
      [{ udid: 'X', name: 'Clone 1', cloned: true }],
      'iPhone 16',
    );
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].udid).toBe('X');
    expect(written[0].sourceName).toBe('iPhone 16');
  });

  it('recordClonedSimulators skips duplicate UDIDs', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'X', name: 'Clone 1', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));
    recordClonedSimulators(
      [{ udid: 'X', name: 'Clone 1', cloned: true }],
      'iPhone 16',
    );
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1); // not duplicated
  });

  it('unrecordSimulators removes entries by UDID', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'A', name: 'C1', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
      { udid: 'B', name: 'C2', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));
    unrecordSimulators(['A']);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].udid).toBe('B');
  });

  it('handles missing manifest gracefully', () => {
    mockedReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    recordClonedSimulators(
      [{ udid: 'X', name: 'Clone', cloned: true }],
      'iPhone 16',
    );
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
  });
});

// ─── cleanupStaleSimulators ───

describe('cleanupStaleSimulators', () => {
  it('deletes unhealthy manifest entries and keeps healthy ones', () => {
    // Manifest has two entries: A (healthy, booted) and B (doesn't exist)
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'A', name: 'C1', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
      { udid: 'B', name: 'C2', sourceName: 'iPhone 16', createdAt: '2026-01-01' },
    ]));

    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', state: 'Booted', name: 'C1' },
          // B intentionally missing — simulates deleted sim
        ]) as unknown as Buffer;
      }
      // launchctl check succeeds
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.reusable).toEqual(['A']);
    expect(result.killed).toContain('B');
  });

  it('deletes orphaned Pilot Worker sims not in manifest', () => {
    mockedReadFileSync.mockReturnValue('[]');
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'ORPHAN', name: 'iPhone 16 (Pilot Worker 1)', state: 'Booted' },
        ]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.killed).toContain('ORPHAN');
  });

  it('skips manifest entries for different simulator names', () => {
    mockedReadFileSync.mockReturnValue(JSON.stringify([
      { udid: 'OTHER', name: 'C1', sourceName: 'iPad Pro', createdAt: '2026-01-01' },
    ]));

    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });

    const result = cleanupStaleSimulators('iPhone 16');
    expect(result.reusable).toEqual([]);
    expect(result.killed).toEqual([]);
    // Manifest should still contain the iPad Pro entry
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
    expect(written[0].sourceName).toBe('iPad Pro');
  });
});

// ─── provisionSimulators (multi-worker) ───

describe('provisionSimulators', () => {
  it('returns existing UDIDs when workers already satisfied', () => {
    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['A', 'B'],
    });
    expect(result.allUdids).toEqual(['A', 'B']);
    expect(result.clonedSimulators).toEqual([]);
  });

  it('reuses healthy clones from previous runs', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted' },
          { udid: 'REUSE', name: 'iPhone 16 (Pilot Worker 1)', state: 'Booted' },
        ]) as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    // Manifest has the reusable clone
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['PRIMARY'],
      reusableUdids: ['REUSE'],
    });

    expect(result.allUdids).toContain('PRIMARY');
    expect(result.allUdids).toContain('REUSE');
  });

  it('boots shutdown simulators when not enough booted', () => {
    let bootCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', name: 'iPhone 16', state: 'Booted' },
          { udid: 'B', name: 'iPhone 16', state: 'Shutdown' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'boot') {
        bootCalled = true;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['A'],
    });

    expect(result.allUdids).toHaveLength(2);
    expect(bootCalled).toBe(true);
    expect(result.freshUdids.has('B')).toBe(true);
  });

  it('creates new simulator when only matching sim is in existingUdids', () => {
    let createCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', name: 'iPhone 16', state: 'Booted', deviceType: 'com.apple.iPhone-16' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'create') {
        createCalled = true;
        return 'NEW-UDID\n' as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['A'],
    });

    expect(createCalled).toBe(true);
    expect(result.clonedSimulators).toHaveLength(1);
    expect(result.clonedSimulators[0].udid).toBe('NEW-UDID');
    expect(result.allUdids).toEqual(['A', 'NEW-UDID']);
  });

  it('clones from shutdown source when available', () => {
    let cloneCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'A', name: 'iPhone 16', state: 'Booted' },
          { udid: 'B', name: 'iPhone 16', state: 'Shutdown' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'clone') {
        cloneCalled = true;
        return 'CLONED-UDID\n' as unknown as Buffer;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    // A and B are already assigned; need a 3rd worker
    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 3,
      existingUdids: ['A'],
    });

    expect(cloneCalled).toBe(true);
    expect(result.clonedSimulators.length).toBeGreaterThan(0);
  });

  it('skips reusable clones with mismatched runtime', () => {
    let deleteCalled = false;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      const a = args as string[];
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'list') {
        return makeSimctlOutput([
          { udid: 'PRIMARY', name: 'iPhone 16', state: 'Booted', runtime: 'iOS-26-4' },
          { udid: 'STALE', name: 'iPhone 16 (Pilot Worker 1)', state: 'Booted', runtime: 'iOS-26-1' },
        ]) as unknown as Buffer;
      }
      if (cmd === 'xcrun' && a?.[0] === 'simctl' && a?.[1] === 'delete') {
        deleteCalled = true;
      }
      return '' as unknown as Buffer;
    });
    mockedReadFileSync.mockReturnValue('[]');

    const result = provisionSimulators({
      simulatorName: 'iPhone 16',
      workers: 2,
      existingUdids: ['PRIMARY'],
      reusableUdids: ['STALE'],
    });

    expect(deleteCalled).toBe(true);
    expect(result.allUdids).not.toContain('STALE');
  });
});
