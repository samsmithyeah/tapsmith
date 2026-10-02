import { describe, it, expect } from 'vitest';
import {
  attachedDeviceAdvice,
  describeUnusableAndroidDevice,
  moreDevicesAdvice,
  noDeviceAdvice,
  noOnlineDeviceMessage,
  pinnedDeviceUnusableMessage,
  waitForPinnedDeviceAuthorization,
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
    expect(pinnedDeviceUnusableMessage('emulator-5554', adb, 'any'))
      .toContain('Device emulator-5554 is attached, but adb reports it offline.');
    expect(pinnedDeviceUnusableMessage('HVA1', adb, 'any')).toContain('adb reports it authorizing.');
  });

  it('does not suggest the ADB restart that recovery has just tried', () => {
    const offline = pinnedDeviceUnusableMessage('HVA9', [{ serial: 'HVA9', state: 'offline' }], 'after-adb-restart');
    expect(offline).toContain('adb reports it offline.');
    expect(offline).not.toContain('kill-server');
    expect(offline).toContain('Tapsmith already restarted the ADB server');
    const odd = pinnedDeviceUnusableMessage('HVA9', [{ serial: 'HVA9', state: 'recovery' }], 'after-adb-restart');
    expect(odd).not.toContain('kill-server');
  });

  it('is undefined for a usable or unlisted device', () => {
    expect(pinnedDeviceUnusableMessage('emulator-5556', adb, 'any')).toBeUndefined();
    expect(pinnedDeviceUnusableMessage('NOT-THERE', adb, 'any')).toBeUndefined();
  });
});

// A user who starts the run and then taps "Allow" must not lose the run: the
// preflight waits a while for an unauthorized pin, saying what it waits for.
describe('waitForPinnedDeviceAuthorization()', () => {
  const sequence = (...states: string[]) => {
    let call = 0;
    return () => [{ serial: 'R5C', state: states[Math.min(call++, states.length - 1)] }];
  };
  const deps = (listAdbDevices: () => Array<{ serial: string; state: string }>) => {
    const notes: string[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    return {
      notes,
      sleeps,
      deps: {
        listAdbDevices,
        sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
        now: () => clock,
        onWaiting: (message: string) => notes.push(message),
        timeoutMs: 5_000,
        pollMs: 1_000,
      },
    };
  };

  it('returns at once, without waiting or a note, for a usable or unlisted pin', async () => {
    const run = deps(sequence('device'));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(await waitForPinnedDeviceAuthorization('OTHER', run.deps)).toBeUndefined();
    expect(run.sleeps).toEqual([]);
    expect(run.notes).toEqual([]);
  });

  it('waits for the prompt to be accepted, saying so once', async () => {
    const run = deps(sequence('unauthorized', 'unauthorized', 'authorizing', 'device'));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]).toContain('R5C');
    expect(run.notes[0]).toContain('accept the USB debugging prompt');
    expect(run.sleeps.length).toBe(3);
  });

  it('gives the shared advice once the wait runs out', async () => {
    const run = deps(sequence('unauthorized'));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps))
      .toBe('Device R5C is attached, but adb reports it unauthorized. Accept the USB debugging prompt on the device.');
    expect(run.sleeps.reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it('does not wait on a no-permissions device: only the user\'s udev setup changes that', async () => {
    const run = deps(sequence(NO_PERMISSIONS));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toContain('udev rule');
    expect(run.sleeps).toEqual([]);
  });

  it('bounds the wait by the clock, not by the sleeps, when adb itself is slow', async () => {
    let clock = 0;
    let polls = 0;
    const result = await waitForPinnedDeviceAuthorization('R5C', {
      listAdbDevices: () => { polls++; clock += 2_000; return [{ serial: 'R5C', state: 'unauthorized' }]; },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      onWaiting: () => {},
      timeoutMs: 9_000,
      pollMs: 1_000,
    });
    expect(result).toContain('unauthorized');
    expect(polls).toBeLessThanOrEqual(4);
  });

  it('does not ask for a prompt that was already accepted (authorizing)', async () => {
    const run = deps(sequence('authorizing', 'device'));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]).not.toMatch(/accept/i);
    expect(run.notes[0]).toContain('authoriz');
  });

  it('keeps waiting while the pin is briefly gone (the cable replugged to bring the prompt back)', async () => {
    let call = 0;
    const states = ['unauthorized', undefined, undefined, 'unauthorized', 'device'];
    const run = deps(() => {
      const state = states[Math.min(call++, states.length - 1)];
      return state ? [{ serial: 'R5C', state }] : [];
    });
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(run.sleeps.length).toBe(4);
  });

  it('keeps waiting while a replugged pin passes through offline', async () => {
    const run = deps(sequence('unauthorized', 'offline', 'unauthorized', 'device'));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(run.sleeps.length).toBe(3);
  });

  it('does not wait when a usable device shares the pin\'s serial', async () => {
    const run = deps(() => [{ serial: 'R5C', state: 'unauthorized' }, { serial: 'R5C', state: 'device' }]);
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(run.sleeps).toEqual([]);
    expect(pinnedDeviceUnusableMessage('R5C', [{ serial: 'R5C', state: 'unauthorized' }, { serial: 'R5C', state: 'device' }], 'any'))
      .toBeUndefined();
  });

  it('says the pin is gone, not "attached", when it never came back from a replug', async () => {
    for (const first of ['unauthorized', 'authorizing']) {
      let call = 0;
      const run = deps(() => (call++ === 0 ? [{ serial: 'R5C', state: first }] : []));
      const result = await waitForPinnedDeviceAuthorization('R5C', run.deps);
      expect(result).toBe('Device R5C is no longer listed by adb. Reconnect it, then accept the USB debugging prompt on the device.');
    }
  });

  it('leaves offline to the restart recovery', async () => {
    const run = deps(sequence('offline'));
    expect(await waitForPinnedDeviceAuthorization('R5C', run.deps)).toBeUndefined();
    expect(run.sleeps).toEqual([]);
  });
});
