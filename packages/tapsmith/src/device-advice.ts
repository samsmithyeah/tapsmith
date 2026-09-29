/**
 * What to tell a user whose run found no usable device, in terms of the
 * config they actually have. The old wording always ended "or set `avd`",
 * which sent users with `avd` set to change a setting they already had
 * (PILOT-400).
 */

import type { TapsmithConfig } from './config.js';

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
