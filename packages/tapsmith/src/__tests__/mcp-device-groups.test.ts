import { describe, it, expect, vi } from 'vitest';
import type { TestDispatcher, SessionInfo } from '../mcp/test-dispatcher.js';

// A `use.devices` project in an MCP session (PILOT-310): the dispatcher holds
// one target per group (not per platform), device tools take a member's name
// in place of a serial, and the run child is handed every member.

const hoisted = vi.hoisted(() => ({
  requests: [] as Array<{ device?: string; project?: { name: string; platform?: string } }>,
  /** Serials the mocked pool knows; a `device` outside it fails the way the real pool does. */
  known: undefined as string[] | undefined,
}));

vi.mock('../mcp/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp/connection.js')>()),
  resolveDeviceTarget: async (request?: { device?: string; project?: { name: string; platform?: string } }) => {
    hoisted.requests.push(request ?? {});
    if (hoisted.known && request?.device && !hoisted.known.includes(request.device)) {
      throw new Error(`Device "${request.device}" not found in any connected daemon. Available devices: ${hoisted.known.join(', ')}`);
    }
    return { client: {} as never, device: request?.device };
  },
}));

const { deviceClientFor } = await import('../mcp/tools/device-target.js');
const { HeadlessTestDispatcher, platformKeyForProject } = await import('../mcp/headless-dispatcher.js');

function fakeDispatcher(names: Record<string, string>): TestDispatcher {
  return {
    ensureInitialized: async () => {},
    ensureDevicesReady: async () => {},
    resolveDeviceName: (name: string) => names[name],
    getSessionInfo: (): SessionInfo => ({
      timeout: 0,
      retries: 0,
      projects: [],
      deviceTargets: Object.entries(names).map(([name, device]) => ({ name, device, group: 'chat' })),
    }),
  } as unknown as TestDispatcher;
}

describe('device tools accept a group member name', () => {
  it('resolves a member name to its serial before targeting', async () => {
    hoisted.requests.length = 0;
    await deviceClientFor({ device: 'bob' }, fakeDispatcher({ alice: 'emulator-5554', bob: 'emulator-5556' }));
    expect(hoisted.requests).toEqual([{ device: 'emulator-5556', project: undefined }]);
  });

  it('passes a serial through untouched, and works without a dispatcher at all', async () => {
    hoisted.requests.length = 0;
    await deviceClientFor({ device: 'emulator-5554' }, fakeDispatcher({}));
    await deviceClientFor({ device: 'SIM-1' }, undefined);
    expect(hoisted.requests.map((r) => r.device)).toEqual(['emulator-5554', 'SIM-1']);
  });

  // The pool's own message lists serials, which is all it knows. A caller who
  // mistyped a member name needs the names the session would have accepted.
  it('lists the group names alongside the serials when `device` matches neither', async () => {
    hoisted.known = ['emulator-5554', 'emulator-5556'];
    try {
      await expect(deviceClientFor({ device: 'nobody' }, fakeDispatcher({ alice: 'emulator-5554', bob: 'emulator-5556' })))
        .rejects.toThrow(/Device "nobody" not found.*Available devices: emulator-5554, emulator-5556\. Group names: alice, bob$/s);
      // Nothing to add when the session declares no group.
      await expect(deviceClientFor({ device: 'nobody' }, fakeDispatcher({})))
        .rejects.toThrow(/Available devices: emulator-5554, emulator-5556$/);
    } finally {
      hoisted.known = undefined;
    }
  });
});

describe('group projects get their own target', () => {
  const projects = [
    { name: 'solo', effectiveConfig: { platform: 'android' as const } },
    { name: 'chat', effectiveConfig: { platform: 'android' as const, devices: [{ name: 'alice' }, { name: 'bob' }], package: 'com.x', rootDir: '/', outputDir: 'o', timeout: 1, retries: 0, screenshot: 'never' as const, testMatch: [], daemonAddress: 'x', workers: 1, launchEmulators: false } },
  ];

  it('keys a `use.devices` project separately from single-device projects on the same platform', () => {
    expect(platformKeyForProject(projects, 'solo', undefined)).toBe('android');
    const key = platformKeyForProject(projects, 'chat', undefined);
    expect(key.startsWith('android|')).toBe(true);
    expect(key).toContain('devices=alice,bob');
  });

  it('resolves member names from the session targets, primary included', () => {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _targets: Map<string, { address: string; deviceSerial: string; members?: Array<{ name: string; address: string; deviceSerial: string }> }>
      _projects: unknown[]
    };
    internals._projects = projects.map((p) => ({ ...p, testFiles: [], dependencies: [], testMatch: [], testIgnore: [], deviceSignature: '' }));
    internals._targets.set('android', { address: '127.0.0.1:50052', deviceSerial: 'EMU-1' });
    internals._targets.set(platformKeyForProject(projects, 'chat', undefined), {
      address: '127.0.0.1:50060',
      deviceSerial: 'EMU-2',
      members: [{ name: 'bob', address: '127.0.0.1:50061', deviceSerial: 'EMU-3' }],
    });

    expect(dispatcher.resolveDeviceName('alice')).toBe('EMU-2');
    expect(dispatcher.resolveDeviceName('bob')).toBe('EMU-3');
    expect(dispatcher.resolveDeviceName('carol')).toBeUndefined();

    const targets = dispatcher.getSessionInfo().deviceTargets ?? [];
    expect(targets).toEqual([
      { platform: 'android', device: 'EMU-1' },
      { platform: 'android', device: 'EMU-2', name: 'alice', group: 'chat' },
      { platform: 'android', device: 'EMU-3', name: 'bob', group: 'chat' },
    ]);
  });

  it('labels a group target with the root platform when the project sets none', () => {
    // A single-platform config keeps `platform` on the root; the group's
    // target key then carries no platform, and session_info used to print a
    // literal "Device (device) alice [pair]".
    const pair = { name: 'pair', effectiveConfig: { devices: [{ name: 'alice' }, { name: 'bob' }] } };
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _targets: Map<string, { address: string; deviceSerial: string; members?: Array<{ name: string; address: string; deviceSerial: string }> }>
      _projects: unknown[]
      _config: { platform?: string } | null
    };
    internals._projects = [{ ...pair, testFiles: [], dependencies: [], testMatch: [], testIgnore: [], deviceSignature: '' }];
    internals._config = { platform: 'android' };
    internals._targets.set(platformKeyForProject([pair], 'pair', undefined), {
      address: '127.0.0.1:50060',
      deviceSerial: 'EMU-2',
      members: [{ name: 'bob', address: '127.0.0.1:50061', deviceSerial: 'EMU-3' }],
    });

    expect(dispatcher.getSessionInfo().deviceTargets).toEqual([
      { platform: 'android', device: 'EMU-2', name: 'alice', group: 'pair' },
      { platform: 'android', device: 'EMU-3', name: 'bob', group: 'pair' },
    ]);
  });
});
