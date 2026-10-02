/**
 * What to tell a user whose run found no usable device, in terms of the
 * config they actually have. The old wording always ended "or set `avd`",
 * which sent users with `avd` set to change a setting they already had
 * (PILOT-400).
 */

import type { TapsmithConfig } from './config.js';
import { androidStateBlocker, type AdbDevice } from './adb-devices.js';

type AdviceConfig = Pick<TapsmithConfig, 'avd' | 'launchEmulators'>;

/** Advice for "no online Android device was found". */
export function noDeviceAdvice(config: AdviceConfig): string {
  if (!config.avd) {
    return 'Connect a device, start an emulator, or set `avd` in your config to auto-launch emulators.';
  }
  if (!config.launchEmulators) {
    return `\`avd\` is "${config.avd}" but \`launchEmulators\` is false, so Tapsmith does not boot it. `
      + 'Start the emulator yourself, or remove `launchEmulators: false`.';
  }
  return `Tapsmith tried to boot the "${config.avd}" emulator, but no healthy device came online (see any warnings above). `
    + 'Check that it boots from Android Studio\'s Device Manager, or run `tapsmith doctor`.';
}

/** Advice for a `use.devices` group that is short of devices. */
export function moreDevicesAdvice(config: AdviceConfig & Pick<TapsmithConfig, 'platform'>): string {
  if (config.platform === 'ios') {
    return 'Boot more simulators matching `simulator`, or pin members with `device`.';
  }
  if (!config.avd) {
    return 'Connect more devices, set `avd` so emulators can be launched, or pin members with `device`.';
  }
  if (!config.launchEmulators) {
    return 'Connect more devices, remove `launchEmulators: false` so emulators can be launched, or pin members with `device`.';
  }
  return 'Connect more devices, or pin members with `device`.';
}

/** Advice for "devices were found, but no worker started on any of them". */
export function workerStartAdvice(): string {
  return 'Fix the worker failure above, or run `tapsmith doctor` to check your setup.';
}

// ─── Attached but unusable Android devices (PILOT-457) ───

/**
 * An Android device and its adb state, from `adb devices` or the daemon's
 * `ListDevicesResponse` (whose `unusable_devices` carry adb's state).
 * `platform` lets daemon entries for other platforms be passed as they are.
 */
export type AdbStateEntry = AdbDevice & { platform?: string };

/** Usable by Tapsmith: adb's `device` state, or the daemon's names for it. */
export function isUsableAndroidState(state: string): boolean {
  return state === 'device' || state === 'Discovered' || state === 'Active';
}

/**
 * "`<serial>` is attached, but adb reports it unauthorized. Accept the USB
 * debugging prompt on the device." — the advice `doctor` and `list-devices`
 * give (`androidStateBlocker`), for the test-run paths' errors.
 */
export function describeUnusableAndroidDevice(device: AdbDevice): string {
  const fix = androidStateBlocker(device.state, device.serial)
    ?? 'Reconnect it, or run `adb kill-server` and try again';
  return `${device.serial} is attached, but adb reports it ${device.state}. ${fix}.`;
}

function unusableAndroid(devices: readonly AdbStateEntry[]): AdbStateEntry[] {
  return devices.filter((d) => (d.platform ?? 'android') === 'android' && !isUsableAndroidState(d.state));
}

/** {@link describeUnusableAndroidDevice} for each Android entry adb cannot use; usable and other-platform entries are skipped. */
export function describeUnusableAndroidDevices(devices: readonly AdbStateEntry[]): string[] {
  return unusableAndroid(devices).map(describeUnusableAndroidDevice);
}

/**
 * {@link noDeviceAdvice}, preceded by every attached device adb cannot use —
 * the phone whose USB-debugging prompt was never accepted is the likeliest
 * reason a first run finds nothing.
 */
export function attachedDeviceAdvice(config: AdviceConfig, attached: readonly AdbStateEntry[]): string {
  return [...describeUnusableAndroidDevices(attached), noDeviceAdvice(config)].join(' ');
}

/** "No online devices found." for an Android run, with {@link attachedDeviceAdvice}. */
export function noOnlineDeviceMessage(config: AdviceConfig, attached: readonly AdbStateEntry[]): string {
  return `No online devices found. ${attachedDeviceAdvice(config, attached)}`;
}

/**
 * The error for a pinned Android device adb lists but cannot use, or
 * undefined when it is usable or not listed. `preflight` (before any ADB
 * server restart) reports only states a restart cannot fix — unauthorized
 * and no-permissions — since `offline` (whose fix *is* a restart) and
 * transient states such as `authorizing` may recover; `after-recovery`
 * reports whatever state adb still gives.
 */
export function pinnedDeviceUnusableMessage(
  serial: string,
  devices: readonly AdbStateEntry[],
  phase: 'preflight' | 'after-recovery',
): string | undefined {
  const device = unusableAndroid(devices).find((d) => d.serial === serial);
  if (!device) return undefined;
  if (phase === 'preflight' && device.state !== 'unauthorized' && !device.state.startsWith('no permissions')) {
    return undefined;
  }
  return `Device ${describeUnusableAndroidDevice(device)}`;
}

/**
 * Before a pinned device's health check: give the user time to accept the
 * USB-debugging prompt on an `unauthorized` pin — they often start the run
 * first and tap "Allow" a moment later — saying once what the run waits for.
 * Resolves undefined when the pin is usable, unlisted, or in a state the
 * ADB-restart recovery handles (`offline`, …); otherwise the error to throw:
 * at once for no-permissions (only the user's udev setup changes that), or
 * once `timeoutMs` passes still unauthorized.
 */
export async function waitForPinnedDeviceAuthorization(
  serial: string,
  deps: {
    listAdbDevices: () => readonly AdbStateEntry[];
    sleep: (ms: number) => Promise<void>;
    onWaiting: (message: string) => void;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<string | undefined> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const pollMs = deps.pollMs ?? 1_000;
  let waited = 0;
  for (;;) {
    const devices = deps.listAdbDevices();
    const blocked = pinnedDeviceUnusableMessage(serial, devices, 'preflight');
    const state = devices.find((d) => d.serial === serial)?.state;
    // `authorizing` is the step between: the prompt was just accepted.
    const pending = state === 'unauthorized' || state === 'authorizing';
    if (!pending || waited >= timeoutMs) return blocked;
    if (waited === 0) {
      deps.onWaiting(
        `${serial} is unauthorized: Accept the USB debugging prompt on the device. Waiting up to ${Math.round(timeoutMs / 1000)} s…`,
      );
    }
    await deps.sleep(pollMs);
    waited += pollMs;
  }
}
