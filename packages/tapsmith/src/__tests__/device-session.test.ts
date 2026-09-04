import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TapsmithConfig } from '../config.js';

// The shared device-session module (PILOT-310): one implementation of
// connect → select → install → agent → launch for every run path, and the
// group opener that runs it for each member of a `use.devices` project.

const mocks = vi.hoisted(() => ({
  devices: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  clients: [] as Array<{ waitForReady: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  clientReady: true,
  installed: true,
  preflight: {
    ensureSessionReady: vi.fn(async () => {}),
    launchConfiguredApp: vi.fn(async () => ({ policy: { mode: 'clear', scope: 'file' }, preparedAt: 1, durationMs: 1, source: 'startup launch' })),
    probeResetCapabilities: vi.fn(async (ctx: { capabilities?: Record<string, unknown> }) => { (ctx.capabilities ??= {}).hooksDetected = true; return ctx.capabilities; }),
  },
  agentFailures: 0,
  /** Serials whose agent never starts (permanent failure). */
  failAgentFor: new Set<string>(),
}));

// No real backoff between agent-start attempts — the retry is what matters here.
vi.mock('../worker-protocol.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker-protocol.js')>()),
  AGENT_START_RETRY_DELAY_MS: 0,
}));

vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: vi.fn().mockImplementation(() => {
    const client = { waitForReady: vi.fn(async () => mocks.clientReady), close: vi.fn() };
    mocks.clients.push(client);
    return client;
  }),
}));

vi.mock('../device.js', () => ({
  Device: vi.fn().mockImplementation(() => {
    let serial = '';
    const device: Record<string, ReturnType<typeof vi.fn>> = {
      listDevices: vi.fn(async () => ({ devices: [] })),
      setDevice: vi.fn(async (s: string) => { serial = s; }),
      wake: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
      installApk: vi.fn(async () => {}),
      startAgent: vi.fn(async () => {
        if (mocks.failAgentFor.has(serial)) throw new Error('Failed to connect to agent socket on port 18700');
        if (mocks.agentFailures > 0) {
          mocks.agentFailures--;
          throw new Error('Failed to connect to agent socket on port 18700');
        }
      }),
      waitForIdle: vi.fn(async () => {}),
      terminateApp: vi.fn(async () => {}),
      close: vi.fn(),
    };
    mocks.devices.push(device);
    return device;
  }),
}));

vi.mock('../emulator.js', () => ({
  isPackageInstalled: vi.fn(() => mocks.installed),
  installedApkMatches: vi.fn(() => true),
  waitForPackageIndexed: vi.fn(async () => {}),
}));

vi.mock('../ios-simulator.js', () => ({
  installApp: vi.fn(),
  installedAppMatches: vi.fn(() => true),
  isAppInstalled: vi.fn(() => true),
  probeSimulatorHealth: vi.fn(() => ({ healthy: true })),
  rebootSimulator: vi.fn(),
}));

vi.mock('../agent-resolve.js', () => ({
  findAgentApk: vi.fn(() => '/agents/agent.apk'),
  findAgentTestApk: vi.fn(() => '/agents/agent-test.apk'),
}));

vi.mock('../session-preflight.js', () => mocks.preflight);

const { openDeviceGroup, openDeviceSession, closeDeviceSession, recoverDeviceSessions } = await import('../device-session.js');

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000, retries: 0, screenshot: 'never', testMatch: [], daemonAddress: 'localhost:50051',
    rootDir: '/proj', outputDir: 'out', workers: 1, launchEmulators: false,
    platform: 'android', package: 'com.example.app', apk: './app.apk',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.devices.length = 0;
  mocks.clients.length = 0;
  mocks.clientReady = true;
  mocks.installed = true;
  mocks.agentFailures = 0;
  mocks.failAgentFor.clear();
  mocks.preflight.ensureSessionReady.mockClear();
  mocks.preflight.launchConfiguredApp.mockClear();
  mocks.preflight.probeResetCapabilities.mockClear();
});

describe('openDeviceSession', () => {
  it('connects, selects, wakes, skips a matching install, starts the agent and launches', async () => {
    const progress: string[] = [];
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { label: 'Worker 0', launchPhase: 'worker startup launch', onProgress: (m) => progress.push(m) },
    );

    expect(session.serial).toBe('emulator-5554');
    expect(session.config.device).toBe('emulator-5554');
    expect(session.config.daemonAddress).toBe('localhost:50052');
    const device = mocks.devices[0];
    expect(device.setDevice).toHaveBeenCalledWith('emulator-5554', false, [], []);
    expect(device.wake).toHaveBeenCalled();
    expect(device.installApk).not.toHaveBeenCalled();
    expect(device.startAgent).toHaveBeenCalledWith('com.example.app', '/agents/agent.apk', '/agents/agent-test.apk', undefined, undefined, false);
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(
      expect.objectContaining({ deviceSerial: 'emulator-5554' }),
      'worker startup launch',
      { freshInstall: false },
    );
    expect(session.prepared?.policy).toEqual({ mode: 'clear', scope: 'file' });
    expect(session.context.agentApkPath).toBe('/agents/agent.apk');
    expect(progress).toContain('agent connected');
    // A lone device records untagged events, as it always has.
    expect(device._traceDeviceId).toBeUndefined();
  });

  it('installs onto a device that lacks the app and vouches for the fresh install', async () => {
    mocks.installed = false;
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { label: 'Worker 0' },
    );
    expect(mocks.devices[0].installApk).toHaveBeenCalledWith('/proj/app.apk');
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledWith(expect.anything(), 'startup launch', { freshInstall: true });
  });

  it('retries a transient agent start once, then fails with the session label', async () => {
    mocks.agentFailures = 1;
    await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
      makeConfig(),
      { label: 'Worker 0' },
    );
    expect(mocks.devices[0].startAgent).toHaveBeenCalledTimes(2);

    mocks.agentFailures = 2;
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      makeConfig(),
      { label: 'Worker 1' },
    )).rejects.toThrow(/^Worker 1 \(emulator-5556\): Failed to connect to agent socket/);
    // A failed open leaves nothing behind.
    expect(mocks.devices.at(-1)!.close).toHaveBeenCalled();
    expect(mocks.clients.at(-1)!.close).toHaveBeenCalled();
  });

  it('adopts a daemon that already holds the device: no install, no agent start, seeded capabilities', async () => {
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50051' },
      makeConfig(),
      { label: 'Run', adopt: true, adoptVerify: false, seedCapabilities: { hooksDetected: true } },
    );
    const device = mocks.devices[0];
    expect(device.installApk).not.toHaveBeenCalled();
    expect(device.startAgent).not.toHaveBeenCalled();
    expect(mocks.preflight.ensureSessionReady).not.toHaveBeenCalled();
    // Already known: nothing to probe for.
    expect(mocks.preflight.probeResetCapabilities).not.toHaveBeenCalled();
    expect(session.capabilities).toEqual({ hooksDetected: true });
    // Recovery still knows the agent artifacts.
    expect(session.context.agentApkPath).toBe('/agents/agent.apk');
  });

  it('fails fast when the daemon does not answer', async () => {
    mocks.clientReady = false;
    await expect(openDeviceSession(
      { name: 'device-1', serial: 'emulator-5554', daemonAddress: 'localhost:50099' },
      makeConfig(),
      { label: 'Worker 0' },
    )).rejects.toThrow(/Worker 0 \(emulator-5554\): Failed to connect to daemon at localhost:50099/);
  });
});

describe('openDeviceGroup', () => {
  it('opens every member, tags their trace events, and shares one artifact resolution', async () => {
    const sessions = await openDeviceGroup(
      [
        { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053', freshDevice: true },
      ],
      makeConfig(),
      { label: 'Worker 0' },
    );
    expect(sessions.map((s) => [s.name, s.serial])).toEqual([['alice', 'emulator-5554'], ['bob', 'emulator-5556']]);
    expect(mocks.devices[0]._traceDeviceId).toBe('alice');
    expect(mocks.devices[1]._traceDeviceId).toBe('bob');
    // The fresh member is reinstalled and warmed up; the other is not.
    expect(mocks.devices[1].installApk).toHaveBeenCalled();
    expect(mocks.devices[1].terminateApp).toHaveBeenCalled();
    expect(mocks.devices[0].installApk).not.toHaveBeenCalled();
    // Each member ends up with its own capabilities object.
    expect(sessions[0].capabilities).not.toBe(sessions[1].capabilities);
  });

  it('is atomic: a member that fails closes the ones that opened', async () => {
    mocks.failAgentFor.add('emulator-5556');
    await expect(openDeviceGroup(
      [
        { name: 'alice', serial: 'emulator-5554', daemonAddress: 'localhost:50052' },
        { name: 'bob', serial: 'emulator-5556', daemonAddress: 'localhost:50053' },
      ],
      makeConfig(),
      { label: 'Worker 0' },
    )).rejects.toThrow(/Failed to connect to agent socket/);
    for (const device of mocks.devices) expect(device.close).toHaveBeenCalled();
  });

  it('prefixes progress with the member name for groups, not for single devices', async () => {
    const lines: string[] = [];
    await openDeviceGroup(
      [{ name: 'alice', serial: 'A', daemonAddress: 'localhost:1' }, { name: 'bob', serial: 'B', daemonAddress: 'localhost:2' }],
      makeConfig(),
      { label: 'Worker 0', onProgress: (m) => lines.push(m) },
    );
    expect(lines.some((l) => l.startsWith('[bob] '))).toBe(true);
    lines.length = 0;
    await openDeviceGroup(
      [{ name: 'device-1', serial: 'A', daemonAddress: 'localhost:1' }],
      makeConfig(),
      { label: 'Worker 0', onProgress: (m) => lines.push(m) },
    );
    expect(lines.every((l) => !l.startsWith('['))).toBe(true);
  });
});

describe('recovery and teardown', () => {
  it('relaunches every session and records the relaunch as prepared state', async () => {
    const sessions = await openDeviceGroup(
      [{ name: 'alice', serial: 'A', daemonAddress: 'localhost:1' }, { name: 'bob', serial: 'B', daemonAddress: 'localhost:2' }],
      makeConfig(),
      { label: 'Worker 0' },
    );
    for (const s of sessions) s.prepared = undefined;
    mocks.preflight.launchConfiguredApp.mockClear();
    await recoverDeviceSessions(sessions, 'recovery for chat.test.ts');
    expect(mocks.preflight.launchConfiguredApp).toHaveBeenCalledTimes(2);
    expect(sessions.every((s) => s.prepared?.source === 'startup launch')).toBe(true);
  });

  it('closes the device, the client and an owned daemon', async () => {
    const daemon = { kill: vi.fn() };
    const session = await openDeviceSession(
      { name: 'device-1', serial: 'A', daemonAddress: 'localhost:1' },
      makeConfig({ platform: 'ios', apk: undefined }),
      { label: 'Worker 0', daemonProcess: daemon as never },
    );
    closeDeviceSession(session);
    closeDeviceSession(session);
    expect(mocks.devices[0].close).toHaveBeenCalled();
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(daemon.kill).toHaveBeenCalledTimes(1);
  });
});
