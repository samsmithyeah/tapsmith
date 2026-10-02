import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDeviceRows, listDevicesFromDaemon, ListDevicesError, runListDevices, type ListDevicesDeps } from '../list-devices.js';
import type { DeviceInfoProto, TapsmithGrpcClient } from '../grpc-client.js';
import type { PhysicalDeviceInfo } from '../ios-devicectl.js';

const daemonDevice = (overrides: Partial<DeviceInfoProto>): DeviceInfoProto => ({
  serial: '',
  model: '',
  state: '',
  isEmulator: false,
  platform: '',
  osVersion: '',
  ...overrides,
});

const physicalDevice = (overrides: Partial<PhysicalDeviceInfo>): PhysicalDeviceInfo => ({
  udid: '',
  name: '',
  osVersion: '',
  isPaired: true,
  ddiServicesAvailable: true,
  bootState: 'booted',
  developerModeStatus: 'enabled',
  transportType: 'wired',
  isConnected: true,
  ...overrides,
});

describe('buildDeviceRows — platform labelling', () => {
  it('labels an iOS simulator as ios-sim', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM-UDID', model: 'iPhone 17 Pro', platform: 'ios', isEmulator: true, state: 'Booted' })],
      [],
    );
    expect(rows[0]!.platform).toBe('ios-sim');
  });

  it('labels a physical iPhone as ios-device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', model: "Sam's iPhone", platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.platform).toBe('ios-device');
  });

  it('labels Android emulators separately from real devices', () => {
    const rows = buildDeviceRows(
      [
        daemonDevice({ serial: 'HT123', platform: 'android', isEmulator: false, state: 'device' }),
        daemonDevice({ serial: 'emulator-5554', platform: 'android', isEmulator: true, state: 'device' }),
      ],
      [],
    );
    expect(rows[0]!.platform).toBe('android');
    expect(rows[1]!.platform).toBe('android-emu');
  });
});

describe('buildDeviceRows — readiness', () => {
  it('reports a USB-attached iOS physical device as ready', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(true);
    expect(rows[0]!.blockers).toEqual([]);
    expect(rows[0]!.osLabel).toBe('iOS 26.2.1');
  });

  it('flags an iOS physical device not attached via USB with an imperative fix', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', osVersion: '26.2.1' })],
      new Set(), // idevice_id -l empty → phone isn't cabled
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers).toContain('Plug in via USB cable');
  });

  it('distinguishes a Wi-Fi-only iOS device from a fully-disconnected one', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', transportType: 'localNetwork' })],
      new Set(), // not cabled, but devicectl still sees it
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.includes('Wi-Fi only'))).toBe(true);
  });

  it('flags an unpaired iOS physical device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', isPaired: false })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.startsWith('Pair in Xcode'))).toBe(true);
  });

  it('flags an iOS device with Developer Mode off', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', developerModeStatus: 'disabled' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.startsWith('Enable Developer Mode'))).toBe(true);
  });

  it('does not false-alarm on ddiServicesAvailable=false (devicectl reports it unreliably)', () => {
    // Real-world case: a plugged-in, paired, Developer-Mode-on iPhone
    // whose DDI hasn't been mounted by Xcode this session still works
    // fine for `tapsmith test` — tapsmith mounts the DDI itself. list-devices
    // must not flag this as "need attention".
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [physicalDevice({ udid: 'UDID', ddiServicesAvailable: false, osVersion: '26.2.1' })],
      new Set(['UDID']),
    );
    expect(rows[0]!.ready).toBe(true);
    expect(rows[0]!.blockers).toEqual([]);
  });

  it('iOS simulators are always ready (Tapsmith boots them on demand)', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM', platform: 'ios', isEmulator: true, state: 'Shutdown' })],
      [],
    );
    expect(rows[0]!.ready).toBe(true);
  });

  it('Android devices in `device` state are ready', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'device' })],
      [],
    );
    expect(rows[0]!.ready).toBe(true);
  });

  it('flags an unauthorized Android device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'unauthorized' })],
      [],
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.includes('USB debugging prompt'))).toBe(true);
  });

  it('treats the daemon\'s own states for a usable Android device as ready', () => {
    const rows = buildDeviceRows(
      [
        daemonDevice({ serial: 'emulator-5554', platform: 'android', isEmulator: true, state: 'Discovered' }),
        daemonDevice({ serial: 'HT123', platform: 'android', state: 'Active' }),
      ],
      [],
    );
    expect(rows.map((r) => r.ready)).toEqual([true, true]);
  });

  it('flags a no-permissions Android device with the udev fix, from its whole multi-word state', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: '0123ABCD', platform: 'android', state: 'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]' })],
      [],
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers).toEqual([expect.stringContaining('udev rule')]);
  });

  it('flags an offline emulator with the still-booting advice', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'emulator-5556', platform: 'android', isEmulator: true, state: 'offline' })],
      [],
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers).toEqual([expect.stringContaining('finish booting')]);
  });

  it.each(['authorizing', 'recovery', 'sideload', 'unknown'])(
    'never shows an Android device in adb state %s as ready, giving doctor\'s generic fix',
    (state) => {
      const rows = buildDeviceRows([daemonDevice({ serial: 'HT123', platform: 'android', state })], []);
      expect(rows[0]!.ready).toBe(false);
      expect(rows[0]!.blockers).toEqual([`HT123 is "${state}" to adb: reconnect it, or run \`adb kill-server\` and try again`]);
    },
  );

  it('flags an offline Android device', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'offline' })],
      [],
    );
    expect(rows[0]!.ready).toBe(false);
    expect(rows[0]!.blockers.some((b) => b.includes('Reconnect cable'))).toBe(true);
  });

  it('builds a human-friendly Android OS label from the daemon-provided version', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'HT123', platform: 'android', state: 'device', osVersion: '14' })],
      [],
    );
    expect(rows[0]!.osLabel).toBe('Android 14');
  });

  it('builds an iOS OS label for simulators from the daemon-provided runtime version', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'SIM', platform: 'ios', isEmulator: true, state: 'Booted', osVersion: '18.1' })],
      [],
    );
    expect(rows[0]!.osLabel).toBe('iOS 18.1');
  });

  it('treats iOS physical devices as ready when devicectl enrichment is missing (non-macOS host)', () => {
    const rows = buildDeviceRows(
      [daemonDevice({ serial: 'UDID', platform: 'ios', isEmulator: false })],
      [], // no devicectl data → we can't judge, assume ready
    );
    expect(rows[0]!.ready).toBe(true);
  });
});

describe('buildDeviceRows — sort order', () => {
  it('ready devices come before not-ready devices', () => {
    const rows = buildDeviceRows(
      [
        daemonDevice({ serial: 'BLOCKED', platform: 'ios', isEmulator: false }),
        daemonDevice({ serial: 'READY', platform: 'ios', isEmulator: true, state: 'Booted' }),
      ],
      [physicalDevice({ udid: 'BLOCKED', osVersion: '26.2.1' })],
      new Set(), // BLOCKED is not attached via USB
    );
    expect(rows.map((r) => r.serial)).toEqual(['READY', 'BLOCKED']);
  });
});

describe('buildDeviceRows — empty input', () => {
  it('returns empty when no devices are connected', () => {
    expect(buildDeviceRows([], [])).toEqual([]);
  });
});

// ─── --json contract (PILOT-270) ───

describe('runListDevices --json', () => {
  const capture = (deps: Partial<ListDevicesDeps>): { deps: ListDevicesDeps; out: () => string; err: () => string } => {
    let out = '';
    let err = '';
    return {
      deps: {
        fetchDevices: async () => [],
        enrich: () => ({ physical: [], usbAttached: new Set() }),
        stdout: (t) => { out += t; },
        stderr: (t) => { err += t; },
        ...deps,
      },
      out: () => out,
      err: () => err,
    };
  };

  it('prints { devices } with exactly the documented row keys', async () => {
    const h = capture({
      fetchDevices: async () => [daemonDevice({ serial: 'emulator-5554', model: 'Pixel 9', platform: 'android', isEmulator: true, state: 'device', osVersion: '15' })],
    });
    expect(await runListDevices({ json: true }, h.deps)).toBe(0);
    const parsed = JSON.parse(h.out()) as { devices: Array<Record<string, unknown>> };
    expect(Object.keys(parsed)).toEqual(['devices']);
    expect(parsed.devices).toEqual([{
      ready: true, platform: 'android-emu', serial: 'emulator-5554', name: 'Pixel 9', osLabel: 'Android 15', blockers: [],
    }]);
    expect(h.err()).toBe('');
  });

  it('lists an unauthorized phone as not ready, with the fix, instead of "No devices detected"', async () => {
    const h = capture({
      fetchDevices: async () => [daemonDevice({ serial: 'R5CR1234XYZ', platform: 'android', state: 'unauthorized' })],
    });
    expect(await runListDevices({ json: true }, h.deps)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ devices: [{
      ready: false, platform: 'android', serial: 'R5CR1234XYZ', name: '', osLabel: '', blockers: ['Accept the USB debugging prompt on the device'],
    }] });

    const text = capture({
      fetchDevices: async () => [daemonDevice({ serial: 'R5CR1234XYZ', platform: 'android', state: 'unauthorized' })],
    });
    expect(await runListDevices({ json: false }, text.deps)).toBe(0);
    const plain = text.out().replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).not.toContain('No devices detected');
    expect(plain).toContain('R5CR1234XYZ');
    expect(plain).toContain('Accept the USB debugging prompt on the device');
    expect(plain).toContain('0 ready · 1 need attention');
  });

  it.each([
    ['DAEMON_NOT_FOUND'],
    ['DAEMON_START_FAILED'],
    ['LIST_DEVICES_FAILED'],
  ])('reports a %s failure as the shared error envelope, exit 1', async (code) => {
    const h = capture({ fetchDevices: async () => { throw new ListDevicesError(code, 'it broke', 'do this'); } });
    expect(await runListDevices({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toEqual({ error: { code, message: 'it broke', fix: 'do this' } });
    expect(h.err()).toBe('');
  });

  it('reports anything else as UNEXPECTED_ERROR', async () => {
    const h = capture({ fetchDevices: async () => { throw new Error('boom'); } });
    expect(await runListDevices({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toEqual({
      error: { code: 'UNEXPECTED_ERROR', message: 'list-devices could not finish: boom', fix: 'To see the full error, run the same command again without --json' },
    });
  });

  it('reports a throw while enriching the rows as UNEXPECTED_ERROR too, never an empty stdout', async () => {
    const h = capture({ enrich: () => { throw new Error('devicectl parse blew up'); } });
    expect(await runListDevices({ json: true }, h.deps)).toBe(1);
    expect(JSON.parse(h.out())).toMatchObject({ error: { code: 'UNEXPECTED_ERROR', message: expect.stringContaining('devicectl parse blew up') } });
  });

  it('text mode lets an unexpected error reach the CLI fatal-error handler, like the other commands', async () => {
    const h = capture({ enrich: () => { throw new Error('devicectl parse blew up'); } });
    await expect(runListDevices({ json: false }, h.deps)).rejects.toThrow('devicectl parse blew up');
  });

  it('keeps text-mode failures on stderr, exit 1', async () => {
    const h = capture({ fetchDevices: async () => { throw new ListDevicesError('DAEMON_NOT_FOUND', 'no daemon', 'reinstall'); } });
    expect(await runListDevices({ json: false }, h.deps)).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toContain('no daemon');
    expect(h.err()).toContain('reinstall');
  });
});

describe('listDevicesFromDaemon failure codes', () => {
  it('DAEMON_NOT_FOUND when no daemon binary resolves', async () => {
    const err = await listDevicesFromDaemon({ findBin: () => { throw new Error('not found anywhere'); } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ListDevicesError);
    expect(err).toMatchObject({ code: 'DAEMON_NOT_FOUND', message: expect.stringContaining('not found anywhere') });
  });

  it.each([
    ['exits on SIGTERM', ''],
    ['ignores SIGTERM (SIGKILL after the grace period)', "trap '' TERM\n"],
  ])('kills the spawned daemon when the gRPC client cannot be built: one that %s', async (_name, trap) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const pidFile = path.join(dir, 'pid');
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, `#!/bin/sh\n${trap}echo $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
    try {
      const err = await listDevicesFromDaemon({
        findBin: () => bin,
        connect: () => {
          // Wait for the child to record its pid, then fail as a missing proto file would.
          const deadline = Date.now() + 5_000;
          while (!fs.existsSync(pidFile) && Date.now() < deadline) { /* spin */ }
          throw new Error('ENOENT: tapsmith.proto');
        },
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ message: 'ENOENT: tapsmith.proto' });
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const deadline = Date.now() + 6_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('DAEMON_START_FAILED with the reinstall fix when spawn() throws (ENOEXEC, EBADARCH)', async () => {
    const spawnDaemon = (() => { throw Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC' }); }) as unknown as typeof import('node:child_process').spawn;
    const err = await listDevicesFromDaemon({ findBin: () => '/x/tapsmith-core', spawnDaemon }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ListDevicesError);
    expect(err).toMatchObject({
      code: 'DAEMON_START_FAILED',
      message: 'Failed to start the tapsmith-core daemon (/x/tapsmith-core): spawn ENOEXEC',
      fix: expect.stringMatching(/^Reinstall tapsmith/),
    });
  });

  it('a garbage binary is DAEMON_START_FAILED however the platform reports it (throw on macOS, shell exit on Linux)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]), { mode: 0o755 });
    try {
      const err = await listDevicesFromDaemon({ findBin: () => bin }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'DAEMON_START_FAILED', fix: expect.stringContaining('TAPSMITH_DAEMON_BIN') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DAEMON_START_FAILED at once, with the reinstall fix, for a daemon that exits right after starting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    try {
      const started = Date.now();
      const err = await listDevicesFromDaemon({ findBin: () => bin, readyTimeoutMs: 10_000 }).catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(err).toMatchObject({
        code: 'DAEMON_START_FAILED',
        message: expect.stringContaining('exited with code 3'),
        // It ran, so it may have lost a port race: retry first, then reinstall.
        fix: expect.stringMatching(/^Re-run npx tapsmith list-devices; if it keeps failing: Reinstall/),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the process exits promptly after a failed start, not after the ready timeout', () => {
    // grpc-js keeps a waitForReady deadline armed after close(); a single long
    // wait held the CLI open for the whole timeout after reporting the failure.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    const script = path.join(dir, 'probe.mts');
    const moduleUrl = new URL('../list-devices.ts', import.meta.url).href;
    fs.writeFileSync(script, `import { listDevicesFromDaemon } from '${moduleUrl}';\n`
      + `await listDevicesFromDaemon({ findBin: () => '${bin}', readyTimeoutMs: 8_000 }).catch((e) => console.log(e.code));\n`);
    try {
      const tsx = new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname;
      const started = Date.now();
      const r = spawnSync(process.execPath, [tsx, script], { encoding: 'utf8', timeout: 20_000 });
      expect(r.stdout.trim(), r.stderr).toBe('DAEMON_START_FAILED');
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns the devices adb cannot use after the usable ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const usable = daemonDevice({ serial: 'emulator-5554', platform: 'android', isEmulator: true, state: 'Discovered' });
    const unauthorized = daemonDevice({ serial: 'R5CR1234XYZ', platform: 'android', state: 'unauthorized' });
    const stub = {
      waitForReady: async () => true,
      listDevices: async () => ({ requestId: 'r', devices: [usable], unusableDevices: [unauthorized] }),
      close: () => {},
    } as unknown as TapsmithGrpcClient;
    try {
      expect(await listDevicesFromDaemon({ findBin: () => bin, connect: () => stub })).toEqual([usable, unauthorized]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('LIST_DEVICES_FAILED when the daemon answers but ListDevices rejects', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const stub = {
      waitForReady: async () => true,
      listDevices: async () => { throw new Error('14 UNAVAILABLE: adb hung'); },
      close: () => {},
    } as unknown as TapsmithGrpcClient;
    try {
      const err = await listDevicesFromDaemon({ findBin: () => bin, connect: () => stub }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'LIST_DEVICES_FAILED', message: expect.stringContaining('adb hung'), fix: expect.stringContaining('doctor') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DAEMON_START_FAILED for a daemon that starts but never answers suggests a retry, not a reinstall', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-list-devices-'));
    const bin = path.join(dir, 'fake-core');
    fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    try {
      const err = await listDevicesFromDaemon({ findBin: () => bin, readyTimeoutMs: 300 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ListDevicesError);
      expect(err).toMatchObject({ code: 'DAEMON_START_FAILED', message: expect.stringContaining('did not answer within 0.3 s') });
      expect((err as ListDevicesError).fix).not.toMatch(/[Rr]einstall/);
      expect((err as ListDevicesError).fix).toContain('doctor');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('DAEMON_START_FAILED when the daemon cannot be started, naming the spawn error', async () => {
    const started = Date.now();
    const err = await listDevicesFromDaemon({ findBin: () => '/nonexistent/tapsmith-core', readyTimeoutMs: 10_000 }).catch((e: unknown) => e);
    // The spawn error ends the wait at once, not after the ready timeout.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(err).toBeInstanceOf(ListDevicesError);
    expect(err).toMatchObject({ code: 'DAEMON_START_FAILED', message: expect.stringContaining('ENOENT') });
    expect((err as ListDevicesError).fix).toContain('TAPSMITH_DAEMON_BIN');
  });
});
