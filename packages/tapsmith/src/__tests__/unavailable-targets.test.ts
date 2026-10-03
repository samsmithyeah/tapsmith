import { describe, it, expect, vi } from 'vitest';
import { UnavailableTargets, firstProjectPerTarget, type ProvisionedTarget } from '../unavailable-targets.js';

const ANDROID = 'android|Pixel_6|com.example';
const IOS = 'ios|iPhone 17|com.example';

function provisioned(serial: string): ProvisionedTarget {
  return { workerGroups: [[serial]], configByDevice: new Map(), deviceGroupByDevice: new Map(), launched: [] };
}

describe('UnavailableTargets', () => {
  it('lists the targets that could not start, labelled, in the order they failed', () => {
    const targets = new UnavailableTargets(undefined, [[IOS, new Error('no sim')], [ANDROID, 'no emulator']]);
    expect(targets.size).toBe(2);
    expect(targets.has(ANDROID)).toBe(true);
    expect(targets.entries().map((e) => [e.signature, e.label])).toEqual([
      [IOS, 'ios iPhone 17'],
      [ANDROID, 'android Pixel_6'],
    ]);
  });

  it('gives each target the reason its files report', () => {
    const targets = new UnavailableTargets(undefined, [[ANDROID, new Error('No online devices found.\nSet `avd`')]]);
    expect(targets.reason(ANDROID)).toBe('Device target "android Pixel_6" could not start: No online devices found.\n  Set `avd`');
    expect(targets.reason(IOS)).toBeUndefined();
  });

  it('adds a hint to the reason\'s first line, keeping its later lines', () => {
    const targets = new UnavailableTargets(undefined, [
      [IOS, new Error('xcodebuild failed (exit 65).\nerror: no signing\nLog: ~/.tapsmith/ios-simulator-agent/xcodebuild.log')],
      [ANDROID, 'boom'],
    ]);
    expect(targets.notice(IOS, 'Running its tests again retries it.')).toBe(
      'Device target "ios iPhone 17" could not start: xcodebuild failed (exit 65). Running its tests again retries it.\n'
      + '  error: no signing\n  Log: ~/.tapsmith/ios-simulator-agent/xcodebuild.log',
    );
    expect(targets.notice(ANDROID, 'Running its tests again retries it.'))
      .toBe('Device target "android Pixel_6" could not start: boom. Running its tests again retries it.');
  });

  it('picks out the unavailable targets a run needs, once each', () => {
    const targets = new UnavailableTargets(undefined, [[ANDROID, 'x']]);
    const bucketByProject = new Map([['android', ANDROID], ['android-2', ANDROID], ['ios', IOS]]);
    expect(targets.signaturesFor(['ios', 'android', 'android-2', undefined], bucketByProject)).toEqual([ANDROID]);
    expect(targets.signaturesFor(['ios'], bucketByProject)).toEqual([]);
    expect(targets.signaturesFor(['android'], undefined)).toEqual([]);
  });

  it('a retry that provisions the target hands it over once and drops it from the list', async () => {
    const provision = vi.fn(async () => provisioned('emulator-5554'));
    const targets = new UnavailableTargets(provision, [[ANDROID, 'x']]);
    const apply = vi.fn(async () => {});
    expect(await targets.retry(ANDROID, apply)).toBe(true);
    expect(provision).toHaveBeenCalledWith(ANDROID);
    expect(apply).toHaveBeenCalledWith(provisioned('emulator-5554'));
    expect(targets.has(ANDROID)).toBe(false);
    // Available now: nothing to retry.
    expect(await targets.retry(ANDROID, apply)).toBe(true);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('a retry that fails again keeps the target with the new reason', async () => {
    const targets = new UnavailableTargets(async () => { throw new Error('AVD "Nope" not found'); }, [[ANDROID, 'old']]);
    const apply = vi.fn(async () => {});
    expect(await targets.retry(ANDROID, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(targets.reason(ANDROID)).toBe('Device target "android Pixel_6" could not start: AVD "Nope" not found');
  });

  it('keeps the target when its devices come up but its workers do not', async () => {
    const targets = new UnavailableTargets(async () => provisioned('emulator-5554'), [[ANDROID, 'old']]);
    expect(await targets.retry(ANDROID, async () => { throw new Error('worker 2 timed out during initialization'); })).toBe(false);
    expect(targets.reason(ANDROID)).toBe('Device target "android Pixel_6" could not start: worker 2 timed out during initialization');
  });

  it('shares one attempt between concurrent retries, applying it once', async () => {
    let finish!: (t: ProvisionedTarget) => void;
    const provision = vi.fn(() => new Promise<ProvisionedTarget>((resolve) => { finish = resolve; }));
    const targets = new UnavailableTargets(provision, [[ANDROID, 'x']]);
    const apply = vi.fn(async () => {});
    const first = targets.retry(ANDROID, apply);
    const second = targets.retry(ANDROID, apply);
    finish(provisioned('emulator-5554'));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh attempt after the previous one settled', async () => {
    const provision = vi.fn(async (): Promise<ProvisionedTarget> => { throw new Error('still broken'); });
    const targets = new UnavailableTargets(provision, [[ANDROID, 'x']]);
    await targets.retry(ANDROID, async () => {});
    await targets.retry(ANDROID, async () => {});
    expect(provision).toHaveBeenCalledTimes(2);
  });

  it('rethrows a Tapsmith bug instead of recording it as the target\'s reason', async () => {
    const targets = new UnavailableTargets(async () => { throw new TypeError('x is undefined'); }, [[ANDROID, 'old']]);
    await expect(targets.retry(ANDROID, async () => {})).rejects.toThrow(TypeError);
    expect(targets.reason(ANDROID)).toBe('Device target "android Pixel_6" could not start: old');
  });

  it('cannot retry without a way to provision (a single-target session)', async () => {
    const targets = new UnavailableTargets(undefined, [[ANDROID, 'old']]);
    expect(await targets.retry(ANDROID, async () => {})).toBe(false);
    expect(targets.has(ANDROID)).toBe(true);
  });

  it('records a target that failed later in the session', () => {
    const targets = new UnavailableTargets(undefined);
    expect(targets.size).toBe(0);
    targets.add(IOS, new Error('worker 1 timed out during initialization (90s)'));
    expect(targets.reason(IOS)).toBe('Device target "ios iPhone 17" could not start: worker 1 timed out during initialization (90s)');
  });
});

describe('firstProjectPerTarget()', () => {
  const p = (name: string, deviceSignature: string, files: number) =>
    ({ name, deviceSignature, testFiles: Array.from({ length: files }, (_, i) => `/t/${name}-${i}.test.ts`) });

  it('gives one project per target that has files, in config order', () => {
    const projects = [p('android-setup', ANDROID, 0), p('android', ANDROID, 2), p('ios', IOS, 1), p('android-2', ANDROID, 1)];
    expect(firstProjectPerTarget(projects).map((x) => x.name)).toEqual(['android', 'ios']);
  });

  it('is empty when no project has files', () => {
    expect(firstProjectPerTarget([p('android', ANDROID, 0)])).toEqual([]);
  });
});
