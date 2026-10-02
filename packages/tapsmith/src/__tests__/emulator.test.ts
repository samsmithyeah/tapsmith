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
  blockingDialogOwnersViaAdb,
  isSystemDrawnDialog,
  formatBlockingDialog,
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
  resolveEmulatorBinary,
  emulatorNotFoundMessage,
  resolveEmulatorLaunchSettings,
  launchEmulator,
  describeEmulatorExit,
  preserveEmulatorsForReuse,
  emulatorsLaunchedThisProcess,
  waitForBoot,
  waitForSystemSettle,
  listAdbDevices,
} from '../emulator.js';

const manifestFile = path.join(os.tmpdir(), 'tapsmith-emulators.json');

/** `uiautomator dump` of a real "Pixel Launcher isn't responding" dialog,
 *  captured on an API 36 emulator (PILOT-398). */
const LAUNCHER_ANR_FIXTURE = fs.readFileSync(
  new URL('./fixtures/android-launcher-anr.xml', import.meta.url), 'utf-8',
);

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

    it('names the persisting dialog and its owner, not raw XML', () => {
      const exec = makePermissiveExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
        'adb|-s|emulator-5554|exec-out|uiautomator|dump|/dev/tty': `${LAUNCHER_ANR_FIXTURE}UI hierchary dumped to: /dev/tty\n`,
        'adb|-s|emulator-5554|shell|dumpsys|window|windows':
          '  Window #6 Window{8667851 u0 Application Not Responding: com.google.android.apps.nexuslauncher}:\n',
      });

      expect(probeDeviceHealth('emulator-5554', exec).reason).toBe(
        'blocking system dialog detected: "Pixel Launcher isn\'t responding" (com.google.android.apps.nexuslauncher)',
      );
    });

    it('names no owner when several dialog windows are listed', () => {
      const exec = makePermissiveExec({
        'adb|-s|emulator-5554|shell|echo|__tapsmith_health_ok__': '__tapsmith_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
        'adb|-s|emulator-5554|exec-out|uiautomator|dump|/dev/tty': LAUNCHER_ANR_FIXTURE,
        'adb|-s|emulator-5554|shell|dumpsys|window|windows':
          '  Window #6 Window{1 u0 Application Not Responding: com.google.android.gms}:\n'
          + '  Window #7 Window{2 u0 Application Not Responding: com.google.android.apps.nexuslauncher}:\n',
      });

      expect(probeDeviceHealth('emulator-5554', exec).reason).toBe(
        'blocking system dialog detected: "Pixel Launcher isn\'t responding"',
      );
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

    // PILOT-399: the description used to be the first 160 chars of the whole
    // dump, which always stopped at the XML prologue and never named the dialog.
    it('names the dialog by its title in a real launcher-ANR dump', () => {
      expect(detectBlockingSystemDialog(LAUNCHER_ANR_FIXTURE)).toBe('Pixel Launcher isn\'t responding');
    });

    it('decodes entities in the title', () => {
      expect(detectBlockingSystemDialog('<node text="Fish &amp; Chips isn&apos;t responding" />'))
        .toBe('Fish & Chips isn\'t responding');
      expect(detectBlockingSystemDialog('<node text="Maps keeps stopping" resource-id="android:id/alertTitle" />'))
        .toBe('Maps keeps stopping');
    });

    it('prefers the alert title over other matching text', () => {
      const xml = '<node text="Earlier, Maps keeps stopping was logged" />'
        + '<node resource-id="android:id/alertTitle" text="Google Play services isn’t responding" />';
      expect(detectBlockingSystemDialog(xml)).toBe('Google Play services isn’t responding');
    });

    it('prefers a system-drawn node over the app\'s own text when there is no alert title', () => {
      const xml = '<node package="com.example.app" text="The server isn&apos;t responding" />'
        + '<node package="android" text="Maps keeps stopping" />';
      expect(detectBlockingSystemDialog(xml)).toBe('Maps keeps stopping');
    });

    it('falls back to a generic description when the phrase is not in a text attribute', () => {
      expect(detectBlockingSystemDialog('<node content-desc="Maps keeps stopping" />')).toBe('an app isn\'t responding or keeps stopping');
    });

    it('never returns hierarchy XML', () => {
      expect(detectBlockingSystemDialog(LAUNCHER_ANR_FIXTURE)).not.toContain('<');
    });
  });

  describe('blockingDialogOwnersViaAdb', () => {
    const windows = (title: string) =>
      `  Window #5 Window{4b77699 u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}:\n`
      + `  Window #6 Window{8667851 u0 ${title}}:\n`
      + `    WindowStateAnimator{15c551f ${title}}:\n`;

    it('reads the ANR owner from the dialog window title', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|dumpsys|window|windows': windows('Application Not Responding: com.google.android.apps.nexuslauncher'),
      });
      expect(blockingDialogOwnersViaAdb('emulator-5554', exec)).toEqual(['com.google.android.apps.nexuslauncher']);
    });

    it('reads the crash-dialog owner', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|dumpsys|window|windows': windows('Application Error: com.example.app'),
      });
      expect(blockingDialogOwnersViaAdb('emulator-5554', exec)).toEqual(['com.example.app']);
      // A secondary process reads as its app.
      expect(blockingDialogOwnersViaAdb('emulator-5554', makeExec({
        'adb|-s|emulator-5554|shell|dumpsys|window|windows': windows('Application Not Responding: com.example.app:remote'),
      }))).toEqual(['com.example.app']);
    });

    it('returns every owner when several dialogs are up', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|dumpsys|window|windows':
          windows('Application Not Responding: com.google.android.apps.nexuslauncher')
          + windows('Application Error: com.example.app'),
      });
      expect(blockingDialogOwnersViaAdb('emulator-5554', exec))
        .toEqual(['com.google.android.apps.nexuslauncher', 'com.example.app']);
    });

    it('returns nothing when no dialog window is listed or adb fails', () => {
      expect(blockingDialogOwnersViaAdb('emulator-5554', makeExec({
        'adb|-s|emulator-5554|shell|dumpsys|window|windows': '  Window #1 Window{1 u0 StatusBar}:\n',
      }))).toEqual([]);
      expect(blockingDialogOwnersViaAdb('emulator-5554', makeExec({
        'adb|-s|emulator-5554|shell|dumpsys|window|windows': new Error('device offline'),
      }))).toEqual([]);
    });
  });

  describe('isSystemDrawnDialog', () => {
    it('is true for the real system_server dialog', () => {
      expect(isSystemDrawnDialog(LAUNCHER_ANR_FIXTURE)).toBe(true);
    });

    it('is false for the same phrase in the app\'s own UI', () => {
      expect(isSystemDrawnDialog('<node package="com.example.app" text="The server isn&apos;t responding" />')).toBe(false);
    });
  });

  describe('formatBlockingDialog', () => {
    it('quotes the title and names the owner when known', () => {
      expect(formatBlockingDialog('Pixel Launcher isn\'t responding', 'com.google.android.apps.nexuslauncher'))
        .toBe('"Pixel Launcher isn\'t responding" (com.google.android.apps.nexuslauncher)');
      expect(formatBlockingDialog('Pixel Launcher isn\'t responding')).toBe('"Pixel Launcher isn\'t responding"');
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
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', ...emulatorLaunchArgs('Real_AVD', 5582)], { stdio: 'ignore' });
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

    it('falls back to ps when /proc is unavailable', async () => {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', ...emulatorLaunchArgs('Ps_AVD', 5584)], { stdio: 'ignore' });
      try {
        await new Promise((resolve) => child.once('spawn', resolve));
        const argv = readProcessArgs(child.pid!, path.join(os.tmpdir(), 'no-such-proc'));
        expect(argv).toBeDefined();
        expect(isTapsmithLaunchedEmulator(argv!, { port: 5584, avd: 'Ps_AVD' })).toBe(true);
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
      listener?: Record<string, number | undefined>
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
        findEmulatorPid: (serial: string) => opts.listener?.[serial],
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

    it('says whether a reused emulator is headless, and how to relaunch it only when this run wants the other kind', () => {
      for (const [headless, mode] of [[true, 'headless'], [false, 'with a window']] as const) {
        const h = harness({
          entries: [entry()],
          adb: [{ serial: 'emulator-5554', state: 'device' }],
          alive: [4242],
          argv: { 4242: ['/sdk/qemu', ...emulatorLaunchArgs('Pixel_API_36', 5554, { headless, args: [] })] },
          listener: { 'emulator-5554': 4242 },
        });
        const writes = vi.mocked(process.stderr.write);
        writes.mockClear();
        expect(reclaimOrphanedEmulators(h.deps, headless).reusable).toEqual(['emulator-5554']);
        const same = String(writes.mock.calls[0]?.[0]);
        expect(same).toContain(`Reusing emulator emulator-5554 (AVD Pixel_API_36, ${mode}) from previous run.`);
        expect(same).not.toContain('emu kill');
        writes.mockClear();
        reclaimOrphanedEmulators(h.deps, !headless);
        expect(String(writes.mock.calls[0]?.[0])).toContain(
          `This run would launch it ${headless ? 'with a window' : 'headless'}: stop it (adb -s emulator-5554 emu kill) to relaunch it that way.`,
        );
      }
    });

    it('drops a dead entry and leaves a foreign emulator on the same serial running', () => {
      const h = harness({
        entries: [entry({ pid: 999991 })],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [7777],
        argv: { 7777: userArgv },
      });
      const result = reclaimOrphanedEmulators(h.deps);
      expect(result).toEqual({ reusable: [], killed: [], undetermined: [] });
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.killProcess).not.toHaveBeenCalled();
      expect(h.written).toEqual([[]]);
    });

    it('drops a dead entry whose serial is gone, killing nothing', () => {
      const h = harness({ entries: [entry({ pid: 999991 })] });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: [] });
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
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: [] });
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
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: [] });
      expect(h.probeDeviceHealth).not.toHaveBeenCalled();
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.killProcess).not.toHaveBeenCalled();
    });

    it('keeps the record, without reusing or killing, when a live PID cannot be read', () => {
      const e = entry();
      const h = harness({
        entries: [e],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: {},
        healthy: false,
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: ['emulator-5554'] });
      expect(h.probeDeviceHealth).not.toHaveBeenCalled();
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.killProcess).not.toHaveBeenCalled();
      expect(h.written).toEqual([[e]]);
    });

    it("never kills when an offline emulator's command line is unreadable", () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'offline' }],
        alive: [4242],
        argv: {},
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: ['emulator-5554'] });
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
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: ['emulator-5554'], killed: [], undetermined: [] });
      expect(h.written).toEqual([[e]]);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('kills an unhealthy emulator it launched and drops its record', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
        listener: { 'emulator-5554': 4242 },
        healthy: false,
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: ['emulator-5554'], undetermined: [] });
      expect(h.killEmulator).toHaveBeenCalledWith('emulator-5554');
      expect(h.killProcess).toHaveBeenCalledWith(4242);
      expect(h.written).toEqual([[]]);
    });

    it('signals only its own PID when another process holds the console port', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
        listener: { 'emulator-5554': 7777 },
        healthy: false,
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: [] });
      expect(h.killProcess).toHaveBeenCalledWith(4242);
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.written).toEqual([[]]);
    });

    it('does not adopt a healthy emulator that holds the port instead of its own PID', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
        listener: { 'emulator-5554': 7777 },
      });
      expect(reclaimOrphanedEmulators(h.deps).reusable).toEqual([]);
      expect(h.probeDeviceHealth).not.toHaveBeenCalled();
      expect(h.killEmulator).not.toHaveBeenCalled();
      expect(h.written).toEqual([[]]);
    });

    it('kills an unhealthy emulator it launched by PID only when lsof cannot name the listener', () => {
      const h = harness({
        entries: [entry()],
        adb: [{ serial: 'emulator-5554', state: 'device' }],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
        healthy: false,
      });
      expect(reclaimOrphanedEmulators(h.deps).killed).toEqual(['emulator-5554']);
      expect(h.killProcess).toHaveBeenCalledWith(4242);
      expect(h.killEmulator).not.toHaveBeenCalled();
    });

    it('kills an unresponsive emulator it launched by PID when adb has lost it', () => {
      const h = harness({
        entries: [entry()],
        alive: [4242],
        argv: { 4242: tapsmithArgv() },
      });
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: ['emulator-5554'], undetermined: [] });
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
      expect(reclaimOrphanedEmulators(h.deps)).toEqual({ reusable: [], killed: [], undetermined: [] });
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

    it('leaves a serial whose ownership phase 1 could not determine to phase 1', () => {
      const record = [{ serial: 'emulator-5556', pid: 8888, avd: 'Pixel', port: 5556, launchedAt: '2026-09-28T10:00:00.000Z' }];
      let reads = 0;
      const h = harness({
        adb: [{ serial: 'emulator-5556', state: 'offline' }],
        listener: { 'emulator-5556': 8888 },
      });
      const result = cleanupStaleEmulators('Pixel', {
        ...h.deps,
        readManifest: () => record,
        isProcessAlive: () => true,
        // Unreadable in phase 1, readable (and Tapsmith's) if asked again.
        readProcessArgs: () => (reads++ === 0 ? undefined : ['/sdk/qemu', ...emulatorLaunchArgs('Pixel', 5556)]),
      });
      expect(result.killed).toEqual([]);
      expect(h.killEmulator).not.toHaveBeenCalled();
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
        { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
        {
          resolveEmulatorBinary: foundEmulator,
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
          launchOptions: undefined,
        },
        {
          resolveEmulatorBinary: foundEmulator,
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
          launchOptions: undefined,
        },
        {
          resolveEmulatorBinary: foundEmulator,
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
          launchOptions: undefined,
        },
        {
          resolveEmulatorBinary: foundEmulator,
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
          launchOptions: undefined,
        },
        {
          resolveEmulatorBinary: foundEmulator,
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

function makeLaunchedEmulator(
  avd: string,
  port: number,
  exited: Promise<import('../emulator.js').EmulatorExit> = new Promise(() => { /* never exits */ }),
) {
  return {
    avd,
    port,
    serial: serialForPort(port),
    headless: true,
    logPath: path.join(os.tmpdir(), `tapsmith-emulator-${port}.log`),
    exited,
    process: {
      kill: vi.fn(),
    },
  } as unknown as import('../emulator.js').LaunchedEmulator;
}

function foundEmulator(): import('../emulator.js').EmulatorBinary {
  return { command: '/sdk/emulator/emulator', found: true, tried: ['/sdk/emulator/emulator'] };
}

// ─── Launch profiles, binary resolution and early exit (PILOT-402, PILOT-417) ───

describe('resolveEmulatorBinary', () => {
  const none = { exists: () => false, onPath: () => false, homedir: () => '/home/u' };

  it('prefers $ANDROID_HOME/emulator/emulator', () => {
    const bin = resolveEmulatorBinary(
      { ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/old-sdk' },
      'darwin',
      { ...none, exists: (file) => file === '/sdk/emulator/emulator' || file === '/old-sdk/emulator/emulator' },
    );
    expect(bin).toEqual({ command: '/sdk/emulator/emulator', found: true, tried: ['/sdk/emulator/emulator'] });
  });

  it('falls back to ANDROID_SDK_ROOT, then the default SDK location for the OS', () => {
    expect(resolveEmulatorBinary(
      { ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/old-sdk' }, 'darwin',
      { ...none, exists: (file) => file === '/old-sdk/emulator/emulator' },
    ).command).toBe('/old-sdk/emulator/emulator');
    expect(resolveEmulatorBinary({}, 'darwin', {
      ...none, homedir: () => '/Users/u', exists: (file) => file === '/Users/u/Library/Android/sdk/emulator/emulator',
    }).command).toBe('/Users/u/Library/Android/sdk/emulator/emulator');
    expect(resolveEmulatorBinary({}, 'linux', {
      ...none, exists: (file) => file === '/home/u/Android/Sdk/emulator/emulator',
    }).command).toBe('/home/u/Android/Sdk/emulator/emulator');
  });

  it('looks for emulator.exe under %LOCALAPPDATA% on Windows', () => {
    const want = 'C:\\Users\\u\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe';
    const bin = resolveEmulatorBinary({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', {
      ...none, exists: (file) => file === want,
    });
    expect(bin.command).toBe(want);
  });

  it('finds emulator on PATH by looking in each directory, without running which', () => {
    expect(resolveEmulatorBinary({ PATH: '/usr/bin:/opt/android/emulator' }, 'linux', {
      exists: (file) => file === '/opt/android/emulator/emulator', homedir: () => '/home/u',
    })).toMatchObject({ command: 'emulator', found: true });
    expect(resolveEmulatorBinary({ Path: 'C:\\Windows;C:\\sdk\\emulator' }, 'win32', {
      exists: (file) => file === 'C:\\sdk\\emulator\\emulator.exe', homedir: () => 'C:\\Users\\u',
    })).toMatchObject({ command: 'emulator', found: true });
    expect(resolveEmulatorBinary({ PATH: '/usr/bin' }, 'linux', { exists: () => false, homedir: () => '/home/u' }).found)
      .toBe(false);
  });

  it('falls back to PATH last, and lists every place it looked', () => {
    const onPath = resolveEmulatorBinary({ ANDROID_HOME: '/sdk' }, 'linux', { ...none, onPath: () => true });
    expect(onPath).toEqual({
      command: 'emulator',
      found: true,
      tried: ['/sdk/emulator/emulator', '/home/u/Android/Sdk/emulator/emulator', '`emulator` on PATH'],
    });
    const missing = resolveEmulatorBinary({ ANDROID_HOME: '/sdk' }, 'linux', none);
    expect(missing.found).toBe(false);
  });

  it('does not take a directory for the binary (the SDK root on PATH has an emulator/ dir)', () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-'));
    fs.mkdirSync(path.join(sdk, 'emulator'));
    const bin = resolveEmulatorBinary({ PATH: sdk }, 'linux', { homedir: () => '/nonexistent-home' });
    expect(bin.found).toBe(false);
    fs.writeFileSync(path.join(sdk, 'emulator', 'emulator'), '');
    expect(resolveEmulatorBinary({ ANDROID_HOME: sdk }, 'linux', { homedir: () => '/nonexistent-home' }).found).toBe(true);
  });

  it('checks a location named twice only once', () => {
    const bin = resolveEmulatorBinary({ ANDROID_HOME: '/home/u/Android/Sdk' }, 'linux', none);
    expect(bin.tried).toEqual(['/home/u/Android/Sdk/emulator/emulator', '`emulator` on PATH']);
  });

  it('names the paths tried and the fix when nothing is found', () => {
    const message = emulatorNotFoundMessage(['/sdk/emulator/emulator', '`emulator` on PATH']);
    expect(message).toContain('/sdk/emulator/emulator, `emulator` on PATH');
    expect(message).toContain('Install "Android Emulator"');
    expect(message).toContain('set ANDROID_HOME');
  });
});

describe('resolveEmulatorLaunchSettings', () => {
  const local = {} as NodeJS.ProcessEnv;

  it('opens a window by default where one can be shown', () => {
    expect(resolveEmulatorLaunchSettings(undefined, local, 'darwin')).toEqual({ headless: false, args: [] });
    expect(resolveEmulatorLaunchSettings({ args: ['-memory', '4096'] }, { DISPLAY: ':0' }, 'linux'))
      .toEqual({ headless: false, args: ['-memory', '4096'] });
  });

  it('runs headless when asked, locally too', () => {
    expect(resolveEmulatorLaunchSettings({ headless: true }, local, 'darwin')).toEqual({ headless: true, args: [] });
  });

  it('takes -no-window in args as a request for the whole headless profile', () => {
    expect(resolveEmulatorLaunchSettings({ args: ['-no-window', '-memory', '4096'] }, local, 'darwin'))
      .toEqual({ headless: true, args: ['-memory', '4096'] });
    expect(resolveEmulatorLaunchSettings({ args: ['--no-window'] }, local, 'darwin'))
      .toEqual({ headless: true, args: [] });
  });

  it('is headless by default where no window can be shown, and says why', () => {
    expect(resolveEmulatorLaunchSettings(undefined, { CI: 'true' }, 'darwin'))
      .toEqual({ headless: true, args: [], windowUnavailable: 'this is a CI build' });
    expect(resolveEmulatorLaunchSettings(undefined, {}, 'linux'))
      .toEqual({ headless: true, args: [], windowUnavailable: 'no display is available' });
  });

  it('opens a window when asked and one can be shown', () => {
    expect(resolveEmulatorLaunchSettings({ headless: false }, local, 'darwin')).toEqual({ headless: false, args: [] });
    expect(resolveEmulatorLaunchSettings({ headless: false }, { DISPLAY: ':0' }, 'linux')).toEqual({ headless: false, args: [] });
    expect(resolveEmulatorLaunchSettings({ headless: false }, { WAYLAND_DISPLAY: 'wayland-0' }, 'linux').headless).toBe(false);
    expect(resolveEmulatorLaunchSettings({ headless: false }, { CI: 'false' }, 'darwin').headless).toBe(false);
  });

  it('never forces a window where there is nothing to show it on', () => {
    expect(resolveEmulatorLaunchSettings({ headless: false }, { CI: 'true' }, 'darwin'))
      .toEqual({ headless: true, args: [], windowUnavailable: 'this is a CI build' });
    // CI systems that do not set CI (Jenkins, Azure Pipelines…), as ci-info reports them.
    expect(resolveEmulatorLaunchSettings({ headless: false }, {}, 'darwin', true).windowUnavailable).toBe('this is a CI build');
    expect(resolveEmulatorLaunchSettings(undefined, {}, 'darwin', true).headless).toBe(true);
    expect(resolveEmulatorLaunchSettings({ headless: false }, { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, 'darwin').windowUnavailable)
      .toBe('this is an SSH session');
    expect(resolveEmulatorLaunchSettings({ headless: false }, {}, 'linux').windowUnavailable)
      .toBe('no display is available');
  });
});

describe('emulatorLaunchArgs profiles', () => {
  it('keeps the headless profile exactly as CI has always run it', () => {
    expect(emulatorLaunchArgs('Pixel', 5554, { headless: true, args: [] })).toEqual([
      '-avd', 'Pixel', '-port', '5554', '-read-only',
      '-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim', '-no-audio',
      '-gpu', 'swiftshader_indirect', '-no-window',
    ]);
  });

  it('keeps the AVD’s own GPU mode and loads its snapshot, saving nothing, with a window', () => {
    const args = emulatorLaunchArgs('Pixel', 5554, { headless: false, args: [] });
    expect(args).toEqual([
      '-avd', 'Pixel', '-port', '5554', '-read-only',
      '-no-snapshot-save', '-no-boot-anim', '-no-audio',
    ]);
    expect(args).not.toContain('-gpu');
    expect(args).not.toContain('-no-window');
    expect(args).not.toContain('-no-snapshot-load');
  });

  it('appends the user args after Tapsmith’s own', () => {
    const args = emulatorLaunchArgs('Pixel', 5554, { headless: false, args: ['-memory', '4096'] });
    expect(args.slice(-2)).toEqual(['-memory', '4096']);
  });

  it('is recognised as Tapsmith’s in every profile, and so is the previous version’s argv', () => {
    for (const headless of [true, false]) {
      const argv = ['/sdk/qemu-system-aarch64', ...emulatorLaunchArgs('Pixel', 5554, { headless, args: ['-memory', '4096'] })];
      expect(isTapsmithLaunchedEmulator(argv, { port: 5554, avd: 'Pixel' })).toBe(true);
    }
    const previousVersion = ['/sdk/qemu-system-aarch64-headless', '-avd', 'Pixel', '-port', '5554', '-read-only',
      '-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim', '-no-audio', '-gpu', 'swiftshader_indirect', '-no-window'];
    expect(isTapsmithLaunchedEmulator(previousVersion, { port: 5554, avd: 'Pixel' })).toBe(true);
  });
});

describe('launchEmulator process and early exit', () => {
  const scripts: string[] = [];
  afterAll(() => {
    for (const file of scripts) fs.rmSync(file, { force: true });
  });

  /** A stand-in `emulator` that prints `output` and exits with `code`. */
  function fakeEmulator(output: string, code: number): string {
    const file = path.join(os.tmpdir(), `fake-emulator-${scripts.length}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\nexit ${code}\n`, { mode: 0o755 });
    scripts.push(file);
    return file;
  }

  it.skipIf(process.platform === 'win32')('captures the output and reports the writable-instance refusal by name', async () => {
    const emulator = fakeEmulator('ERROR        | Another emulator instance is running. Please close it or run all emulators with -read-only flag.', 1);
    const emu = launchEmulator('Pixel', 5590, { headless: true, args: [] }, emulator);
    const exit = await emu.exited;
    expect(exit).toEqual({ kind: 'exited', code: 1, signal: null });
    expect(fs.readFileSync(emu.logPath!, 'utf-8')).toContain('Another emulator instance is running');
    expect(describeEmulatorExit(exit, emu, { command: emulator, found: true, tried: [emulator] }))
      .toBe('AVD Pixel is already running without -read-only (opened from Android Studio, for example), '
        + 'and the emulator will not start a second instance beside it. Close that emulator, or point `avd` at another AVD.');
  });

  it('survives a later error event on a handle whose spawn failed', async () => {
    const emu = launchEmulator('Pixel', 5594, { headless: true, args: [] }, path.join(os.tmpdir(), 'no-such-dir', 'emulator'));
    await emu.exited;
    expect(() => emu.process.emit('error', new Error('kill EPERM'))).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('never writes its log through a planted symlink', async () => {
    const victim = path.join(os.tmpdir(), 'victim.txt');
    const logPath = path.join(os.tmpdir(), 'tapsmith-emulator-5596.log');
    fs.rmSync(logPath, { force: true });
    fs.symlinkSync(victim, logPath);
    fs.writeFileSync(victim, 'ERROR | Another emulator instance is running.');
    const emu = launchEmulator('Pixel', 5596, { headless: true, args: [] }, fakeEmulator('ERROR | boom', 1));
    const exit = await emu.exited;
    expect(fs.readFileSync(victim, 'utf-8')).toBe('ERROR | Another emulator instance is running.');
    // …and never quotes it back as this launch's output.
    expect(emu.logPath).toBeUndefined();
    expect(describeEmulatorExit(exit, emu, { command: 'x', found: true, tried: [] }))
      .toBe('The emulator exited during boot (exit code 1).');
  });

  it('reports a binary that cannot be spawned as not found, with the paths tried', async () => {
    const missing = path.join(os.tmpdir(), 'no-such-dir', 'emulator');
    const emu = launchEmulator('Pixel', 5592, { headless: true, args: [] }, missing);
    const exit = await emu.exited;
    expect(exit.kind).toBe('spawn-error');
    expect(describeEmulatorExit(exit, emu, { command: missing, found: false, tried: [missing, '`emulator` on PATH'] }))
      .toBe(emulatorNotFoundMessage([missing, '`emulator` on PATH']));
  });
});

describe('describeEmulatorExit', () => {
  const emu = { avd: 'Pixel', logPath: '/tmp/tapsmith-emulator-5554.log' };
  const bin = { command: '/sdk/emulator/emulator', found: true, tried: ['/sdk/emulator/emulator'] };
  const exited = { kind: 'exited', code: 1, signal: null } as const;

  it('quotes the emulator’s ERROR lines without their level prefix, and points at the log', () => {
    const log = [
      'INFO         | Android emulator version 36.6.11.0',
      'ERROR        | Unknown AVD name [Pixel], use -list-avds to see valid list.',
      'ERROR        | HOME is defined but there is no file Pixel.ini in $HOME/.android/avd',
      'INFO         | done',
    ].join('\n');
    expect(describeEmulatorExit(exited, emu, bin, () => log)).toBe(
      'The emulator exited during boot (exit code 1): Unknown AVD name [Pixel], use -list-avds to see valid list / '
      + 'HOME is defined but there is no file Pixel.ini in $HOME/.android/avd. Full output: /tmp/tapsmith-emulator-5554.log',
    );
  });

  it('does not take the multi-instance warning for the writable-instance refusal', () => {
    const log = [
      'WARNING      | Running multiple emulators with the same AVD is an experimental feature.',
      'ERROR        | Not enough memory to start the emulator.',
    ].join('\n');
    expect(describeEmulatorExit(exited, emu, bin, () => log))
      .toBe('The emulator exited during boot (exit code 1): Not enough memory to start the emulator. Full output: /tmp/tapsmith-emulator-5554.log');
  });

  it('falls back to the last lines, or to the exit alone', () => {
    const log = 'one\ntwo\nthree\nfour\n';
    expect(describeEmulatorExit({ kind: 'exited', code: null, signal: 'SIGKILL' }, emu, bin, () => log))
      .toBe('The emulator exited during boot (signal SIGKILL): two / three / four. Full output: /tmp/tapsmith-emulator-5554.log');
    expect(describeEmulatorExit(exited, emu, bin, () => { throw new Error('ENOENT'); }))
      .toBe('The emulator exited during boot (exit code 1). Full output: /tmp/tapsmith-emulator-5554.log');
  });

  it('names a spawn failure other than not-found', () => {
    const error = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    expect(describeEmulatorExit({ kind: 'spawn-error', error }, emu, bin))
      .toBe('Could not start the Android emulator (/sdk/emulator/emulator): spawn EACCES');
  });
});

describe('provisionEmulators launch failures', () => {
  const base = {
    listAdbDevices: () => [],
    listAvds: () => ['Pixel'],
    getRunningAvdName: () => undefined,
    probeDeviceHealth: (serial: string) => ({ serial, healthy: true }),
    waitForDeviceStability: async (serial: string) => ({ serial, healthy: true }),
  };

  it('stops before listing AVDs when the emulator binary is not found', async () => {
    const listAvds = vi.fn(() => ['Pixel']);
    const launch = vi.fn();
    await expect(provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
      {
        ...base,
        resolveEmulatorBinary: () => ({ command: 'emulator', found: false, tried: ['/sdk/emulator/emulator', '`emulator` on PATH'] }),
        listAvds,
        launchEmulator: launch,
      },
    )).rejects.toThrow(emulatorNotFoundMessage(['/sdk/emulator/emulator', '`emulator` on PATH']));
    expect(listAvds).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails an emulator that exits during boot at once, with its reason, without killing by serial', async () => {
    const warnings: string[] = [];
    const killEmulator = vi.fn();
    let bootSignal: AbortSignal | undefined;
    const emu = makeLaunchedEmulator('Pixel', 5554, Promise.resolve({ kind: 'spawn-error', error: Object.assign(new Error('spawn emulator ENOENT'), { code: 'ENOENT' }) }));
    const started = Date.now();
    const result = await provisionEmulators(
      {
        existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined,
        onProgress: (message, level) => { if (level === 'warning') warnings.push(message); },
      },
      {
        ...base,
        resolveEmulatorBinary: () => ({ command: '/sdk/emulator/emulator', found: true, tried: ['/sdk/emulator/emulator'] }),
        launchEmulator: () => emu,
        // A boot wait that would run for the whole timeout unless aborted.
        waitForBoot: (_serial, _timeout, signal) => new Promise((_resolve, reject) => {
          bootSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
        killEmulator,
      },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.launched).toEqual([]);
    expect(warnings[0]).toBe(`Skipping launched emulator emulator-5554 (Pixel): ${emulatorNotFoundMessage(['/sdk/emulator/emulator']).replace(/\.$/, '')}.`);
    expect(bootSignal?.aborted).toBe(true);
    expect(killEmulator).not.toHaveBeenCalled();
    expect(emu.process.kill).not.toHaveBeenCalled();
  });

  it('stops probing once the emulator has exited, even if the boot wait then returns', async () => {
    let exit!: (value: import('../emulator.js').EmulatorExit) => void;
    const emu = makeLaunchedEmulator('Pixel', 5554, new Promise((resolve) => { exit = resolve; }));
    const waitForDeviceStability = vi.fn(async (serial: string) => ({ serial, healthy: true }));
    let bootReturned!: () => void;
    const bootDone = new Promise<void>((resolve) => { bootReturned = resolve; });
    const result = await provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
      {
        ...base,
        resolveEmulatorBinary: foundEmulator,
        launchEmulator: () => emu,
        // The emulator dies during the post-boot settle, which then returns.
        waitForBoot: async () => {
          exit({ kind: 'exited', code: null, signal: 'SIGSEGV' });
          await new Promise((resolve) => setTimeout(resolve, 20));
          bootReturned();
        },
        waitForDeviceStability,
        killEmulator: vi.fn(),
      },
    );
    await bootDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.launched).toEqual([]);
    expect(waitForDeviceStability).not.toHaveBeenCalled();
  });

  it('keeps waiting when the launcher exits cleanly during boot (a wrapper that backgrounds the emulator)', async () => {
    const emu = makeLaunchedEmulator('Pixel', 5554, Promise.resolve({ kind: 'exited', code: 0, signal: null }));
    const result = await provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
      {
        ...base,
        resolveEmulatorBinary: foundEmulator,
        launchEmulator: () => emu,
        waitForBoot: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); },
        killEmulator: vi.fn(),
        findEmulatorPid: () => 777,
      },
    );
    expect(result.allSerials).toEqual(['emulator-5554']);
  });

  it('fails a clean exit during boot when nothing holds the console port (the window was closed)', async () => {
    vi.useFakeTimers();
    try {
      const warnings: string[] = [];
      const killEmulator = vi.fn();
      const emu = makeLaunchedEmulator('Pixel', 5554, Promise.resolve({ kind: 'exited', code: 0, signal: null }));
      const provision = provisionEmulators(
        {
          existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined,
          onProgress: (message, level) => { if (level === 'warning') warnings.push(message); },
        },
        {
          ...base,
          resolveEmulatorBinary: foundEmulator,
          launchEmulator: () => emu,
          // Would run the whole boot timeout unless aborted.
          waitForBoot: (_serial, _timeout, signal) => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
          killEmulator,
          findEmulatorPid: () => undefined,
        },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await provision;
      expect(result.launched).toEqual([]);
      expect(warnings[0]).toContain('The emulator exited during boot (exit code 0)');
      expect(killEmulator).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an emulator that boots, even if its process ends later', async () => {
    let exit!: (value: import('../emulator.js').EmulatorExit) => void;
    const emu = makeLaunchedEmulator('Pixel', 5554, new Promise((resolve) => { exit = resolve; }));
    let bootSignal: AbortSignal | undefined;
    const result = await provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
      {
        ...base,
        resolveEmulatorBinary: foundEmulator,
        launchEmulator: () => emu,
        waitForBoot: async (_serial, _timeout, signal) => { bootSignal = signal; },
        killEmulator: vi.fn(),
      },
    );
    exit({ kind: 'exited', code: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(result.allSerials).toEqual(['emulator-5554']);
    expect(bootSignal?.aborted).toBe(true); // the wait is released once it is no longer needed
  });

  it('remembers every emulator it launched for the end-of-run notice, and none that failed', async () => {
    const good = makeLaunchedEmulator('Pixel', 5570);
    const bad = makeLaunchedEmulator('Pixel', 5572);
    let launches = 0;
    await provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
      { ...base, resolveEmulatorBinary: foundEmulator, launchEmulator: () => (launches++ === 0 ? good : bad),
        waitForBoot: async () => undefined, killEmulator: vi.fn() },
    );
    await provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined },
      { ...base, resolveEmulatorBinary: foundEmulator, launchEmulator: () => bad,
        waitForBoot: async () => { throw new Error('boot timed out'); }, killEmulator: vi.fn() },
    );
    const serials = emulatorsLaunchedThisProcess().map((emu) => emu.serial);
    expect(serials).toContain('emulator-5570');
    expect(serials).not.toContain('emulator-5572');
  });

  it('does not call an emulator from this run one "from previous run"', () => {
    // emulator-5570 was launched by this process in the test above.
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = reclaimOrphanedEmulators({
        readManifest: () => [{ serial: 'emulator-5570', pid: 4242, avd: 'Pixel', port: 5570, launchedAt: '' }],
        writeManifest: () => undefined,
        listAdbDevices: () => [{ serial: 'emulator-5570', state: 'device' }],
        isProcessAlive: () => true,
        readProcessArgs: () => ['/sdk/qemu', ...emulatorLaunchArgs('Pixel', 5570, { headless: false, args: [] })],
        findEmulatorPid: () => 4242,
        probeDeviceHealth: (serial) => ({ serial, healthy: true }),
        killEmulator: vi.fn(),
        killProcess: vi.fn(),
      });
      expect(result.reusable).toEqual(['emulator-5570']);
      expect(String(write.mock.calls[0]?.[0])).toContain('Reusing emulator emulator-5570 (AVD Pixel, with a window), launched earlier in this run.');
    } finally {
      write.mockRestore();
    }
  });

  it('passes the resolved launch settings and binary to the launch', async () => {
    const launches: Array<{ settings: unknown, emulator: string }> = [];
    await provisionEmulators(
      { existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: { headless: true, args: ['-memory', '4096'] } },
      {
        ...base,
        resolveEmulatorBinary: foundEmulator,
        launchEmulator: (avd, port, settings, emulator) => {
          launches.push({ settings, emulator });
          return makeLaunchedEmulator(avd, port);
        },
        waitForBoot: async () => undefined,
        killEmulator: vi.fn(),
      },
    );
    expect(launches).toEqual([{ settings: { headless: true, args: ['-memory', '4096'] }, emulator: '/sdk/emulator/emulator' }]);
  });

  it('says why the default launch is headless, without a warning about it', async () => {
    vi.stubEnv('CI', 'true');
    try {
      const warnings: string[] = [];
      const info: string[] = [];
      await provisionEmulators(
        {
          existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: undefined,
          onProgress: (message, level) => { (level === 'warning' ? warnings : info).push(message); },
        },
        {
          ...base,
          resolveEmulatorBinary: foundEmulator,
          launchEmulator: (avd, port) => makeLaunchedEmulator(avd, port),
          waitForBoot: async () => undefined,
          killEmulator: vi.fn(),
        },
      );
      expect(info).toContain('Starting emulator-5554 (port 5554, AVD Pixel, headless: this is a CI build)');
      expect(warnings).toEqual(['emulator-5554 stays running after the run for faster reruns. Stop it with: adb -s emulator-5554 emu kill']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('warns when a requested window cannot be shown, and launches headless', async () => {
    vi.stubEnv('CI', 'true');
    try {
      const warnings: string[] = [];
      const headless: boolean[] = [];
      await provisionEmulators(
        {
          existingSerials: [], workers: 1, avd: 'Pixel', launchOptions: { headless: false },
          onProgress: (message, level) => { if (level === 'warning') warnings.push(message); },
        },
        {
          ...base,
          resolveEmulatorBinary: foundEmulator,
          launchEmulator: (avd, port, settings) => {
            headless.push(settings.headless);
            return makeLaunchedEmulator(avd, port);
          },
          waitForBoot: async () => undefined,
          killEmulator: vi.fn(),
        },
      );
      expect(headless).toEqual([true]);
      expect(warnings).toEqual([
        'Launching emulators headless although emulatorLaunchOptions.headless is false: this is a CI build.',
        'emulator-5554 stays running after the run for faster reruns. Stop it with: adb -s emulator-5554 emu kill',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('preserveEmulatorsForReuse', () => {
  it('names each emulator it leaves running, and how to stop it', () => {
    const lines: string[] = [];
    preserveEmulatorsForReuse(
      [makeLaunchedEmulator('Medium_Phone_API_36', 5554), { ...makeLaunchedEmulator('Pixel', 5556), headless: false }],
      (text) => lines.push(text),
    );
    expect(lines.map((line) => line.replace(/\x1b\[\d+m/g, ''))).toEqual([
      'Left emulator-5554 (AVD Medium_Phone_API_36, headless) running for faster reruns. Stop it with: adb -s emulator-5554 emu kill\n',
      'Left emulator-5556 (AVD Pixel) running for faster reruns. Stop it with: adb -s emulator-5556 emu kill\n',
    ]);
  });

  it('does not claim an emulator that has exited is still running', () => {
    const lines: string[] = [];
    const closed = makeLaunchedEmulator('Pixel', 5554);
    Object.assign(closed.process, { exitCode: 0 });
    const crashed = makeLaunchedEmulator('Pixel', 5556);
    Object.assign(crashed.process, { exitCode: null, signalCode: 'SIGSEGV' });
    preserveEmulatorsForReuse([closed, crashed, makeLaunchedEmulator('Pixel', 5558)], (text) => lines.push(text));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('emulator-5558');
  });

  it('names an emulator once, however many teardown paths reach it', () => {
    const lines: string[] = [];
    const emu = makeLaunchedEmulator('Pixel', 5560);
    preserveEmulatorsForReuse([emu], (text) => lines.push(text));
    preserveEmulatorsForReuse([emu], (text) => lines.push(text));
    expect(lines).toHaveLength(1);
  });

  it('says nothing when it launched nothing', () => {
    const write = vi.fn();
    preserveEmulatorsForReuse([], write);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('boot waits stop when aborted', () => {
  it('waitForBoot rejects at once for an aborted signal, without polling out its timeout', async () => {
    const started = Date.now();
    await expect(waitForBoot('emulator-5998', 60_000, AbortSignal.abort())).rejects.toThrow('Stopped waiting for emulator-5998 to boot');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('waitForBoot stops a pending adb call when aborted mid-wait', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const wait = waitForBoot('emulator-5998', 60_000, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(wait).rejects.toThrow('Stopped waiting');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('waitForSystemSettle and waitForDeviceStability do no work once aborted', async () => {
    const exec = vi.fn(() => '') as unknown as typeof import('node:child_process').execFileSync;
    await waitForSystemSettle('emulator-5998', 30_000, exec, AbortSignal.abort());
    expect(exec).not.toHaveBeenCalled();
    const probe = vi.fn((serial: string) => ({ serial, healthy: true }));
    await waitForDeviceStability('emulator-5998', 20_000, probe, AbortSignal.abort());
    expect(probe).not.toHaveBeenCalled();
  });
});


// PILOT-457: the test-run paths split each line on whitespace and kept the
// second word, so `no permissions (…)` read as "no" and got no advice.
describe('listAdbDevices', () => {
  const adb = (stdout: string) => vi.fn(() => stdout) as unknown as typeof import('node:child_process').execFileSync;

  it('keeps the whole adb state, multi-word ones included', () => {
    const exec = adb([
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554\tdevice',
      'R5CR1234XYZ\tunauthorized',
      '0123456789ABCDEF\tno permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
      '',
    ].join('\n'));
    expect(listAdbDevices(exec)).toEqual([
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'R5CR1234XYZ', state: 'unauthorized' },
      {
        serial: '0123456789ABCDEF',
        state: 'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]',
      },
    ]);
  });

  it('is empty when adb cannot be run', () => {
    const exec = vi.fn(() => { throw new Error('spawn adb ENOENT'); }) as unknown as typeof import('node:child_process').execFileSync;
    expect(listAdbDevices(exec)).toEqual([]);
  });
});
