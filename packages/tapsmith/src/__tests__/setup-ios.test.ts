import { describe, expect, it } from 'vitest';
import { setupSimulatorNetworkCapture, type SetupSimulatorDeps } from '../setup-ios.js';

type SeStatus = ReturnType<SetupSimulatorDeps['checkSeStatus']>;

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

async function setup(opts: {
  platform?: NodeJS.Platform;
  mitmproxy?: boolean;
  statuses?: SeStatus[];
}): Promise<{ code: number; out: string; polls: number }> {
  let out = '';
  const statuses = [...(opts.statuses ?? ['enabled'])];
  let polls = 0;
  let now = 0;
  const code = await setupSimulatorNetworkCapture({
    platform: opts.platform ?? 'darwin',
    isMitmproxyInstalled: () => opts.mitmproxy ?? true,
    checkSeStatus: () => {
      polls++;
      return statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    },
    openSettings: () => true,
    sleep: async (ms) => { now += ms; },
    now: () => now,
    log: (line = '') => { out += `${line}\n`; },
    error: (line) => { out += `${line}\n`; },
    write: (text) => { out += text; },
  });
  return { code, out: plain(out), polls };
}

const DEVICE_TRACK = /physical iPhone or iPad[\s\S]*tapsmith ios setup-device[\s\S]*tapsmith ios network configure <udid>/;

describe('tapsmith ios network setup-simulator (PILOT-271)', () => {
  it('says it is about simulator network capture', async () => {
    const { out } = await setup({});
    expect(out).toMatch(/iOS simulator network capture/);
  });

  it('exits 0 when the Network Extension is enabled', async () => {
    const { code, out } = await setup({ statuses: ['enabled'] });
    expect(code).toBe(0);
    expect(out).toContain('iOS simulator network capture is ready');
  });

  it('exits 0 on a fresh machine where the extension is not registered yet, with next steps', async () => {
    const { code, out } = await setup({ statuses: ['not-registered'] });
    expect(code).toBe(0);
    expect(out).toContain('registers automatically on your first iOS simulator test run');
    expect(out).toContain('tapsmith test');
    expect(out).toContain('tapsmith ios network setup-simulator');
  });

  it('exits 0 once a pending approval is granted while it polls', async () => {
    const { code, out, polls } = await setup({ statuses: ['waiting-for-user', 'waiting-for-user', 'enabled'] });
    expect(code).toBe(0);
    expect(polls).toBe(3);
    expect(out).toContain('Network Extension approved');
  });

  it.each<[string, Parameters<typeof setup>[0]]>([
    ['mitmproxy is missing', { mitmproxy: false }],
    ['approval times out', { statuses: ['waiting-for-user'] }],
    ['the extension state is unknown', { statuses: ['unknown'] }],
    ['the host is not macOS', { platform: 'linux' }],
  ])('exits 1 when %s', async (_why, opts) => {
    expect((await setup(opts)).code).toBe(1);
  });

  it.each<[string, Parameters<typeof setup>[0]]>([
    ['ready', { statuses: ['enabled'] }],
    ['not registered', { statuses: ['not-registered'] }],
    ['mitmproxy missing', { mitmproxy: false }],
    ['approval timed out', { statuses: ['waiting-for-user'] }],
    ['state unknown', { statuses: ['unknown'] }],
  ])('points physical-device users at their own track (%s)', async (_why, opts) => {
    expect((await setup(opts)).out).toMatch(DEVICE_TRACK);
  });

  it('names only the new commands', async () => {
    for (const statuses of [['enabled'], ['not-registered'], ['waiting-for-user'], ['unknown']] as SeStatus[][]) {
      expect((await setup({ statuses })).out).not.toMatch(/setup-ios(?!-)|tapsmith setup-ios/);
    }
    expect((await setup({ mitmproxy: false })).out).toContain('tapsmith ios network setup-simulator');
    expect((await setup({ platform: 'linux' })).out).toContain('tapsmith ios network setup-simulator');
  });
});

describe('tapsmith ios setup-device cross-reference (PILOT-271)', () => {
  it('points at this device\'s capture setup and at the simulator track', async () => {
    const { networkCaptureNextSteps } = await import('../setup-ios-device.js');
    const text = plain(networkCaptureNextSteps().join('\n'));
    expect(text).toContain('tapsmith ios network configure <udid>');
    expect(text).toContain('tapsmith ios network verify <udid>');
    expect(text).toMatch(/simulator[\s\S]*tapsmith ios network setup-simulator/);
  });
});
