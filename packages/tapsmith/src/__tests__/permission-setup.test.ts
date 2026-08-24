import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  notificationPermissionForAgent,
  NO_PACKAGE_WARNING,
  PHYSICAL_IOS_WARNING,
  applyAndroidNotificationPermission,
  applySimulatorNotificationPermissionSetup,
  reapplyAndroidNotificationPermissionAfterClear,
  type PermissionSetupLog,
} from '../permission-setup.js';
import {
  ensureSimulatorNotificationPermissionState,
  readNotificationAuthorizationStatus,
} from '../ios-notification-state.js';

vi.mock('../ios-devicectl.js', () => ({
  isPhysicalDevice: (serial: string) => serial.startsWith('physical'),
}));

vi.mock('../ios-notification-state.js', () => ({
  readNotificationAuthorizationStatus: vi.fn(() => 'denied'),
  needsNotificationReset: vi.fn(() => true),
  ensureSimulatorNotificationPermissionState: vi.fn(() => true),
}));

function collectingLog(): PermissionSetupLog & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (m: string) => infos.push(m),
    warn: (m: string) => warns.push(m),
  };
}

describe('notificationPermissionForAgent', () => {
  let log: ReturnType<typeof collectingLog>;
  beforeEach(() => { log = collectingLog(); });

  it('returns the policy for an iOS simulator serial', async () => {
    const result = await notificationPermissionForAgent(
      { platform: 'ios', permissions: { notifications: 'denied' } },
      'SIM-UDID-1234',
      log,
    );
    expect(result).toBe('denied');
    expect(log.warns).toEqual([]);
  });

  it('warns and skips on a physical iOS device', async () => {
    const result = await notificationPermissionForAgent(
      { platform: 'ios', permissions: { notifications: 'denied' } },
      'physical-serial',
      log,
    );
    expect(result).toBeUndefined();
    expect(log.warns).toEqual([PHYSICAL_IOS_WARNING]);
  });

  it('warns and skips when the device serial is unknown', async () => {
    // e.g. an MCP discovery path attaching to an existing daemon — the
    // policy must never be applied blind to an unidentified device.
    const result = await notificationPermissionForAgent(
      { platform: 'ios', permissions: { notifications: 'granted' } },
      undefined,
      log,
    );
    expect(result).toBeUndefined();
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toMatch(/device is unknown/);
  });

  it('is silently undefined for Android and for unset policies', async () => {
    expect(await notificationPermissionForAgent(
      { platform: 'android', permissions: { notifications: 'granted' } }, 'emulator-5554', log,
    )).toBeUndefined();
    expect(await notificationPermissionForAgent(
      { platform: 'ios' }, 'SIM-UDID-1234', log,
    )).toBeUndefined();
    expect(log.warns).toEqual([]);
  });
});

describe('applySimulatorNotificationPermissionSetup', () => {
  const iosConfig = {
    platform: 'ios' as const,
    package: 'com.example.app',
    app: './App.app',
    permissions: { notifications: 'granted' as const },
  };
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips physical devices without touching the notification store', async () => {
    // The guard lives inside the helper so no caller can drift on it. The
    // skip is silent: notificationPermissionForAgent owns the warning.
    const log = collectingLog();
    const result = await applySimulatorNotificationPermissionSetup('physical-serial', iosConfig, log);
    expect(result).toBe(false);
    expect(vi.mocked(readNotificationAuthorizationStatus)).not.toHaveBeenCalled();
    expect(log.warns).toEqual([]);
  });

  it('uninstalls on conflict for a simulator', async () => {
    const log = collectingLog();
    const result = await applySimulatorNotificationPermissionSetup('SIM-UDID-1234', iosConfig, log);
    expect(result).toBe(true);
    expect(vi.mocked(ensureSimulatorNotificationPermissionState))
      .toHaveBeenCalledWith('SIM-UDID-1234', 'com.example.app', 'granted', 'denied');
    expect(log.infos).toHaveLength(1);
  });

  it('is a no-op when no policy is configured', async () => {
    const log = collectingLog();
    const result = await applySimulatorNotificationPermissionSetup(
      'SIM-UDID-1234', { platform: 'ios', package: 'com.example.app', app: './App.app' }, log,
    );
    expect(result).toBe(false);
    expect(vi.mocked(readNotificationAuthorizationStatus)).not.toHaveBeenCalled();
  });
});

describe('applyAndroidNotificationPermission', () => {
  it('applies the state via the device RPC', async () => {
    const log = collectingLog();
    const setNotificationPermission = vi.fn(async () => {});
    await applyAndroidNotificationPermission(
      { setNotificationPermission },
      { platform: 'android', package: 'com.example.app', permissions: { notifications: 'prompt' } },
      log,
    );
    expect(setNotificationPermission).toHaveBeenCalledWith('com.example.app', 'prompt');
    expect(log.infos).toHaveLength(1);
  });

  it('warns and skips without a package', async () => {
    const log = collectingLog();
    const setNotificationPermission = vi.fn(async () => {});
    await applyAndroidNotificationPermission(
      { setNotificationPermission },
      { platform: 'android', permissions: { notifications: 'granted' } },
      log,
    );
    expect(setNotificationPermission).not.toHaveBeenCalled();
    expect(log.warns).toEqual([NO_PACKAGE_WARNING]);
  });

  it('is a no-op on iOS and for unset policies', async () => {
    const log = collectingLog();
    const setNotificationPermission = vi.fn(async () => {});
    await applyAndroidNotificationPermission(
      { setNotificationPermission },
      { platform: 'ios', package: 'com.example.app', permissions: { notifications: 'granted' } },
      log,
    );
    await applyAndroidNotificationPermission(
      { setNotificationPermission },
      { platform: 'android', package: 'com.example.app' },
      log,
    );
    expect(setNotificationPermission).not.toHaveBeenCalled();
    expect(log.warns).toEqual([]);
  });
});

describe('reapplyAndroidNotificationPermissionAfterClear', () => {
  let log: ReturnType<typeof collectingLog>;
  beforeEach(() => { log = collectingLog(); });

  const config = { platform: 'android' as const, package: 'com.example.app', permissions: { notifications: 'granted' as const } };

  it('applies once when the device cooperates', async () => {
    const setNotificationPermission = vi.fn(async () => {});
    await reapplyAndroidNotificationPermissionAfterClear({ setNotificationPermission }, config, log);
    expect(setNotificationPermission).toHaveBeenCalledTimes(1);
    expect(setNotificationPermission).toHaveBeenCalledWith('com.example.app', 'granted');
    expect(log.warns).toEqual([]);
  });

  it('absorbs a single transient failure by retrying', async () => {
    // `pm` can transiently fail while re-indexing right after `pm clear`;
    // aborting the whole suite for that would be a worse trade than a retry.
    const setNotificationPermission = vi.fn()
      .mockRejectedValueOnce(new Error('Failure calling service package'))
      .mockResolvedValueOnce(undefined);
    await reapplyAndroidNotificationPermissionAfterClear({ setNotificationPermission }, config, log);
    expect(setNotificationPermission).toHaveBeenCalledTimes(2);
    expect(log.warns.join('\n')).toMatch(/retrying once/);
  });

  it('reports a persistent failure rather than running on in the wrong state', async () => {
    const setNotificationPermission = vi.fn(async () => { throw new Error('Unknown package: com.example.app'); });
    await expect(
      reapplyAndroidNotificationPermissionAfterClear({ setNotificationPermission }, config, log),
    ).rejects.toThrow(/permissions\.notifications: could not restore 'granted' after clearing app data/);
    expect(setNotificationPermission).toHaveBeenCalledTimes(2);
  });

  it('does nothing on iOS or when permissions is unset', async () => {
    const setNotificationPermission = vi.fn(async () => {});
    await reapplyAndroidNotificationPermissionAfterClear(
      { setNotificationPermission }, { ...config, platform: 'ios' }, log,
    );
    await reapplyAndroidNotificationPermissionAfterClear(
      { setNotificationPermission }, { platform: 'android', package: 'com.example.app' }, log,
    );
    expect(setNotificationPermission).not.toHaveBeenCalled();
  });
});
