import { describe, it, expect } from 'vitest';
import { noDeviceAdvice, moreDevicesAdvice, workerStartAdvice } from '../device-advice.js';

// "Set `avd`" is advice for a config that has no `avd`. Printing it when
// `avd` is set sends the user to change a setting they already have
// (PILOT-400).
describe('noDeviceAdvice()', () => {
  it('suggests setting `avd` when none is configured', () => {
    expect(noDeviceAdvice({ avd: undefined, launchEmulators: false }))
      .toBe('Connect a device, start an emulator, or set `avd` in your config to auto-launch emulators.');
  });

  it('points at `launchEmulators: false` when `avd` is set but launching is off', () => {
    const advice = noDeviceAdvice({ avd: 'Pixel_6', launchEmulators: false });
    expect(advice).not.toMatch(/set `avd`/);
    expect(advice).toContain('"Pixel_6"');
    expect(advice).toContain('`launchEmulators` is false');
  });

  it('says the configured emulator did not come online when Tapsmith tried to boot it', () => {
    const advice = noDeviceAdvice({ avd: 'Pixel_6', launchEmulators: true });
    expect(advice).not.toMatch(/set `avd`/);
    expect(advice).toContain('"Pixel_6"');
    expect(advice).toContain('tapsmith doctor');
  });
});

describe('moreDevicesAdvice()', () => {
  it('keeps the `avd` suggestion only when `avd` is unset', () => {
    expect(moreDevicesAdvice({ platform: 'android', avd: undefined, launchEmulators: false }))
      .toBe('Connect more devices, set `avd` so emulators can be launched, or pin members with `device`.');
    expect(moreDevicesAdvice({ platform: 'android', avd: 'Pixel_6', launchEmulators: true }))
      .not.toMatch(/set `avd`/);
  });

  it('names `launchEmulators` when it is what stops Tapsmith booting more', () => {
    expect(moreDevicesAdvice({ platform: 'android', avd: 'Pixel_6', launchEmulators: false }))
      .toContain('`launchEmulators: false`');
  });

  it('talks about simulators on iOS', () => {
    expect(moreDevicesAdvice({ platform: 'ios', avd: undefined, launchEmulators: false }))
      .toBe('Boot more simulators matching `simulator`, or pin members with `device`.');
  });
});

// Devices were found but no worker came up on them: the cause is the worker
// failure, so the advice points there — never at device provisioning.
describe('workerStartAdvice()', () => {
  it('never suggests `avd`, whatever the config', () => {
    expect(workerStartAdvice()).not.toMatch(/avd/);
    expect(workerStartAdvice()).toContain('tapsmith doctor');
  });
});
