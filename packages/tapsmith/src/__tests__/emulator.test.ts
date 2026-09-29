import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The PID manifest lives in os.tmpdir(), which is machine-wide: deleting the
// real one here would wipe the reuse records of every other Tapsmith run on
// this machine. Point the module under test at a private temp dir instead.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(actual.tmpdir(), 'tapsmith-emulator-test-'));
  const tmpdir = () => dir;
  return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});
import {
  findAvailablePort,
  serialForPort,
  readUiHierarchyViaAdb,
  detectBlockingSystemDialog,
  dismissSystemDialogsViaAdb,
  recordLaunchedEmulators,
  unrecordLaunchedEmulators,
  probeDeviceHealth,
  filterHealthyDevices,
  prefilterDevicesForStrategy,
  provisionEmulators,
  selectDevicesForStrategy,
  filterPreferInstalledApp,
  waitForDeviceStability,
  reclaimOrphanedEmulators,
  cleanupStaleEmulators,
  emulatorLaunchArgs,
  isTapsmithLaunchedEmulator,
  readProcessArgs,
  TAPSMITH_EMULATOR_IDENTITY_FLAGS,
} from '../emulator.js';

const manifestFile = path.join(os.tmpdir(), 'tapsmith-emulators.json');

afterAll(() => {
  // Only ever the private dir the os mock created — never the real tmpdir.
  if (path.basename(os.tmpdir()).startsWith('tapsmith-emulator-test-')) {
    fs.rmSync(os.tmpdir(), { recursive: true, force: true });
  }
});

describe('emulator utilities', () => {
  // Clean the (redirected) PID manifest before/after every test so
  // provisionEmulators tests don't leak fake entries into each other.
  beforeEach(() => {
    try { fs.unlinkSync(manifestFile); } catch { /* ok */ }
  });
  afterEach(() => {
    try { fs.unlinkSync(manifestFile); } catch { /* ok */ }
  });

  describe('findAvailablePort', () => {
    it('returns base port when no ports are used', () => {
      expect(findAvailablePort(new Set())).toBe(5554);
    });

    it('skips used ports', () => {
      expect(findAvailablePort(new Set([5554]))).toBe(5556);
    });

    it('skips multiple used ports', () => {
      expect(findAvailablePort(new Set([5554, 5556, 5558]))).toBe(5560);
    });

    it('finds first gap in used ports', () => {
      expect(findAvailablePort(new Set([5554, 5558]))).toBe(5556);
    });
  });

  describe('serialForPort', () => {
    it('formats serial from port', () => {
      expect(serialForPort(5554)).toBe('emulator-5554');
      expect(serialForPort(5556)).toBe('emulator-5556');
    });
  });

  describe('probeDeviceHealth', () => {
    it('accepts a healthy emulator', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
      });

      expect(probeDeviceHealth('emulator-5554', exec)).toEqual({
        serial: 'emulator-5554',
        healthy: true,
      });
    });

    it('rejects an unresponsive adb shell', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': new Error('timeout'),
      });

      expect(probeDeviceHealth('emulator-5554', exec)).toEqual({
        serial: 'emulator-5554',
        healthy: false,
        reason: 'ADB shell is unresponsive',
      });
    });

    it('rejects an emulator that is not fully booted', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '0\n',
      });

      expect(probeDeviceHealth('emulator-5554', exec)).toEqual({
        serial: 'emulator-5554',
        healthy: false,
        reason: 'emulator is not fully booted',
      });
    });

    it('rejects a device with an unresponsive package manager', () => {
      const exec = makeExec({
        'adb|-s|device-123|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|device-123|shell|pm|path|android': new Error('pm hung'),
      });

      expect(probeDeviceHealth('device-123', exec)).toEqual({
        serial: 'device-123',
        healthy: false,
        reason: 'package manager is unresponsive',
      });
    });

    it('rejects a device showing a blocking system dialog that persists after dismissal', () => {
      // The dialog persists even after dismissal attempts — all dumps return the ANR.
      const exec = makePermissiveExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
        'adb|-s|emulator-5554|exec-out|uiautomator|dump|/dev/tty':
          'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Pixel Launcher isn&apos;t responding" /></hierarchy>\n',
      });

      const result = probeDeviceHealth('emulator-5554', exec);
      expect(result.serial).toBe('emulator-5554');
      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('blocking system dialog detected');
    });
  });

  describe('readUiHierarchyViaAdb / detectBlockingSystemDialog', () => {
    it('extracts XML from uiautomator dump output', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|exec-out|uiautomator|dump|/dev/tty':
          'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Hello" /></hierarchy>\n',
      });

      expect(readUiHierarchyViaAdb('emulator-5554', exec)).toBe('<hierarchy><node text="Hello" /></hierarchy>');
    });

    it('detects launcher ANR text in the hierarchy', () => {
      expect(
        detectBlockingSystemDialog('<hierarchy><node text="Pixel Launcher isn&apos;t responding" /></hierarchy>'),
      ).toContain('Pixel Launcher');
    });

    it('detects ANR with plain ASCII apostrophe (UIAutomator agent format)', () => {
      expect(
        detectBlockingSystemDialog('<hierarchy><node text="System UI isn\'t responding" /></hierarchy>'),
      ).toContain('System UI');
    });
  });

  describe('dismissSystemDialogsViaAdb', () => {
    it('returns false when no blocking dialog is present', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|exec-out|uiautomator|dump|/dev/tty':
          'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Home" /></hierarchy>\n',
      });

      expect(dismissSystemDialogsViaAdb('emulator-5554', exec)).toBe(false);
    });

    it('sends keyevents and force-stops launcher when ANR is detected', () => {
      const calls: string[] = [];
      const exec = ((file: string, args: string[]) => {
        const key = [file, ...args].join('|');
        calls.push(key);

        // First dump: ANR present. Second dump: ANR gone.
        if (key.includes('uiautomator|dump')) {
          if (calls.filter((c) => c.includes('uiautomator|dump')).length === 1) {
            return 'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Pixel Launcher isn&apos;t responding" /></hierarchy>\n';
          }
          return 'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Home" /></hierarchy>\n';
        }

        return '';
      }) as unknown as typeof import('node:child_process').execFileSync;

      const result = dismissSystemDialogsViaAdb('emulator-5554', exec);
      expect(result).toBe(true);
      expect(calls.some((c) => c.includes('KEYCODE_ENTER'))).toBe(true);
      expect(calls.some((c) => c.includes('force-stop'))).toBe(true);
      expect(calls.some((c) => c.includes('KEYCODE_HOME'))).toBe(true);
    });
  });

  describe('probeDeviceHealth with ANR auto-dismissal', () => {
    it('auto-dismisses a blocking dialog and reports healthy', () => {
      let dumpCount = 0;
      const exec = ((file: string, args: string[]) => {
        const key = [file, ...args].join('|');

        if (key.includes('echo|__tapsmith_health_ok__')) return '__tapsmith_health_ok__\n';
        if (key.includes('getprop|sys.boot_completed')) return '1\n';
        if (key.includes('pm|path|android')) return 'package:/system/framework/framework-res.apk\n';

        if (key.includes('uiautomator|dump')) {
          dumpCount++;
          // First two dumps show ANR, third is clear (after dismissal)
          if (dumpCount <= 1) {
            return 'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Pixel Launcher isn&apos;t responding" /></hierarchy>\n';
          }
          return 'UI hierchary dumped to: /dev/tty\n<hierarchy><node text="Home" /></hierarchy>\n';
        }

        return '';
      }) as unknown as typeof import('node:child_process').execFileSync;

      const result = probeDeviceHealth('emulator-5554', exec);
      expect(result.healthy).toBe(true);
    });
  });

  describe('filterHealthyDevices', () => {
    it('returns healthy serials and unhealthy probe results', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
        'adb|-s|emulator-5556|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5556|shell|getprop|sys.boot_completed': '0\n',
      });

      expect(filterHealthyDevices(['emulator-5554', 'emulator-5556'], exec)).toEqual({
        healthySerials: ['emulator-5554'],
        unhealthyDevices: [{
          serial: 'emulator-5556',
          healthy: false,
          reason: 'emulator is not fully booted',
        }],
      });
    });
  });

  describe('waitForDeviceStability', () => {
    it('requires consecutive healthy probes before accepting the device', async () => {
      const results = [
        { serial: 'emulator-5554', healthy: false, reason: 'emulator is not fully booted' },
        { serial: 'emulator-5554', healthy: true },
        { serial: 'emulator-5554', healthy: true },
      ];

      const probe = vi.fn(() => results.shift() ?? { serial: 'emulator-5554', healthy: true });
      const health = await waitForDeviceStability('emulator-5554', 10_000, probe);

      expect(health).toEqual({ serial: 'emulator-5554', healthy: true });
      expect(probe).toHaveBeenCalledTimes(3);
    });
  });

  describe('selectDevicesForStrategy', () => {
    it('prefilters clearly non-matching AVD instances before health checks', () => {
      expect(
        prefilterDevicesForStrategy(
          ['emulator-5554', 'emulator-5556', 'device-123'],
          'avd-only',
          'Tapsmith_Phone_API_36',
          (serial) => {
            if (serial === 'emulator-5554') return 'Tapsmith_Phone_API_36';
            if (serial === 'emulator-5556') return 'Small_Phone_API_35';
            return undefined;
          },
        ),
      ).toEqual({
        candidateSerials: ['emulator-5554'],
        selectedSerials: ['emulator-5554'],
        skippedDevices: [
          {
            serial: 'emulator-5556',
            reason: 'running AVD Small_Phone_API_35 does not match requested AVD Tapsmith_Phone_API_36',
          },
          {
            serial: 'device-123',
            reason: 'device is not an emulator instance of requested AVD Tapsmith_Phone_API_36',
          },
        ],
      });
    });

    it('keeps unknown-emulator devices in play until health/selection can decide', () => {
      expect(
        prefilterDevicesForStrategy(
          ['emulator-5554'],
          'avd-only',
          'Tapsmith_Phone_API_36',
          () => undefined,
        ),
      ).toEqual({
        candidateSerials: ['emulator-5554'],
        selectedSerials: [],
        skippedDevices: [],
      });
    });

    it('returns all devices for prefer-connected', () => {
      expect(
        selectDevicesForStrategy(['emulator-5554', 'device-123'], 'prefer-connected', 'Pixel_9_API_35'),
      ).toEqual({
        selectedSerials: ['emulator-5554', 'device-123'],
        skippedDevices: [],
      });
    });

    it('keeps only matching AVD instances for avd-only', () => {
      expect(
        selectDevicesForStrategy(
          ['emulator-5554', 'emulator-5556', 'device-123'],
          'avd-only',
          'Pixel_9_API_35',
          (serial) => serial === 'emulator-5554' ? 'Pixel_9_API_35' : 'Small_Phone_API_35',
        ),
      ).toEqual({
        selectedSerials: ['emulator-5554'],
        skippedDevices: [
          {
            serial: 'emulator-5556',
            reason: 'running AVD Small_Phone_API_35 does not match requested AVD Pixel_9_API_35',
          },
          {
            serial: 'device-123',
            reason: 'device is not an emulator instance of requested AVD Pixel_9_API_35',
          },
        ],
      });
    });

    it('requires avd when avd-only is selected', () => {
      expect(() => selectDevicesForStrategy(['emulator-5554'], 'avd-only', undefined)).toThrow(
        'deviceStrategy "avd-only" requires `avd` to be set in config',
      );
    });
  });

  describe('filterPreferInstalledApp', () => {
    it('drops same-AVD instances missing the app when another instance has it', () => {
      expect(
        filterPreferInstalledApp(
          ['emulator-5554', 'emulator-5556'],
          'com.samlovesit.StoryApp',
          (serial) => serial === 'emulator-5554',
        ),
      ).toEqual({
        selectedSerials: ['emulator-5554'],
        skippedDevices: [
          {
            serial: 'emulator-5556',
            reason:
              'app com.samlovesit.StoryApp is not installed (another running instance of AVD shares this name but has the app)',
          },
        ],
      });
    });

    it('keeps all devices when none have the app yet (fresh boots / install pending)', () => {
      expect(
        filterPreferInstalledApp(
          ['emulator-5554', 'emulator-5556'],
          'com.samlovesit.StoryApp',
          () => false,
        ),
      ).toEqual({
        selectedSerials: ['emulator-5554', 'emulator-5556'],
        skippedDevices: [],
      });
    });

    it('is a no-op when no package is configured', () => {
      expect(
        filterPreferInstalledApp(['emulator-5554', 'emulator-5556'], undefined, () => false),
      ).toEqual({
        selectedSerials: ['emulator-5554', 'emulator-5556'],
        skippedDevices: [],
      });
    });

    it('is a no-op for a single device', () => {
      const isInstalled = vi.fn(() => false);
      expect(filterPreferInstalledApp(['emulator-5554'], 'com.samlovesit.StoryApp', isInstalled)).toEqual({
        selectedSerials: ['emulator-5554'],
        skippedDevices: [],
      });
      expect(isInstalled).not.toHaveBeenCalled();
    });
  });

  describe('PID manifest', () => {
    it('records and unrecords launched emulators', () => {
      const launched = [
        makeLaunchedEmulator('TestAVD', 5554),
        makeLaunchedEmulator('TestAVD', 5556),
      ];
      // Simulate PIDs
      Object.defineProperty(launched[0].process, 'pid', { value: 12345 });
      Object.defineProperty(launched[1].process, 'pid', { value: 12346 });

      recordLaunchedEmulators(launched);

      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
      expect(manifest).toHaveLength(2);
      expect(manifest[0].serial).toBe('emulator-5554');
      expect(manifest[0].pid).toBe(12345);
      expect(manifest[0].avd).toBe('TestAVD');
      expect(manifest[1].serial).toBe('emulator-5556');

      // Unrecord one
      unrecordLaunchedEmulators([launched[0]]);

      const afterUnrecord = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
      expect(afterUnrecord).toHaveLength(1);
      expect(afterUnrecord[0].serial).toBe('emulator-5556');
    });
  });

  describe('manifest isolation', () => {
    it('never points the tests at the machine-wide manifest', () => {
      expect(path.dirname(manifestFile)).toMatch(/tapsmith-emulator-test-/);
      // Assert through the module under test, not just this file's own path.
      const emu = makeLaunchedEmulator('IsolationAVD', 5554);
      Object.defineProperty(emu.process, 'pid', { value: 4321 });
      recordLaunchedEmulators([emu]);
      expect(JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))).toEqual([
        expect.objectContaining({ avd: 'IsolationAVD', pid: 4321 }),
      ]);
    });
  });

  describe('Tapsmith launch identity', () => {
    const argvOf = (avd: string, port: number) => [
      '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless',
      ...emulatorLaunchArgs(avd, port),
    ];

    it('recognises the exact argv launchEmulator spawns', () => {
      expect(isTapsmithLaunchedEmulator(argvOf('Pixel_API_36', 5556), { port: 5556, avd: 'Pixel_API_36' })).toBe(true);
      expect(isTapsmithLaunchedEmulator(argvOf('Pixel_API_36', 5556), { port: 5556 })).toBe(true);
    });

    it('keys identity only on flags that are part of the real launch args', () => {
      const args = emulatorLaunchArgs('A', 5554);
      expect(TAPSMITH_EMULATOR_IDENTITY_FLAGS.length).toBeGreaterThan(0);
      for (const flag of TAPSMITH_EMULATOR_IDENTITY_FLAGS) {
        expect(args).toContain(flag);
      }
      expect(args.slice(args.indexOf('-avd'), args.indexOf('-avd') + 2)).toEqual(['-avd', 'A']);
      expect(args.slice(args.indexOf('-port'), args.indexOf('-port') + 2)).toEqual(['-port', '5554']);
    });

    it('rejects a user-started emulator on the same port (no -read-only)', () => {
      const argv = ['/sdk/qemu-system-aarch64', '-avd', 'Pixel_API_36', '-port', '5554', '-no-window'];
      expect(isTapsmithLaunchedEmulator(argv, { port: 5554, avd: 'Pixel_API_36' })).toBe(false);
    });

    it('rejects a different port or AVD, matching whole values only', () => {
      expect(isTapsmithLaunchedEmulator(argvOf('Pixel', 55540), { port: 5554 })).toBe(false);
      expect(isTapsmithLaunchedEmulator(argvOf('Pixel', 5556), { port: 5554 })).toBe(false);
      expect(isTapsmithLaunchedEmulator(argvOf('Pixel_2', 5554), { port: 5554, avd: 'Pixel' })).toBe(false);
    });

    it('reads a real process command line that the identity check accepts', async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', ...emulatorLaunchArgs('Real_AVD', 5582)], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => child.once('spawn', resolve));
        const argv = readProcessArgs(child.pid!);
        expect(argv).toBeDefined();
        expect(isTapsmithLaunchedEmulator(argv!, { port: 5582, avd: 'Real_AVD' })).toBe(true);
        expect(isTapsmithLaunchedEmulator(argv!, { port: 5554, avd: 'Real_AVD' })).toBe(false);
      } finally {
        child.kill();
      }
    });

    it('returns undefined for a process that does not exist', () => {
      expect(readProcessArgs(2 ** 22 + 12345)).toBeUndefined();
    });

    it('rejects an unrelated process', () => {
      expect(isTapsmithLaunchedEmulator(['/usr/bin/node', 'server.js', '-port', '5554'], { port: 5554 })).toBe(false);
      expect(isTapsmithLaunchedEmulator([], { port: 5554 })).toBe(false);
    });
  });

  describe('reclaimOrphanedEmulators', () => {
    const entry = (overrides: Partial<{ serial: string, pid: number, avd: string, port: number }> = {}) => ({
      serial: 'emulator-5554',
      pid: 4242,
      avd: 'Pixel_API_36',
      port: 5554,
      launchedAt: '2026-09-28T10:00:00.000Z',
      ...overrides,
    });
    const tapsmithArgv = (avd = 'Pixel_API_36', port = 5554) => ['/sdk/qemu-system-aarch64-headless', ...emulatorLaunchArgs(avd, port)];
    const userArgv = ['/sdk/qemu-system-aarch64', '-avd', 'Pixel_API_36', '-port', '5554'];

    function harness(opts: {
      entries: ReturnType<typeof entry>[]
      adb?: { serial: string, state: string }[]
      alive?: number[]
      argv?: Record<number, string[] | undefined>
      healthy?: boolean
    }) {
      const written: unknown[][] = [];
      const killEmulator = vi.fn();
      const killProcess = vi.fn();
      const probeDeviceHealth = vi.fn((serial: string) => ({ serial, healthy: opts.healthy ?? true, reason: opts.healthy === false ? 'pm unresponsive' : undefined }));
      const deps = {
        readManifest: () => opts.entries,
        writeManifest: (e: unknown[]) => { written.push(e); },
        listAdbDevices: () => opts.adb ?? [],
        isProcessAlive: (pid: number) => (opts.alive ?? []).includes(pid),
        readProcessArgs: (pid: number) => opts.argv?.[pid],
        probeDeviceHealth,
        killEmulator,
        killProcess,
      };
      return { deps, written, killEmulator, killProcess, probeDeviceHealth };
    }

    beforeEach(() => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('drops a dead entry and leaves a foreign emulator on the same serial running', () => {
      const h = harness({
        entries: [entry({ pid: 999991 })],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [7777],
        argv: { 7777: userArgv },
      });
      const result = reclaimOrphanedEmulators(h.deps);
      expect(result).toEqual({ reusable: [], killed: [] });
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.killProcess).not.toHaveBeenCalled();
      expect(h.written).toEqual([[]]);
    });

    it('drops a dead entry whose serial is gone, killing nothing', () => {
      const h = harness({ entries: [entry({ pid: 999991 })] });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [] });
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.written).toEqual([[]]);
    });

    it('does not signal a recorded PID that now belongs to an unrelated process', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: ['/usr/bin/node', 'server.js'] },
        healthy: false,
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [] });
      expect(h.killProcess).not.toHaveBeenCalled();
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.written).toEqual([[]]);
    });

    it('does not reuse or kill a user emulator that happens to hold the recorded PID', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: userArgv },
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [] });
      expect(h.probeDeviceHealth).not.toHaveBeenCalled();
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.killProcess).not.toHaveBeenCalled();
    });

    it('treats an unreadable command line as not ours', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'offline' }],
        alive: [4242],
        argv: {},
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [] });
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.killProcess).not.toHaveBeenCalled();
    });

    it('reuses a healthy emulator it launched and keeps its record', () => {
      const e = entry();
      const h = harness({
        entries: [e],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: ['emulator-5554'], killed: [] });
      expect(h.written).toEqual([[e]]);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('kills an unhealthy emulator it launched and drops its record', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
        healthy: false,
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: ['emulator-5554'] });
      expect(h.killEmulator).toHaveBeenCalledWith('emulator-5554');
      expect(h.killProcess).toHaveBeenCalledWith(4242);
      expect(h.written).toEqual([[]]);
    });

    it('kills an unresponsive emulator it launched by PID when adb has lost it', () => {
      const h = harness({
        entries: [entry()],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: ['emulator-5554'] });
      expect(h.killProcess).toHaveBeenCalledWith(4242);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('judges ownership by the last record for a duplicated serial', () => {
      const h = harness({
        entries: [entry({ pid: 4242 }), entry({ pid: 999991 })],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [] });
      expect(h.killEmulator).not.toHaveBeenCalled();
    });
  });

  describe('cleanupStaleEmulators heuristic pass', () => {
    function harness(opts: {
      adb: { serial: string, state: string }[]
      listener?: Record<string, number | undefined>
      argv?: Record<number, string[] | undefined>
      avdNames?: Record<string, string>
      healthy?: Record<string, boolean>
    }) {
      const killEmulator = vi.fn();
      const deps = {
        readManifest: () => [],
        writeManifest: vi.fn(),
        listAdbDevices: () => opts.adb,
        isProcessAlive: () => false,
        readProcessArgs: (pid: number) => opts.argv?.[pid],
        findEmulatorPid: (serial: string) => opts.listener?.[serial],
        resolveAvdName: (serial: string) => opts.avdNames?.[serial],
        probeDeviceHealth: (serial: string) => ({ serial, healthy: opts.healthy?.[serial] ?? true, reason: 'boot not completed' }),
        killEmulator,
        killProcess: vi.fn(),
        waitForAdbSettle: vi.fn(),
      };
      return { deps, killEmulator };
    }

    beforeEach(() => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('leaves an unhealthy user emulator on the target AVD running', () => {
      const h = harness({
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        listener: { 'emulator-5554': 7777 },
        argv: { 7777: ['/sdk/qemu-system-aarch64', '-avd', 'Pixel', '-port', '5554'] },
        avdNames: { 'emulator-5554': 'Pixel' },
        healthy: { 'emulator-5554': false },
      });
      expect(cleanupStaleEmulators('Pixel', h.deps)).toEqual({ reusable: [], killed: [] });
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('leaves an offline user emulator running, with or without a target AVD', () => {
      const h = harness({
        adb: [{ serial: 'emulator-5554', state: 'offline' }],
        listener: { 'emulator-5554': 7777 },
        argv: { 7777: ['/sdk/qemu-system-aarch64', '-avd', 'Pixel', '-port', '5554'] },
      });
      expect(cleanupStaleEmulators('Pixel', h.deps).killed).toEqual([]);
      expect(cleanupStaleEmulators(undefined, h.deps).killed).toEqual([]);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('does not kill when no process can be tied to the serial', () => {
      const h = harness({
        adb: [{ serial: 'emulator-5554', state: 'unauthorized' }],
        listener: {},
      });
      expect(cleanupStaleEmulators('Pixel', h.deps).killed).toEqual([]);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('kills an unhealthy Tapsmith-launched orphan missing from the manifest', () => {
      const h = harness({
        adb: [{ serial: 'emulator-5556', state: 'device' }],
        listener: { 'emulator-5556': 8888 },
        argv: { 8888: ['/sdk/qemu-system-aarch64-headless', ...emulatorLaunchArgs('Pixel', 5556)] },
        avdNames: { 'emulator-5556': 'Pixel' },
        healthy: { 'emulator-5556': false },
      });
      expect(cleanupStaleEmulators('Pixel', h.deps).killed).toEqual(['emulator-5556']);
      expect(h.killEmulator).toHaveBeenCalledWith('emulator-5556');
    });

    it('leaves a Tapsmith-launched orphan of a different AVD alone', () => {
      const h = harness({
        adb: [{ serial: 'emulator-5556', state: 'offline' }],
        listener: { 'emulator-5556': 8888 },
        argv: { 8888: ['/sdk/qemu-system-aarch64-headless', ...emulatorLaunchArgs('Other', 5556)] },
      });
      expect(cleanupStaleEmulators('Pixel', h.deps).killed).toEqual([]);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('hands a serial whose record was dropped to the heuristic pass', () => {
      const deadRecord = [{ serial: 'emulator-5556', pid: 999991, avd: 'Pixel', port: 5556, launchedAt: '2026-09-28T10:00:00.000Z' }];
      const orphan = harness({
        adb: [{ serial: 'emulator-5556', state: 'device' }],
        listener: { 'emulator-5556': 8888 },
        argv: { 8888: ['/sdk/qemu-system-aarch64-headless', ...emulatorLaunchArgs('Pixel', 5556)] },
        avdNames: { 'emulator-5556': 'Pixel' },
        healthy: { 'emulator-5556': false },
      });
      expect(cleanupStaleEmulators('Pixel', { ...orphan.deps, readManifest: () => deadRecord }).killed).toEqual(['emulator-5556']);

      const user = harness({
        adb: [{ serial: 'emulator-5556', state: 'device' }],
        listener: { 'emulator-5556': 7777 },
        argv: { 7777: ['/sdk/qemu-system-aarch64', '-avd', 'Pixel', '-port', '5556'] },
        avdNames: { 'emulator-5556': 'Pixel' },
        healthy: { 'emulator-5556': false },
      });
      expect(cleanupStaleEmulators('Pixel', { ...user.deps, readManifest: () => deadRecord }).killed).toEqual([]);
      expect(user.killEmulator).not.toHaveBeenCalled();
    });

    it('does not kill an offline transport with no process behind it', () => {
      const h = harness({ adb: [{ serial: 'emulator-5554', state: 'offline' }], listener: {} });
      expect(cleanupStaleEmulators(undefined, h.deps).killed).toEqual([]);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('leaves a healthy Tapsmith-launched orphan running', () => {
      const h = harness({
        adb: [{ serial: 'emulator-5556', state: 'device' }],
        listener: { 'emulator-5556': 8888 },
        argv: { 8888: ['/sdk/qemu-system-aarch64-headless', ...emulatorLaunchArgs('Pixel', 5556)] },
        avdNames: { 'emulator-5556': 'Pixel' },
      });
      expect(cleanupStaleEmulators('Pixel', h.deps).killed).toEqual([]);
    });
  });

  describe('provisionEmulators', () => {
    it('never launches on the port of an offline emulator it left running', async () => {
      const ports: number[] = [];
      await provisionEmulators(
        { existingSerials: [], workers: 1, avd: 'Pixel' },
        {
          listAdbDevices: () => [{ serial: 'emulator-5554', state: 'offline' }],
          listAvds: () => ['Pixel'],
          getRunningAvdName: () => undefined,
          launchEmulator: (avd, port) => {
            ports.push(port);
            return makeLaunchedEmulator(avd, port);
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => ({ serial, healthy: true }),
          waitForDeviceStability: async (serial) => ({ serial, healthy: true }),
          killEmulator: vi.fn(),
        },
      );
      expect(ports).toEqual([5556]);
    });

    it('does not fall back to a different AVD when the requested one boots unhealthy', async () => {
      const killed: string[] = [];
      const launchedAvds: string[] = [];

      const result = await provisionEmulators(
        {
          existingSerials: [],
          workers: 1,
          avd: 'Broken_API_35',
        },
        {
          listAdbDevices: () => [],
          listAvds: () => ['Broken_API_35', 'Pixel_9_API_35'],
          getRunningAvdName: () => undefined,
          launchEmulator: (avd, port) => {
            launchedAvds.push(avd);
            return makeLaunchedEmulator(avd, port);
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => serial === 'emulator-5554'
            ? { serial, healthy: false, reason: 'package manager is unresponsive' }
            : { serial, healthy: true },
          waitForDeviceStability: async (serial, _timeoutMs, probe) => probe?.(serial) ?? { serial, healthy: true },
          killEmulator: (serial) => {
            killed.push(serial);
          },
        },
      );

      expect(launchedAvds).toEqual(['Broken_API_35']);
      expect(killed).toEqual(['emulator-5554']);
      expect(result.allSerials).toEqual([]);
      expect(result.launched.map((emu) => emu.avd)).toEqual([]);
    });

    it('returns existing devices when all launch candidates fail', async () => {
      const result = await provisionEmulators(
        {
          existingSerials: ['emulator-5554'],
          workers: 2,
          avd: 'Broken_API_35',
        },
        {
          listAdbDevices: () => [],
          listAvds: () => ['Broken_API_35'],
          getRunningAvdName: () => undefined,
          launchEmulator: (avd, port) => makeLaunchedEmulator(avd, port),
          waitForBoot: async () => {
            throw new Error('boot timed out');
          },
          probeDeviceHealth: () => ({ serial: 'unused', healthy: true }),
          waitForDeviceStability: async (serial, _timeoutMs, probe) => probe?.(serial) ?? { serial, healthy: true },
          killEmulator: vi.fn(),
        },
      );

      expect(result.allSerials).toEqual(['emulator-5554']);
      expect(result.launched).toEqual([]);
    });

    it('keeps the requested AVD first even when another instance is already running', async () => {
      const launchedAvds: string[] = [];

      const result = await provisionEmulators(
        {
          existingSerials: ['emulator-5554'],
          workers: 2,
          avd: 'Pixel_9_API_35',
        },
        {
          listAdbDevices: () => [],
          listAvds: () => ['Pixel_9_API_35', 'Small_Phone_API_35'],
          getRunningAvdName: (serial) => serial === 'emulator-5554' ? 'Pixel_9_API_35' : undefined,
          launchEmulator: (avd, port) => {
            launchedAvds.push(avd);
            return makeLaunchedEmulator(avd, port);
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => ({ serial, healthy: true }),
          waitForDeviceStability: async (serial, _timeoutMs, probe) => probe?.(serial) ?? { serial, healthy: true },
          killEmulator: vi.fn(),
        },
      );

      expect(launchedAvds).toEqual(['Pixel_9_API_35']);
      expect(result.allSerials).toEqual(['emulator-5554', 'emulator-5556']);
      expect(result.launched.map((emu) => emu.avd)).toEqual(['Pixel_9_API_35']);
    });

    it('avoids occupied emulator ports even when those devices are not counted as existing workers', async () => {
      const launchedPorts: number[] = [];

      const result = await provisionEmulators(
        {
          existingSerials: [],
          occupiedSerials: ['emulator-5554'],
          workers: 1,
          avd: 'Pixel_9_API_35',
        },
        {
          listAdbDevices: () => [],
          listAvds: () => ['Pixel_9_API_35'],
          getRunningAvdName: () => 'Small_Phone_API_35',
          launchEmulator: (avd, port) => {
            launchedPorts.push(port);
            return makeLaunchedEmulator(avd, port);
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => ({ serial, healthy: true }),
          waitForDeviceStability: async (serial, _timeoutMs, probe) => probe?.(serial) ?? { serial, healthy: true },
          killEmulator: vi.fn(),
        },
      );

      expect(launchedPorts).toEqual([5556]);
      expect(result.allSerials).toEqual(['emulator-5556']);
    });
  });
});

function makeExec(responses: Record<string, string | Error>) {
  return ((file: string, args: string[]) => {
    const key = [file, ...args].join('|');
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error(`Unexpected command: ${key}`);
    }
    return response;
  }) as unknown as typeof import('node:child_process').execFileSync;
}

/**
 * Like makeExec but returns '' for unknown commands instead of throwing.
 * Useful for tests that trigger side-effect commands (like ANR dismissal).
 */
function makePermissiveExec(responses: Record<string, string | Error>) {
  return ((file: string, args: string[]) => {
    const key = [file, ...args].join('|');
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }
    return response ?? '';
  }) as unknown as typeof import('node:child_process').execFileSync;
}

function makeLaunchedEmulator(avd: string, port: number) {
  return {
    avd,
    port,
    serial: serialForPort(port),
    process: {
      kill: vi.fn(),
    },
  } as unknown as import('../emulator.js').LaunchedEmulator;
}
