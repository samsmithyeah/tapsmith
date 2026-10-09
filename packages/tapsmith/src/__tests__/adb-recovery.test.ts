import { describe, expect, it } from 'vitest';
import { checkPinnedDeviceHealth, pinnedDeviceNotListedMessage, type PinnedDeviceHealthDeps } from '../adb-recovery.js';
import type { DeviceClaim } from '../device-claims.js';
import type { DeviceHealthResult } from '../emulator.js';

// ─── Fake adb ───

type AdbReply = string | Error;

interface FakeAdbOptions {
  /** `adb devices` output, per call (the last one repeats); an Error makes the server "not answer". */
  devices: AdbReply[];
  /** Reply to the patient `echo` (defaults to a timeout). */
  echo?: AdbReply;
  /** Results of successive stability waits (the last one repeats). */
  stability: DeviceHealthResult[];
  heldElsewhere?: DeviceClaim[];
  startServer?: AdbReply;
}

function devicesOutput(...lines: string[]): string {
  return ['List of devices attached', ...lines, ''].join('\n');
}

function fakeAdb(opts: FakeAdbOptions) {
  const calls: string[] = [];
  const notes: string[] = [];
  let devicesCall = 0;
  let stabilityCall = 0;
  let clock = 0;
  const reply = (r: AdbReply): string => {
    if (r instanceof Error) throw r;
    return r;
  };
  const deps: PinnedDeviceHealthDeps = {
    adb: (args) => {
      const cmd = args.join(' ');
      calls.push(cmd);
      if (cmd === 'devices') return reply(opts.devices[Math.min(devicesCall++, opts.devices.length - 1)]!);
      if (cmd.endsWith('shell echo __tapsmith_health_ok__')) return reply(opts.echo ?? new Error('ETIMEDOUT'));
      if (cmd === 'start-server') return reply(opts.startServer ?? '');
      return '';
    },
    waitForStable: async (serial) => {
      calls.push(`<wait for ${serial}>`);
      return opts.stability[Math.min(stabilityCall++, opts.stability.length - 1)]!;
    },
    heldElsewhere: () => opts.heldElsewhere ?? [],
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    note: (m) => notes.push(m),
  };
  /** The commands that change adb's state — what the ticket is about. */
  const mutating = (): string[] => calls.filter((c) => /reconnect|kill-server|start-server/.test(c));
  return { deps, calls, notes, mutating };
}

const SERIAL = 'emulator-5554';
const healthy: DeviceHealthResult = { serial: SERIAL, healthy: true };
const shellDead: DeviceHealthResult = { serial: SERIAL, healthy: false, reason: 'ADB shell is unresponsive' };

function claim(device: string, pid = 4242): DeviceClaim {
  return {
    device,
    session: { id: 'other', pid, command: 'tapsmith test --ui', project: '/work/app', startedAt: '2026-10-09T10:00:00.000Z' },
    claimantPid: pid,
    claimedAt: '2026-10-09T10:00:00.000Z',
  };
}

// ─── Tests ───

describe('checkPinnedDeviceHealth (PILOT-475)', () => {
  it('touches nothing when the device is healthy', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [healthy] });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([]);
  });

  it('fails fast for a serial adb does not list, without reconnecting or restarting anything', async () => {
    const adb = fakeAdb({ devices: [devicesOutput('emulator-5556\tdevice')], stability: [shellDead] });
    await expect(checkPinnedDeviceHealth('bogus-123', adb.deps)).rejects.toThrow(
      'Device bogus-123 is not connected: adb does not list it (adb lists emulator-5556 (device)).',
    );
    expect(adb.mutating()).toEqual([]);
    expect(adb.calls).not.toContain('<wait for bogus-123>');
  });

  it('says adb lists no devices when the list is empty', () => {
    expect(pinnedDeviceNotListedMessage('X', [])).toContain('(adb lists no devices)');
  });

  it('accepts a slow device that answers a patient echo (a loaded host), with no recovery', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`)],
      stability: [shellDead],
      echo: '__tapsmith_health_ok__\n',
    });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([]);
  });

  it('reconnects only the pinned device first, and stops there when that brings it back', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`, 'emulator-5556\toffline')], stability: [shellDead, healthy] });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`]);
    expect(adb.notes.join('\n')).toContain(`Device ${SERIAL} reconnected and is responsive.`);
  });

  it('does not restart the ADB server while another Tapsmith session holds an Android device', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`, 'emulator-5556\tdevice')],
      stability: [shellDead],
      heldElsewhere: [claim('emulator-5556')],
    });
    const err = await checkPinnedDeviceHealth(SERIAL, adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`]);
    expect(err?.message).toContain('Tapsmith did not restart the ADB server: that would disconnect another Tapsmith session using Android devices: emulator-5556 (`tapsmith test --ui` (pid 4242) in /work/app');
    expect(err?.message).toContain(`Device ${SERIAL} is not responding, even after \`adb reconnect\`.`);
  });

  it('still refuses the restart when the ADB server does not answer and another session holds an Android device', async () => {
    const adb = fakeAdb({ devices: [new Error('ETIMEDOUT')], stability: [shellDead], heldElsewhere: [claim('R58M123')] });
    const err = await checkPinnedDeviceHealth(SERIAL, adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual([]);
    expect(err?.message).toContain('and the ADB server is not answering');
    expect(err?.message).toContain('R58M123');
  });

  it('restarts the ADB server as a last resort when only iOS devices are held elsewhere, and says so first', async () => {
    const adb = fakeAdb({
      devices: [devicesOutput(`${SERIAL}\tdevice`)],
      stability: [shellDead, shellDead, healthy],
      heldElsewhere: [claim('A1B2C3D4-0000-1111-2222-333344445555')],
    });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual([`-s ${SERIAL} reconnect`, 'kill-server', 'start-server']);
    const restartNote = adb.notes.find((n) => n.includes('Restarting the ADB server'));
    expect(restartNote).toContain('this disconnects every adb client on this machine');
    expect(adb.notes.at(-1)).toBe('ADB recovered. Device is responsive.');
  });

  it('goes straight to the restart when the ADB server does not answer and no other session holds a device', async () => {
    const adb = fakeAdb({ devices: [new Error('ETIMEDOUT')], stability: [shellDead, healthy] });
    await checkPinnedDeviceHealth(SERIAL, adb.deps);
    expect(adb.mutating()).toEqual(['kill-server', 'start-server']);
  });

  it('reports a failed server start', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [shellDead], startServer: new Error('ENOENT') });
    await expect(checkPinnedDeviceHealth(SERIAL, adb.deps)).rejects.toThrow('Failed to restart ADB server.');
  });

  it("names adb's state after a restart, without advising another restart", async () => {
    const adb = fakeAdb({
      devices: [devicesOutput('R58M123\toffline')],
      stability: [{ serial: 'R58M123', healthy: false, reason: 'ADB shell is unresponsive' }],
    });
    const err = await checkPinnedDeviceHealth('R58M123', adb.deps).then(() => undefined, (e: Error) => e);
    expect(adb.mutating()).toEqual(['-s R58M123 reconnect', 'kill-server', 'start-server']);
    expect(err?.message).toContain('R58M123 is attached, but adb reports it offline. Tapsmith already restarted the ADB server');
    expect(err?.message).not.toContain('kill-server');
  });

  it('ends with generic advice, never "run adb kill-server", when the device stays unresponsive after a restart', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [shellDead] });
    const err = await checkPinnedDeviceHealth(SERIAL, adb.deps).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain(`Device ${SERIAL} is not responding, even after Tapsmith restarted the ADB server.`);
    expect(err?.message).not.toContain('kill-server');
    expect(err?.message).toContain(`adb -s ${SERIAL} emu kill`);
  });

  it('throws "not ready" without any recovery for a non-shell failure', async () => {
    const adb = fakeAdb({ devices: [devicesOutput(`${SERIAL}\tdevice`)], stability: [{ serial: SERIAL, healthy: false, reason: 'emulator is not fully booted' }] });
    await expect(checkPinnedDeviceHealth(SERIAL, adb.deps)).rejects.toThrow(`Device ${SERIAL} is not ready: emulator is not fully booted.`);
    expect(adb.mutating()).toEqual([]);
  });

  it('refuses an unauthorized pin without touching the server (PILOT-457 preflight kept)', async () => {
    const adb = fakeAdb({ devices: [devicesOutput('R58M123\tno permissions (user in plugdev group; are your udev rules wrong?)')], stability: [shellDead] });
    await expect(checkPinnedDeviceHealth('R58M123', adb.deps)).rejects.toThrow('R58M123 is attached, but adb reports it no permissions');
    expect(adb.mutating()).toEqual([]);
  });
});
