import { describe, it, expect } from 'vitest';
import {
  describeEmulatorAppNap,
  disableEmulatorAppNap,
  emulatorQemuNames,
  type EmulatorAppNapDeps,
  type EmulatorAppNapResult,
} from '../emulator-app-nap.js';

const SDK_EMULATOR = '/sdk/emulator/emulator';

/** A fake SDK install: directory listings by path. */
function fsDeps(tree: Record<string, string[]>, links: Record<string, string> = {}): Partial<EmulatorAppNapDeps> {
  return {
    readdir: (dir) => {
      const entries = tree[dir];
      if (!entries) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
      return entries;
    },
    realpath: (file) => links[file] ?? file,
    isFile: (file) => file in links || file === SDK_EMULATOR,
    env: { PATH: '/usr/bin:/opt/homebrew/bin' },
  };
}

const ARM_SDK = {
  '/sdk/emulator/qemu': ['darwin-aarch64'],
  '/sdk/emulator/qemu/darwin-aarch64': ['qemu-system-aarch64', 'qemu-system-aarch64-headless', 'lib64'],
};

/** A fake `defaults` store, recording every call. */
function fakeDefaults(initial: Record<string, string> = {}, opts: { failWrite?: string } = {}) {
  const store = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const defaults = (args: readonly string[]): string => {
    calls.push([...args]);
    const [verb, domain, key] = args;
    if (verb === 'read') {
      const value = store.get(`${domain}.${key}`);
      if (value === undefined) {
        throw Object.assign(new Error('Command failed'), { stderr: `The domain/default pair of (${domain}, ${key}) does not exist\n` });
      }
      return `${value}\n`;
    }
    if (opts.failWrite) throw Object.assign(new Error('Command failed'), { stderr: `${opts.failWrite}\n` });
    store.set(`${domain}.${key}`, '1');
    return '';
  };
  return { defaults, store, calls };
}

describe('emulatorQemuNames', () => {
  it('lists the windowed qemu binaries of the SDK install, not the headless ones', () => {
    expect(emulatorQemuNames(SDK_EMULATOR, fsDeps(ARM_SDK))).toEqual(['qemu-system-aarch64']);
  });

  it('follows an emulator found on PATH through its symlink into the SDK', () => {
    const deps = fsDeps(ARM_SDK, { '/opt/homebrew/bin/emulator': SDK_EMULATOR });
    expect(emulatorQemuNames('emulator', deps)).toEqual(['qemu-system-aarch64']);
  });

  it('falls back to both macOS qemu names when the install cannot be listed', () => {
    expect(emulatorQemuNames(SDK_EMULATOR, fsDeps({}))).toEqual(['qemu-system-aarch64', 'qemu-system-x86_64']);
    expect(emulatorQemuNames('emulator', fsDeps(ARM_SDK))).toEqual(['qemu-system-aarch64', 'qemu-system-x86_64']);
  });

  it('ignores host directories for other systems', () => {
    const tree = {
      '/sdk/emulator/qemu': ['linux-x86_64', 'darwin-x86_64'],
      '/sdk/emulator/qemu/darwin-x86_64': ['qemu-system-x86_64'],
      '/sdk/emulator/qemu/linux-x86_64': ['qemu-system-riscv64'],
    };
    expect(emulatorQemuNames(SDK_EMULATOR, fsDeps(tree))).toEqual(['qemu-system-x86_64']);
  });
});

describe('disableEmulatorAppNap', () => {
  it('writes NSAppSleepDisabled = YES to a qemu domain that does not set it, and reports the change', () => {
    const fake = fakeDefaults();
    const result = disableEmulatorAppNap(SDK_EMULATOR, { ...fsDeps(ARM_SDK), defaults: fake.defaults });
    expect(result).toEqual({ kind: 'disabled', domains: ['qemu-system-aarch64'], changed: ['qemu-system-aarch64'] });
    expect(fake.calls).toContainEqual(['write', 'qemu-system-aarch64', 'NSAppSleepDisabled', '-bool', 'YES']);
  });

  it('changes nothing when App Nap is already off, so a second run is silent', () => {
    const fake = fakeDefaults();
    const deps = { ...fsDeps(ARM_SDK), defaults: fake.defaults };
    disableEmulatorAppNap(SDK_EMULATOR, deps);
    fake.calls.length = 0;
    const again = disableEmulatorAppNap(SDK_EMULATOR, deps);
    expect(again).toEqual({ kind: 'disabled', domains: ['qemu-system-aarch64'], changed: [] });
    expect(fake.calls.filter(([verb]) => verb === 'write')).toEqual([]);
    expect(describeEmulatorAppNap(again)).toBeUndefined();
  });

  it.each(['0', 'NO', 'false'])('never overrides a user who set it to %s', (value) => {
    const fake = fakeDefaults({ 'qemu-system-aarch64.NSAppSleepDisabled': value });
    const result = disableEmulatorAppNap(SDK_EMULATOR, { ...fsDeps(ARM_SDK), defaults: fake.defaults });
    expect(result).toEqual({ kind: 'user-enabled', domains: ['qemu-system-aarch64'] });
    expect(fake.calls.filter(([verb]) => verb === 'write')).toEqual([]);
  });

  it('reports a failed write with the reason from defaults', () => {
    const fake = fakeDefaults({}, { failWrite: 'Could not write domain' });
    const result = disableEmulatorAppNap(SDK_EMULATOR, { ...fsDeps(ARM_SDK), defaults: fake.defaults });
    expect(result).toEqual({ kind: 'failed', domains: ['qemu-system-aarch64'], reason: 'Could not write domain' });
  });
});

describe('describeEmulatorAppNap', () => {
  it('announces a change with the command that undoes it', () => {
    const notice = describeEmulatorAppNap({ kind: 'disabled', domains: ['qemu-system-aarch64'], changed: ['qemu-system-aarch64'] });
    expect(notice?.level).toBe('info');
    expect(notice?.message).toContain('Turned off macOS App Nap for the Android emulator (qemu-system-aarch64)');
    expect(notice?.message).toContain('defaults delete qemu-system-aarch64 NSAppSleepDisabled');
  });

  it('warns, with the way out, when App Nap stays on', () => {
    const results: EmulatorAppNapResult[] = [
      { kind: 'user-enabled', domains: ['qemu-system-aarch64'] },
      { kind: 'failed', domains: ['qemu-system-aarch64'], reason: 'defaults: command not found' },
    ];
    for (const result of results) {
      const notice = describeEmulatorAppNap(result);
      expect(notice?.level).toBe('warning');
      expect(notice?.message).toContain('emulatorLaunchOptions: { headless: true }');
      expect(notice?.message).toContain('window is hidden or the display sleeps');
    }
  });
});
