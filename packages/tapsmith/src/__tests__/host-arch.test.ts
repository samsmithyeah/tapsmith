import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '1\n') }));
import { appleArch, hostArch, nodeUnderRosetta, rosettaNodeWarning } from '../host-arch.js';
import { defaultAbi } from '../avd-defaults.js';

const rosetta = { platform: 'darwin' as const, arch: 'x64', translated: () => true };
const intelMac = { platform: 'darwin' as const, arch: 'x64', translated: () => false };
const appleSiliconNative = { platform: 'darwin' as const, arch: 'arm64', translated: () => false };

describe('nodeUnderRosetta', () => {
  it('is true only for an x64 Node that sysctl says is translated', () => {
    expect(nodeUnderRosetta(rosetta)).toBe(true);
    expect(nodeUnderRosetta(intelMac)).toBe(false);
    expect(nodeUnderRosetta(appleSiliconNative)).toBe(false);
  });

  it('never asks sysctl for an arm64 Node or off macOS', () => {
    const translated = vi.fn(() => true);
    expect(nodeUnderRosetta({ platform: 'darwin', arch: 'arm64', translated })).toBe(false);
    expect(nodeUnderRosetta({ platform: 'linux', arch: 'x64', translated })).toBe(false);
    expect(translated).not.toHaveBeenCalled();
  });
});

describe('hostArch', () => {
  it('is arm64 under Rosetta and Node\'s own arch otherwise', () => {
    expect(hostArch(rosetta)).toBe('arm64');
    expect(hostArch(intelMac)).toBe('x64');
    expect(hostArch(appleSiliconNative)).toBe('arm64');
    expect(hostArch({ platform: 'linux', arch: 'x64' })).toBe('x64');
  });
});

describe('appleArch', () => {
  it('spells x64 as x86_64', () => {
    expect(appleArch('x64')).toBe('x86_64');
    expect(appleArch('arm64')).toBe('arm64');
  });
});

describe('defaultAbi', () => {
  it('picks the emulator image for the host arch, so Rosetta Node gets arm64-v8a', () => {
    expect(defaultAbi(hostArch(rosetta))).toBe('arm64-v8a');
    expect(defaultAbi(hostArch(intelMac))).toBe('x86_64');
  });
});

describe('rosettaNodeWarning', () => {
  it('says Node is translated and how to get an arm64 Node', () => {
    const warning = rosettaNodeWarning(rosetta);
    expect(warning).toMatch(/running under Rosetta \(x64\)/);
    expect(warning).toMatch(/Install an arm64 Node/);
    expect(warning).toMatch(/rm -rf node_modules && npm install/);
  });

  it('is undefined for a native Node', () => {
    expect(rosettaNodeWarning(intelMac)).toBeUndefined();
    expect(rosettaNodeWarning(appleSiliconNative)).toBeUndefined();
  });
});

describe('sysctl lookup', () => {
  it('asks /usr/sbin/sysctl by absolute path, so a PATH without /usr/sbin cannot hide Rosetta', () => {
    expect(nodeUnderRosetta({ platform: 'darwin', arch: 'x64' })).toBe(true);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], expect.anything());
  });
});
