import { describe, it, expect } from 'vitest';
import {
  assignGroupMemberDevices,
  defineConfig,
  deviceGroupSize,
  effectiveConfigForProject,
  resolveDeviceGroup,
  validateDevicesOption,
  type TapsmithConfig,
} from '../config.js';
import { deviceSignature, resolveProjects } from '../project.js';

// `use.devices` (PILOT-310): a project whose tests drive several devices at
// once. The declaration is validated at load time and normalised into named
// members everywhere else, so a typo cannot provision a wrong-sized group and
// no embedder has to know both spellings.

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return defineConfig({ platform: 'android', avd: 'Pixel_6', package: 'com.x', ...overrides });
}

describe('validateDevicesOption', () => {
  it('accepts a positive count or a named list', () => {
    expect(() => validateDevicesOption({ devices: 2 })).not.toThrow();
    expect(() => validateDevicesOption({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] })).not.toThrow();
    expect(() => validateDevicesOption({})).not.toThrow();
  });

  it('rejects counts that cannot be a group', () => {
    expect(() => validateDevicesOption({ devices: 0 })).toThrow(/positive integer/);
    expect(() => validateDevicesOption({ devices: 1.5 })).toThrow(/positive integer/);
    expect(() => validateDevicesOption({ devices: [] })).toThrow(/non-empty array/);
  });

  it('rejects malformed, duplicate or unsafe member names', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed input on purpose
    expect(() => validateDevicesOption({ devices: [{ name: '' }] as any })).toThrow(/devices\[0\] must be an object with a non-empty string `name`/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed input on purpose
    expect(() => validateDevicesOption({ devices: ['alice'] as any })).toThrow(/devices\[0\]/);
    expect(() => validateDevicesOption({ devices: [{ name: 'alice' }, { name: 'alice' }] })).toThrow(/names must be unique/);
    // Names become file-name suffixes and trace ids.
    expect(() => validateDevicesOption({ devices: [{ name: 'a/b' }] })).toThrow(/may only contain/);
  });

  it('rejects two members pinned to one device', () => {
    expect(() => validateDevicesOption({
      devices: [{ name: 'alice', device: 'emulator-5554' }, { name: 'bob', device: 'emulator-5554' }],
    })).toThrow(/pinned by another entry/);
    expect(() => validateDevicesOption({ devices: [{ name: 'alice', device: '' }] })).toThrow(/non-empty serial/);
  });

  it('names the source of the failure', () => {
    expect(() => validateDevicesOption({ devices: 0 }, 'test.use()')).toThrow(/^test\.use\(\):/);
    expect(() => defineConfig({ devices: 0 })).toThrow(/^config: devices/);
  });

  it('is applied to a project `use` block too', () => {
    const root = makeConfig();
    expect(() => effectiveConfigForProject(root, { use: { devices: 0 } })).toThrow(/devices must be a positive integer/);
    expect(() => resolveProjects(makeConfig({
      projects: [{ name: 'chat', use: { devices: [{ name: 'a' }, { name: 'a' }] } }],
    }))).toThrow(/names must be unique/);
  });
});

describe('resolveDeviceGroup / deviceGroupSize', () => {
  it('treats a config without `devices` as a group of one', () => {
    const config = makeConfig();
    expect(deviceGroupSize(config)).toBe(1);
    expect(resolveDeviceGroup(config)).toEqual([{ name: 'device-1' }]);
  });

  it('names a counted group device-1 … device-N', () => {
    const config = makeConfig({ devices: 3 });
    expect(deviceGroupSize(config)).toBe(3);
    expect(resolveDeviceGroup(config).map((e) => e.name)).toEqual(['device-1', 'device-2', 'device-3']);
  });

  it('keeps named members and their pins in declaration order', () => {
    const config = makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] });
    expect(deviceGroupSize(config)).toBe(2);
    expect(resolveDeviceGroup(config)).toEqual([{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }]);
  });

  it('lets `config.device` pin the primary when the first member leaves it open', () => {
    // `--device <serial>` keeps meaning "run the primary on this device".
    expect(resolveDeviceGroup(makeConfig({ device: 'emulator-5554', devices: 2 }))[0])
      .toEqual({ name: 'device-1', device: 'emulator-5554' });
    expect(resolveDeviceGroup(makeConfig({ device: 'emulator-5554' }))[0])
      .toEqual({ name: 'device-1', device: 'emulator-5554' });
    // An explicit pin on the first member wins over `config.device`.
    expect(resolveDeviceGroup(makeConfig({ device: 'emulator-5554', devices: [{ name: 'alice', device: 'X' }] }))[0])
      .toEqual({ name: 'alice', device: 'X' });
  });
});

describe('assignGroupMemberDevices', () => {
  // Every embedder (sequential CLI, parallel dispatcher, per-bucket
  // provisioning) turns a provisioned device list into a group through this
  // one function; two of them used to drop the unpinned members of a
  // partially pinned group.
  const mixed = [{ name: 'alice' }, { name: 'bob', device: 'X' }, { name: 'carol' }];

  it('keeps pins and fills the unpinned members from the pool in declaration order', () => {
    expect(assignGroupMemberDevices(mixed, 'P', ['P', 'X', 'A', 'B'])).toEqual(['X', 'A']);
    // The pool need not contain the pinned device (a serial adb has not listed yet).
    expect(assignGroupMemberDevices(mixed, 'P', ['P', 'A'])).toEqual(['X', 'A']);
  });

  it('never hands out the primary or a pinned device as a free one', () => {
    expect(assignGroupMemberDevices(mixed, 'P', ['X', 'P', 'A'])).toEqual(['X', 'A']);
    expect(assignGroupMemberDevices([{ name: 'a' }, { name: 'b' }, { name: 'c', device: 'Z' }], 'P', ['P', 'Z', 'Q']))
      .toEqual(['Q', 'Z']);
  });

  it('is undefined when the pool cannot fill every unpinned member', () => {
    expect(assignGroupMemberDevices(mixed, 'P', ['P', 'X'])).toBeUndefined();
    expect(assignGroupMemberDevices(mixed, 'P', [])).toBeUndefined();
  });

  it('needs no pool for a fully pinned group and none for a group of one', () => {
    expect(assignGroupMemberDevices([{ name: 'a', device: 'P' }, { name: 'b', device: 'X' }], 'P', [])).toEqual(['X']);
    expect(assignGroupMemberDevices([{ name: 'a' }], 'P', [])).toEqual([]);
    expect(assignGroupMemberDevices([{ name: 'a' }, { name: 'b' }], undefined, ['Q'])).toEqual(['Q']);
  });
});

describe('deviceSignature with device groups', () => {
  it('keeps single-device signatures unchanged', () => {
    const plain = deviceSignature(makeConfig());
    expect(plain).not.toContain('devices=');
    expect(deviceSignature(makeConfig({ devices: 1 }))).toBe(plain);
  });

  it('separates a group project from a single-device project on the same device shape', () => {
    // A worker is a device group: the two cannot share a worker pool.
    const single = deviceSignature(makeConfig());
    const pair = deviceSignature(makeConfig({ devices: 2 }));
    expect(pair).not.toBe(single);
    expect(pair).toContain('devices=device-1,device-2');
  });

  it('includes member names and pins, so differently pinned groups get their own buckets', () => {
    const a = deviceSignature(makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5556' }] }));
    const b = deviceSignature(makeConfig({ devices: [{ name: 'alice' }, { name: 'bob', device: 'emulator-5558' }] }));
    expect(a).toContain('bob@emulator-5556');
    expect(a).not.toBe(b);
  });

  it('is carried onto resolved projects', () => {
    const projects = resolveProjects(makeConfig({
      projects: [
        { name: 'solo', testMatch: ['**/solo/**'] },
        { name: 'chat', testMatch: ['**/chat/**'], use: { devices: 2 } },
      ],
    }));
    expect(projects[0].deviceSignature).not.toBe(projects[1].deviceSignature);
    expect(deviceGroupSize(projects[1].effectiveConfig)).toBe(2);
  });
});
