/**
 * Deterministic notification permission state for iOS simulators (PILOT-291).
 *
 * iOS notification authorization is not scriptable while the simulator is
 * booted: `simctl privacy` has no `notifications` service, and SpringBoard
 * rewrites its BulletinBoard store on exit, so editing it in place requires
 * a shutdown. What IS reliable while booted:
 *
 * - Reading the recorded state from
 *   `<device>/data/Library/BulletinBoard/VersionedSectionInfo.plist`, which
 *   maps bundle id → keyed-archived `BBSectionInfo` whose
 *   `BBSectionInfoSettings.authorizationStatus` holds the
 *   `UNAuthorizationStatus` raw value (0 = notDetermined, 1 = denied,
 *   2 = authorized).
 * - Uninstalling the app, which clears its BulletinBoard section and returns
 *   the permission to notDetermined, so the one-shot prompt shows again.
 *
 * Session setup combines the two: read the state, and only when it
 * conflicts with the configured target uninstall the app (the normal
 * install flow reinstalls it immediately after). The prompt that then
 * appears at first request is answered by the agent's interruption monitor
 * according to the same configured policy (see SystemDialogPolicy in the
 * iOS agent).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import bplist from 'bplist-parser';
import * as plist from 'plist';
import { isAppInstalled } from './ios-simulator.js';
import type { NotificationPermissionState } from './config.js';

export type NotificationAuthorizationStatus =
  | 'notDetermined'
  | 'denied'
  | 'authorized'
  | 'unknown';

const BINARY_PLIST_MAGIC = 'bplist00';

interface SimulatorDataRoot {
  dataPath: string;
  /** True when `simctl list` itself reported this path for the udid. A
   * guessed default-location path proves nothing when files are missing. */
  authoritative: boolean;
}

const dataRootCache = new Map<string, SimulatorDataRoot>();

/**
 * The simulator's data root. Asks `simctl list` (whose `dataPath` is
 * authoritative and covers non-default device sets) and falls back to the
 * default CoreSimulator location when the lookup fails or doesn't know the
 * udid. Cached per udid — the location cannot change while a device exists.
 */
function simulatorDataRoot(udid: string): SimulatorDataRoot {
  const cached = dataRootCache.get(udid);
  if (cached) return cached;
  let resolved: SimulatorDataRoot | undefined;
  try {
    const json = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const parsed = JSON.parse(json) as {
      devices?: Record<string, Array<{ udid?: string; dataPath?: string }>>;
    };
    for (const runtimeDevices of Object.values(parsed.devices ?? {})) {
      for (const device of runtimeDevices) {
        if (device.udid === udid && device.dataPath) {
          resolved = { dataPath: device.dataPath, authoritative: true };
        }
      }
    }
  } catch {
    // Fall through to the default location.
  }
  resolved ??= {
    dataPath: path.join(
      os.homedir(),
      'Library/Developer/CoreSimulator/Devices',
      udid,
      'data',
    ),
    authoritative: false,
  };
  dataRootCache.set(udid, resolved);
  return resolved;
}

/**
 * Parse the raw bytes of a VersionedSectionInfo.plist and extract the
 * recorded authorization status for `bundleId`. Exported for tests.
 *
 * A missing section means iOS has never recorded a decision for that bundle
 * id — i.e. notDetermined. 'unknown' means the file didn't match the
 * expected shape; callers should treat it as "state cannot be trusted".
 */
export function parseNotificationAuthorizationStatus(
  raw: Buffer,
  bundleId: string,
): NotificationAuthorizationStatus {
  let outer: unknown;
  if (raw.subarray(0, BINARY_PLIST_MAGIC.length).toString('latin1') === BINARY_PLIST_MAGIC) {
    outer = bplist.parseBuffer(raw)[0];
  } else {
    outer = plist.parse(raw.toString('utf8'));
  }
  if (typeof outer !== 'object' || outer === null) return 'unknown';

  const sectionInfo = (outer as Record<string, unknown>).sectionInfo;
  if (typeof sectionInfo !== 'object' || sectionInfo === null) return 'unknown';

  const blob = (sectionInfo as Record<string, unknown>)[bundleId];
  if (blob === undefined) return 'notDetermined';
  // The XML parser yields Uint8Array for <data>, the binary parser Buffer.
  if (!(blob instanceof Uint8Array)) return 'unknown';

  // The blob is an NSKeyedArchiver archive. Exactly one archived object —
  // the BBSectionInfoSettings — carries a numeric `authorizationStatus`.
  const archive = bplist.parseBuffer(Buffer.from(blob))[0] as Record<string, unknown> | undefined;
  const objects = archive?.['$objects'];
  if (!Array.isArray(objects)) return 'unknown';
  for (const obj of objects) {
    if (typeof obj !== 'object' || obj === null) continue;
    const status = (obj as Record<string, unknown>).authorizationStatus;
    if (typeof status === 'number') {
      if (status === 0) return 'notDetermined';
      if (status === 1) return 'denied';
      // 2 = authorized; 3 = provisional (quiet delivery) and 4 = ephemeral
      // (App Clips) are both forms of granted authorization — no reset is
      // needed to reach 'granted', and they conflict with 'denied'/'prompt'
      // exactly like a full grant.
      if (status === 2 || status === 3 || status === 4) return 'authorized';
      return 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Read the recorded notification authorization status for an app on a
 * simulator. Never throws — unreadable state reports as 'unknown'.
 */
export function readNotificationAuthorizationStatus(
  udid: string,
  bundleId: string,
): NotificationAuthorizationStatus {
  const root = simulatorDataRoot(udid);
  const plistPath = path.join(root.dataPath, 'Library/BulletinBoard/VersionedSectionInfo.plist');
  try {
    if (!fs.existsSync(plistPath)) {
      // A verified data root with no BulletinBoard store means nothing has
      // ever requested notification authorization on this simulator. A
      // guessed root (simctl didn't know the udid — e.g. a custom device
      // set) proves nothing, and reporting notDetermined would silently
      // skip a required reset.
      return root.authoritative ? 'notDetermined' : 'unknown';
    }
    return parseNotificationAuthorizationStatus(fs.readFileSync(plistPath), bundleId);
  } catch {
    return 'unknown';
  }
}

/**
 * Whether the recorded state conflicts with the configured target and the
 * app must be reinstalled to get back to notDetermined. Exported for tests.
 *
 * - granted: notDetermined is fine — the agent accepts the prompt when the
 *   app asks. Only a recorded denial needs the reset.
 * - denied: symmetric — the agent declines the prompt, so only a recorded
 *   grant needs the reset.
 * - prompt: any recorded decision needs the reset.
 * - 'unknown' always resets: determinism is the whole point of the setting.
 */
export function needsNotificationReset(
  status: NotificationAuthorizationStatus,
  target: NotificationPermissionState,
): boolean {
  switch (target) {
    case 'granted':
      return status === 'denied' || status === 'unknown';
    case 'denied':
      return status === 'authorized' || status === 'unknown';
    case 'prompt':
      return status !== 'notDetermined';
    default:
      throw new Error(
        `Invalid permissions.notifications value: ${JSON.stringify(target)} — `
        + `expected 'granted', 'denied', or 'prompt'.`,
      );
  }
}

/**
 * Ensure a simulator app's notification permission can reach the configured
 * target state, uninstalling the app when its recorded state conflicts.
 * Returns true when the app was uninstalled — the caller's install flow
 * must then (re)install it.
 */
export function ensureSimulatorNotificationPermissionState(
  udid: string,
  bundleId: string,
  target: NotificationPermissionState,
  precomputedStatus?: NotificationAuthorizationStatus,
): boolean {
  const status = precomputedStatus ?? readNotificationAuthorizationStatus(udid, bundleId);
  if (!needsNotificationReset(status, target)) return false;
  try {
    execFileSync('xcrun', ['simctl', 'uninstall', udid, bundleId]);
  } catch (err) {
    // Uninstall of a not-installed app fails; there is then no recorded
    // state left to conflict, so the fresh install proceeds as normal.
    // Any other failure means the conflicting state survived — the caller
    // would skip the reinstall (installed bundle still matches) and run
    // the session against the wrong permission state, so fail loudly.
    if (isAppInstalled(udid, bundleId)) {
      throw new Error(
        `Failed to uninstall ${bundleId} to reset its notification permission `
        + `state (recorded '${status}', configured '${target}'): `
        + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return true;
}
