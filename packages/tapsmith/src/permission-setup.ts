/**
 * Session-setup application of `permissions.notifications` (PILOT-291).
 *
 * Single source of truth for the sequential CLI, parallel workers, and the
 * UI-mode worker, so the platform guards and warnings cannot drift between
 * paths. Each entry point applies the same three pieces:
 *
 * - iOS simulator: reset the recorded state by uninstalling on conflict
 *   (`applySimulatorNotificationPermissionSetup`) before the app install.
 * - iOS: hand the policy to StartAgent (`notificationPermissionForAgent`)
 *   so the agent answers the one-shot prompt accordingly.
 * - Android: apply the state via the daemon RPC
 *   (`applyAndroidNotificationPermission`) after the app install.
 */

import type { Device } from './device.js';
import type { NotificationPermissionState } from './config.js';
import {
  ensureSimulatorNotificationPermissionState,
  needsNotificationReset,
  readNotificationAuthorizationStatus,
} from './ios-notification-state.js';

/** The config slice permission setup needs. */
export interface PermissionSetupConfig {
  platform?: 'android' | 'ios';
  package?: string;
  app?: string;
  permissions?: { notifications?: NotificationPermissionState };
}

/** Message sink: `info` for progress detail, `warn` for skipped setup. */
export interface PermissionSetupLog {
  info(message: string): void;
  warn(message: string): void;
}

export const NO_PACKAGE_WARNING =
  'permissions.notifications is set but no `package` is configured; skipping notification permission setup.';
export const PHYSICAL_IOS_WARNING =
  'permissions.notifications is not supported on physical iOS devices; skipping.';

/**
 * The policy to pass to StartAgent — the iOS agent answers the one-shot
 * notification prompt per this value. Performs the physical-device check
 * itself from the serial so no caller can drift on the guard. Returns
 * undefined (and warns, when a log is given) on physical iOS, where the
 * setting is unsupported, and when the device cannot be identified; Android
 * and unset configs return undefined silently. Pass a log only at initial
 * session setup — recovery paths reuse the resolved value without
 * re-warning.
 */
export async function notificationPermissionForAgent(
  config: PermissionSetupConfig,
  deviceSerial: string | undefined,
  log?: PermissionSetupLog,
): Promise<NotificationPermissionState | undefined> {
  if (config.platform !== 'ios' || !config.permissions?.notifications) return undefined;
  if (!deviceSerial) {
    log?.warn(
      'permissions.notifications is set but the target iOS device is unknown, so it cannot '
      + 'be checked for physical-device support; skipping the notification permission policy.',
    );
    return undefined;
  }
  const { isPhysicalDevice } = await import('./ios-devicectl.js');
  if (isPhysicalDevice(deviceSerial)) {
    log?.warn(PHYSICAL_IOS_WARNING);
    return undefined;
  }
  return config.permissions.notifications;
}

/**
 * iOS-simulator pre-install reset: uninstall the app when its recorded
 * notification state conflicts with the configured target, so the caller's
 * (re)install returns it to notDetermined for the agent to answer per
 * policy. Returns true when an uninstall happened (the install flow must
 * then reinstall).
 *
 * Without an `app` path there is nothing to reinstall from, so no uninstall
 * happens; a recorded conflict is surfaced as a warning instead of running
 * the session against the wrong state.
 *
 * Performs the physical-device check itself so no caller can drift on the
 * guard. Physical iOS is skipped silently: every setup flow pairs this call
 * with `notificationPermissionForAgent`, which owns the user-facing
 * PHYSICAL_IOS_WARNING — warning here as well would print it twice.
 */
export async function applySimulatorNotificationPermissionSetup(
  udid: string,
  config: PermissionSetupConfig,
  log: PermissionSetupLog,
): Promise<boolean> {
  const target = config.permissions?.notifications;
  if (!target) return false;
  const { isPhysicalDevice } = await import('./ios-devicectl.js');
  if (isPhysicalDevice(udid)) return false;
  if (!config.package) {
    log.warn(NO_PACKAGE_WARNING);
    return false;
  }
  const status = readNotificationAuthorizationStatus(udid, config.package);
  if (!config.app) {
    if (needsNotificationReset(status, target)) {
      log.warn(
        `permissions.notifications: '${target}' requested but the recorded state is '${status}' `
        + 'and no `app` path is configured to reinstall from — the permission state cannot be reset.',
      );
    }
    return false;
  }
  if (status === 'unknown') {
    // The reset below still runs (determinism is the point of the setting),
    // but an unreadable store deserves an explanation: if this repeats on
    // every run, the BulletinBoard format may be unsupported and each
    // session is paying an app-data-wiping reinstall.
    log.warn(
      'recorded notification state could not be read; resetting by reinstall. '
      + 'If this warning appears on every run, the simulator\'s notification '
      + 'store is unreadable and each session will reinstall the app.',
    );
  }
  if (ensureSimulatorNotificationPermissionState(udid, config.package, target, status)) {
    log.info(`reinstalling to reset notification permission (target: ${target})`);
    return true;
  }
  return false;
}

/**
 * Android: apply the configured state via the daemon RPC (`pm`/`appops`).
 * Call after the app install — `pm grant` needs the package present.
 */
export async function applyAndroidNotificationPermission(
  device: Pick<Device, 'setNotificationPermission'>,
  config: PermissionSetupConfig,
  log: PermissionSetupLog,
): Promise<void> {
  const target = config.permissions?.notifications;
  if (config.platform === 'ios' || !target) return;
  if (!config.package) {
    log.warn(NO_PACKAGE_WARNING);
    return;
  }
  await device.setNotificationPermission(config.package, target);
  log.info(`notification permission set to '${target}' for ${config.package}`);
}

/** How long to wait before the single re-apply retry (package-manager settle). */
const REAPPLY_RETRY_DELAY_MS = 500;

/**
 * Re-apply the configured notification permission after `clearAppData`.
 *
 * `pm clear` resets runtime permission grants *and* user-set flags, so every
 * app-data reset drops what session setup established. This runs mid-suite,
 * against a device that has just been put through a package-manager reset —
 * where `pm` can transiently fail ("Failure calling service package") while
 * it re-indexes. Aborting the whole run on that would be a worse trade than
 * one retry.
 *
 * A second failure does propagate: the remaining tests would otherwise run
 * in the opposite notification state to the configured one, and failing
 * loudly beats failing mysteriously several tests later.
 *
 * Both post-clear call sites use this rather than calling
 * `applyAndroidNotificationPermission` directly, so the retry-and-report
 * semantics can't drift between them.
 */
export async function reapplyAndroidNotificationPermissionAfterClear(
  device: Pick<Device, 'setNotificationPermission'>,
  config: PermissionSetupConfig,
  log: PermissionSetupLog,
): Promise<void> {
  if (config.platform === 'ios' || !config.permissions?.notifications) return;
  try {
    await applyAndroidNotificationPermission(device, config, log);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      `could not re-apply the notification permission after the app-data reset (${msg}); `
      + 'retrying once',
    );
  }
  await new Promise((resolve) => setTimeout(resolve, REAPPLY_RETRY_DELAY_MS));
  try {
    await applyAndroidNotificationPermission(device, config, log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `permissions.notifications: could not restore '${config.permissions.notifications}' after `
      + `clearing app data${config.package ? ` for ${config.package}` : ''}, so the remaining `
      + `tests would run in the wrong notification state. Cause: ${msg}`,
    );
  }
}
