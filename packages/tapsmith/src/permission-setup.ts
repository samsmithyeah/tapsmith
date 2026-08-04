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
 * notification prompt per this value. Returns undefined (and warns, when a
 * log is given) on physical iOS, where the setting is unsupported; Android
 * and unset configs return undefined silently. Pass a log only at initial
 * session setup — recovery paths reuse the value without re-warning.
 */
export function notificationPermissionForAgent(
  config: PermissionSetupConfig,
  isPhysicalIos: boolean,
  log?: PermissionSetupLog,
): NotificationPermissionState | undefined {
  if (config.platform !== 'ios' || !config.permissions?.notifications) return undefined;
  if (isPhysicalIos) {
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
 */
export function applySimulatorNotificationPermissionSetup(
  udid: string,
  config: PermissionSetupConfig,
  log: PermissionSetupLog,
): boolean {
  const target = config.permissions?.notifications;
  if (!target) return false;
  if (!config.package) {
    log.warn(NO_PACKAGE_WARNING);
    return false;
  }
  if (!config.app) {
    const status = readNotificationAuthorizationStatus(udid, config.package);
    if (needsNotificationReset(status, target)) {
      log.warn(
        `permissions.notifications: '${target}' requested but the recorded state is '${status}' `
        + 'and no `app` path is configured to reinstall from — the permission state cannot be reset.',
      );
    }
    return false;
  }
  if (ensureSimulatorNotificationPermissionState(udid, config.package, target)) {
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
