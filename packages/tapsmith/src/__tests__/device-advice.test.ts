import { describe, it, expect } from 'vitest';
import {
  attachedDeviceAdvice,
  describeUnusableAndroidDevice,
  moreDevicesAdvice,
  noDeviceAdvice,
  noOnlineDeviceMessage,
  pinnedDeviceUnusableMessage,
  workerStartAdvice,
} from '../device-advice.js';

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

// PILOT-457: a phone whose USB-debugging prompt was never accepted is attached
// but unusable. The run paths said "No online devices found" (or, pinned,
// "not responding") without naming it; they now give doctor's advice.
const NO_PERMISSIONS = 'no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]';

describe('describeUnusableAndroidDevice()', () => {
  it('names the device, its adb state and the shared fix', () => {
    expect(describeUnusableAndroidDevice({ serial: 'R5CR1234XYZ', state: 'unauthorized' }))
      .toBe('R5CR1234XYZ is attached, but adb reports it unauthorized. Accept the USB debugging prompt on the device.');
  });

  it('gives the udev advice for a multi-word no-permissions state', () => {
    const text = describeUnusableAndroidDevice({ serial: '0123456789ABCDEF', state: NO_PERMISSIONS });
    expect(text).toContain(`adb reports it ${NO_PERMISSIONS}.`);
    expect(text).toContain('udev rule');
  });

  it('falls back to a generic fix for a state with no specific advice', () => {
    const text = describeUnusableAndroidDevice({ serial: 'HVA1', state: 'recovery' });
    expect(text).toContain('adb reports it recovery.');
    expect(text).toContain('adb kill-server');
  });
});

describe('noOnlineDeviceMessage()', () => {
  const config = { avd: undefined, launchEmulators: false };

  it('is the config advice alone when nothing unusable is attached', () => {
    expect(noOnlineDeviceMessage(config, [])).toBe(`No online devices found. ${noDeviceAdvice(config)}`);
    expect(noOnlineDeviceMessage(config, [{ serial: 'emulator-5554', state: 'device' }]))
      .toBe(`No online devices found. ${noDeviceAdvice(config)}`);
  });

  it('names every attached-but-unusable device before the config advice', () => {
    const msg = noOnlineDeviceMessage(config, [
      { serial: 'R5CR1234XYZ', state: 'unauthorized' },
      { serial: '0123456789ABCDEF', state: NO_PERMISSIONS },
    ]);
    expect(msg.startsWith('No online devices found. R5CR1234XYZ is attached, but adb reports it unauthorized. Accept the USB debugging prompt on the device. ')).toBe(true);
    expect(msg).toContain('0123456789ABCDEF is attached');
    expect(msg.endsWith(noDeviceAdvice(config))).toBe(true);
  });

  it('is built on attachedDeviceAdvice, which the bucket failure appends', () => {
    const attached = [{ serial: 'R5CR1234XYZ', state: 'unauthorized' }];
    expect(noOnlineDeviceMessage(config, attached)).toBe(`No online devices found. ${attachedDeviceAdvice(config, attached)}`);
    expect(attachedDeviceAdvice(config, [])).toBe(noDeviceAdvice(config));
  });

  it('ignores iOS entries (the daemon lists every platform)', () => {
    expect(noOnlineDeviceMessage(config, [{ serial: 'SIM', state: 'Shutdown', platform: 'ios' }]))
      .toBe(`No online devices found. ${noDeviceAdvice(config)}`);
  });
});

describe('pinnedDeviceUnusableMessage()', () => {
  const adb = [
    { serial: 'R5CR1234XYZ', state: 'unauthorized' },
    { serial: '0123456789ABCDEF', state: NO_PERMISSIONS },
    { serial: 'emulator-5554', state: 'offline' },
    { serial: 'HVA1', state: 'authorizing' },
    { serial: 'emulator-5556', state: 'device' },
  ];

  it('fails fast on states an adb restart cannot fix', () => {
    expect(pinnedDeviceUnusableMessage('R5CR1234XYZ', adb, 'preflight'))
      .toBe('Device R5CR1234XYZ is attached, but adb reports it unauthorized. Accept the USB debugging prompt on the device.');
    expect(pinnedDeviceUnusableMessage('0123456789ABCDEF', adb, 'preflight')).toContain('udev rule');
  });

  it('leaves offline and transient states to the restart recovery first', () => {
    expect(pinnedDeviceUnusableMessage('emulator-5554', adb, 'preflight')).toBeUndefined();
    expect(pinnedDeviceUnusableMessage('HVA1', adb, 'preflight')).toBeUndefined();
  });

  it('names any state adb still reports once recovery has failed', () => {
    expect(pinnedDeviceUnusableMessage('emulator-5554', adb, 'after-recovery'))
      .toContain('Device emulator-5554 is attached, but adb reports it offline.');
    expect(pinnedDeviceUnusableMessage('HVA1', adb, 'after-recovery')).toContain('adb reports it authorizing.');
  });

  it('is undefined for a usable or unlisted device', () => {
    expect(pinnedDeviceUnusableMessage('emulator-5556', adb, 'after-recovery')).toBeUndefined();
    expect(pinnedDeviceUnusableMessage('NOT-THERE', adb, 'after-recovery')).toBeUndefined();
  });
});
