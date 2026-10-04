import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CLAIMS_DIR_ENV,
  SESSION_ENV,
  claimDevice,
  claimFirstFree,
  claimUpTo,
  claimDeviceOrThrow,
  currentSession,
  daemonDriverElsewhere,
  describeHolder,
  devicesHeldElsewhere,
  ensureClaimSession,
  listDeviceClaims,
  releaseDeviceClaim,
  releaseSessionClaims,
  withoutHeldDevices,
  type SessionIdentity,
} from '../device-claims.js';

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', '0']);
  return res.pid ?? 999_999;
}

function session(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    id: overrides.id ?? `s-${Math.random().toString(36).slice(2)}`,
    pid: overrides.pid ?? process.pid,
    command: overrides.command ?? 'tapsmith test',
    project: overrides.project ?? '/work/project',
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    ...(overrides.startToken !== undefined ? { startToken: overrides.startToken } : {}),
  };
}

describe('device claims', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-claims-'));
    env = { [CLAIMS_DIR_ENV]: dir };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets a session claim a free device and records who holds it', () => {
    const me = session({ command: 'tapsmith test --ui' });
    expect(claimDevice('emulator-5554', me, { daemonAddress: 'localhost:50051', env })).toEqual({ ok: true, fresh: true });
    const claims = listDeviceClaims({ env });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      device: 'emulator-5554',
      daemonAddress: 'localhost:50051',
      claimantPid: process.pid,
      live: true,
    });
    expect(claims[0].session.command).toBe('tapsmith test --ui');
  });

  it('is re-entrant for the same session (workers, watch re-runs, MCP run_tests children)', () => {
    const me = session();
    expect(claimDevice('emulator-5554', me, { env })).toEqual({ ok: true, fresh: true });
    expect(claimDevice('emulator-5554', me, { env })).toEqual({ ok: true, fresh: false });
    expect(listDeviceClaims({ env })).toHaveLength(1);
  });

  it('releases one device of a session, and never another session\'s claim', () => {
    const me = session();
    const other = session();
    claimDevice('mine', me, { env });
    claimDevice('theirs', other, { env });
    releaseDeviceClaim('mine', me, { env });
    releaseDeviceClaim('theirs', me, { env });
    expect(listDeviceClaims({ env }).map((c) => c.device)).toEqual(['theirs']);
  });

  it('refuses a device a live other session holds, and names the holder', () => {
    const holder = session({ command: 'tapsmith mcp-server', project: '/work/other' });
    claimDevice('emulator-5554', holder, { env });
    const res = claimDevice('emulator-5554', session(), { env });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.holder.session.id).toBe(holder.id);
    expect(() => claimDeviceOrThrow('emulator-5554', session(), { env }))
      .toThrow(/emulator-5554 is in use by another Tapsmith session: `tapsmith mcp-server` \(pid \d+\) in \/work\/other/);
  });

  it('takes over a claim whose session process is gone (crash, kill -9)', () => {
    claimDevice('emulator-5554', session({ pid: deadPid() }), { env });
    const me = session();
    expect(claimDevice('emulator-5554', me, { env })).toEqual({ ok: true, fresh: true });
    expect(listDeviceClaims({ env })[0].session.id).toBe(me.id);
  });

  it('takes over a claim whose pid was reused by an unrelated process', () => {
    // Same live pid, but a start token that no longer matches the process
    // now running under it.
    claimDevice('emulator-5554', session({ startToken: 'Thu Jan  1 00:00:00 1970' }), { env });
    expect(claimDevice('emulator-5554', session(), { env }).ok).toBe(true);
  });

  it('keeps a live holder live whatever locale or time zone the checking session runs in', () => {
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    try {
      process.env.TZ = 'Asia/Tokyo';
      process.env.LC_ALL = 'de_DE.UTF-8';
      const holder = ensureClaimSession('tapsmith mcp-server', { env: {}, project: '/p', exitHook: false });
      expect(holder.startToken).toBeDefined();
      claimDevice('emulator-5554', holder, { env });
      process.env.TZ = 'UTC';
      process.env.LC_ALL = 'C';
      expect(claimDevice('emulator-5554', session(), { env }).ok).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('reports stale claims as not live', () => {
    claimDevice('emulator-5554', session({ pid: deadPid() }), { env });
    expect(listDeviceClaims({ env })[0].live).toBe(false);
    expect(devicesHeldElsewhere(session(), { env }).size).toBe(0);
  });

  it('releases every claim a session holds, and only its own', () => {
    const me = session();
    const other = session();
    claimDevice('emulator-5554', me, { env });
    claimDevice('emulator-5556', me, { env });
    claimDevice('ABCD-1234', other, { env });
    releaseSessionClaims(me.id, { env });
    expect(listDeviceClaims({ env }).map((c) => c.device)).toEqual(['ABCD-1234']);
  });

  it('stores serials that are not safe file names (adb over Wi-Fi)', () => {
    const me = session();
    expect(claimDevice('192.168.1.5:5555', me, { env }).ok).toBe(true);
    expect(claimDevice('../../etc/x', me, { env }).ok).toBe(true);
    expect(listDeviceClaims({ env }).map((c) => c.device).sort()).toEqual(['../../etc/x', '192.168.1.5:5555']);
    for (const f of fs.readdirSync(dir)) expect(f).not.toContain('/');
  });

  it('lists the devices other live sessions hold, excluding its own', () => {
    const me = session();
    claimDevice('mine', me, { env });
    claimDevice('theirs', session(), { env });
    expect([...devicesHeldElsewhere(me, { env })]).toEqual(['theirs']);
  });

  it('claims the first free candidate at pick time, so a session starting at the same moment takes the next', () => {
    const a = session();
    const b = session();
    expect(claimFirstFree(['emulator-5554', 'emulator-5556'], a, { env })).toBe('emulator-5554');
    expect(claimFirstFree(['emulator-5554', 'emulator-5556'], b, { env })).toBe('emulator-5556');
    expect(claimFirstFree(['emulator-5554', 'emulator-5556'], session(), { env })).toBeUndefined();
  });

  it('splits a candidate list into free and held devices, keeping order', () => {
    const me = session();
    claimDevice('b', session({ command: 'tapsmith test --watch' }), { env });
    const { free, held } = withoutHeldDevices(['a', 'b', 'c'], me, { env });
    expect(free).toEqual(['a', 'c']);
    expect(held.map((h) => h.device)).toEqual(['b']);
  });

  it('finds the live session driving its device through a daemon, whatever the loopback spelling', async () => {
    const holder = session();
    claimDevice('emulator-5554', holder, { daemonAddress: 'localhost:50051', env });
    const active = async () => 'emulator-5554';
    expect((await daemonDriverElsewhere('127.0.0.1:50051', active, session(), { env }))?.session.id).toBe(holder.id);
    expect(await daemonDriverElsewhere('localhost:50051', active, holder, { env })).toBeUndefined();
    expect(await daemonDriverElsewhere('localhost:50052', active, session(), { env })).toBeUndefined();
  });

  it('is not fooled by a reused port: a daemon not pointed at the claimed device is not that session\'s', async () => {
    claimDevice('emulator-5554', session(), { daemonAddress: 'localhost:50051', env });
    expect(await daemonDriverElsewhere('localhost:50051', async () => 'emulator-5556', session(), { env })).toBeUndefined();
    expect(await daemonDriverElsewhere('localhost:50051', async () => undefined, session(), { env })).toBeUndefined();
  });

  it('matches the active device against every claim the other session made through the daemon', async () => {
    // A sequential run's projects claim their devices through the same port
    // one after the other; the one it drives now may not sort first.
    const holder = session();
    claimDevice('emulator-5554', holder, { daemonAddress: 'localhost:50051', env });
    claimDevice('SIM-X', holder, { daemonAddress: 'localhost:50051', env });
    expect((await daemonDriverElsewhere('localhost:50051', async () => 'SIM-X', session(), { env }))?.device).toBe('SIM-X');
  });

  it('remembers every daemon the other session drove the device through', async () => {
    // The root opened it on its primary daemon, then a worker on its own.
    const holder = session();
    claimDevice('emulator-5554', holder, { daemonAddress: 'localhost:50051', env });
    claimDevice('emulator-5554', holder, { daemonAddress: 'localhost:50052', env });
    const active = async () => 'emulator-5554';
    expect((await daemonDriverElsewhere('localhost:50051', active, session(), { env }))?.session.id).toBe(holder.id);
    expect((await daemonDriverElsewhere('localhost:50052', active, session(), { env }))?.session.id).toBe(holder.id);
  });

  it('claims up to a count, in order, skipping held devices and leaving the rest unclaimed', () => {
    claimDevice('b', session(), { env });
    const me = session();
    const res = claimUpTo(['a', 'b', 'c', 'd'], 2, me, { env });
    expect(res.claimed).toEqual(['a', 'c']);
    expect(res.held.map((h) => h.device)).toEqual(['b']);
    expect(listDeviceClaims({ env }).map((c) => c.device)).toEqual(['a', 'b', 'c']);
  });

  it('does not ask for the active device when nobody else claimed through the daemon', async () => {
    let asked = false;
    await daemonDriverElsewhere('localhost:50051', async () => { asked = true; return 'x'; }, session(), { env });
    expect(asked).toBe(false);
  });

  it('never fails the caller when the registry cannot be written', () => {
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const broken = { [CLAIMS_DIR_ENV]: file };
    expect(claimDevice('emulator-5554', session(), { env: broken }).ok).toBe(true);
    expect(listDeviceClaims({ env: broken })).toEqual([]);
  });

  it('ignores a corrupt claim file', () => {
    fs.writeFileSync(path.join(dir, 'emulator-5554.json'), '{not json');
    expect(claimDevice('emulator-5554', session(), { env }).ok).toBe(true);
  });

  it('describes a holder for people', () => {
    const text = describeHolder({
      device: 'x',
      session: session({ command: 'tapsmith test --ui', project: '/p', pid: 42 }),
      claimantPid: 43,
      claimedAt: new Date().toISOString(),
    });
    expect(text).toMatch(/^`tapsmith test --ui` \(pid 42\) in \/p, since \d/);
  });
});

describe('session identity', () => {
  it('stamps one session into the environment, which children inherit unchanged', () => {
    const env: NodeJS.ProcessEnv = {};
    const root = ensureClaimSession('tapsmith test', { env, project: '/p', exitHook: false });
    expect(root.pid).toBe(process.pid);
    expect(env[SESSION_ENV]).toBeDefined();
    // A forked child sees the same env, and so the same session.
    const child = ensureClaimSession('tapsmith test', { env: { ...env }, project: '/elsewhere', exitHook: false });
    expect(child.id).toBe(root.id);
    expect(currentSession({ ...env }).id).toBe(root.id);
  });

  it('starts a fresh session when the inherited one is malformed', () => {
    const env: NodeJS.ProcessEnv = { [SESSION_ENV]: '{"id":42}' };
    const s = ensureClaimSession('tapsmith test', { env, project: '/p', exitHook: false });
    expect(typeof s.id).toBe('string');
    expect(s.pid).toBe(process.pid);
  });
});
