import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { awaitDaemonStart, captureDaemonOutput, daemonStartFailure } from '../daemon-start.js';

// What `tapsmith test` says when its daemon does not start: the daemon's own
// words, and "Is tapsmith-core installed?" only when it could not be run at
// all (PILOT-463). Real child processes stand in for the daemon — a shell
// script that prints and exits is exactly the failure being reported.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-daemon-start-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** An executable script standing in for tapsmith-core. */
function fakeDaemon(body: string): string {
  const bin = path.join(tmpDir, 'tapsmith-core');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

function start(bin: string, logPath?: string): { child: ChildProcess; capture: ReturnType<typeof captureDaemonOutput> } {
  const capture = captureDaemonOutput(logPath, () => {});
  try {
    return { child: spawn(bin, [], { stdio: capture.stdio }), capture };
  } finally {
    capture.closeParentFds();
  }
}

const never = (): Promise<boolean> => new Promise(() => {});

describe('awaitDaemonStart()', () => {
  it('reports an exit at once, with the code, instead of waiting out the budget', async () => {
    const { child, capture } = start(fakeDaemon('echo "Error: Address already in use (os error 48)" >&2\nexit 1'));
    const began = Date.now();
    const outcome = await awaitDaemonStart(child, never, { budgetMs: 30_000, address: 'localhost:50051' });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(outcome).toEqual({ ok: false, cause: 'tapsmith-core exited with code 1 before it answered', spawnFailed: false });
    expect(capture.recentOutput()).toBe('Error: Address already in use (os error 48)');
    capture.dispose();
  });

  it('names the signal that stopped it', async () => {
    const { child, capture } = start(fakeDaemon('kill -9 $$'));
    const outcome = await awaitDaemonStart(child, never, { budgetMs: 30_000, address: 'localhost:50051' });
    expect(outcome).toMatchObject({ ok: false, cause: 'tapsmith-core was stopped by SIGKILL before it answered' });
    capture.dispose();
  });

  it('says it could not run a binary that does not exist', async () => {
    const { child, capture } = start(path.join(tmpDir, 'missing', 'tapsmith-core'));
    const outcome = await awaitDaemonStart(child, never, { budgetMs: 30_000, address: 'localhost:50051' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.spawnFailed).toBe(true);
    expect(outcome.cause).toMatch(/^could not run .*tapsmith-core: spawn .* ENOENT$/);
    capture.dispose();
  });

  it('gives up at the budget when it neither answers nor exits', async () => {
    const { child, capture } = start(fakeDaemon('sleep 30'));
    try {
      const outcome = await awaitDaemonStart(child, () => Promise.resolve(false), { budgetMs: 300, windowMs: 100, address: 'localhost:50999' });
      expect(outcome).toEqual({ ok: false, cause: 'tapsmith-core did not answer on localhost:50999 within 0.3s', spawnFailed: false });
    } finally {
      child.kill('SIGKILL');
      capture.dispose();
    }
  });

  it('is ready as soon as it answers', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, signalCode: null });
    expect(await awaitDaemonStart(child, () => Promise.resolve(true), { budgetMs: 1_000, address: 'x' })).toEqual({ ok: true });
  });
});

describe('captureDaemonOutput()', () => {
  it('without a log, catches stderr in a temp file it removes afterwards', async () => {
    const { child, capture } = start(fakeDaemon('echo out\necho err >&2\nexit 2'));
    await awaitDaemonStart(child, never, { budgetMs: 30_000, address: 'x' });
    // stdout is the daemon's tracing; only stderr is kept.
    expect(capture.recentOutput()).toBe('err');
    expect(capture.logPath).toBeUndefined();
    capture.dispose();
    expect(capture.recentOutput()).toBe('');
  });

  it('with TAPSMITH_DAEMON_LOG, appends both streams there and quotes only what this daemon wrote', async () => {
    const logPath = path.join(tmpDir, 'logs', 'daemon.log');
    fs.mkdirSync(path.dirname(logPath));
    fs.writeFileSync(logPath, 'an earlier run\n');
    const { child, capture } = start(fakeDaemon('echo starting\necho "Error: bad" >&2\nexit 1'), logPath);
    await awaitDaemonStart(child, never, { budgetMs: 30_000, address: 'x' });
    expect(capture.logPath).toBe(logPath);
    expect(capture.recentOutput()).toBe('starting\nError: bad');
    capture.dispose();
    // The user's file is theirs: never removed.
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('an earlier run\nstarting\nError: bad\n');
  });

  it('falls back to the temp capture, after a warning, when the log cannot be opened', () => {
    const blocked = path.join(tmpDir, 'blocked');
    fs.mkdirSync(blocked);
    const warnings: string[] = [];
    const capture = captureDaemonOutput(blocked, (m) => warnings.push(m));
    expect(warnings[0]).toContain(`Could not open daemon log ${blocked}`);
    expect(capture.logPath).toBeUndefined();
    expect(Array.isArray(capture.stdio)).toBe(true);
    capture.closeParentFds();
    capture.dispose();
  });
});

describe('daemonStartFailure()', () => {
  it('quotes the daemon\'s output under the cause, with the log path last and nothing after it', () => {
    expect(daemonStartFailure('Failed to start Tapsmith daemon', {
      cause: 'tapsmith-core exited with code 1 before it answered',
      spawnFailed: false,
      recentOutput: 'Error: Address already in use (os error 48)',
      logPath: '/tmp/daemon.log',
    }).split('\n')).toEqual([
      // The cause on the headline: one-line progress rows show only that.
      'Failed to start Tapsmith daemon: tapsmith-core exited with code 1 before it answered',
      '  Recent daemon output:',
      '    Error: Address already in use (os error 48)',
      '  Daemon log: /tmp/daemon.log',
    ]);
  });

  it('asks whether tapsmith-core is installed only when it could not be run', () => {
    const ran = daemonStartFailure('Failed', { cause: 'exited', spawnFailed: false, recentOutput: '' });
    expect(ran).not.toContain('installed');
    const missing = daemonStartFailure('Failed', { cause: 'could not run /x: spawn /x ENOENT', spawnFailed: true, recentOutput: '' });
    expect(missing.split('\n')).toEqual([
      'Failed: could not run /x: spawn /x ENOENT',
      '  Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.',
    ]);
  });

  it('puts extra hints after the cause', () => {
    expect(daemonStartFailure('Failed', {
      cause: 'exited', spawnFailed: false, recentOutput: '', hints: ['Port 50052 is already in use.', 'Run: lsof -ti tcp:50052 | xargs kill'],
    }).split('\n')).toEqual(['Failed: exited', '  Port 50052 is already in use.', '  Run: lsof -ti tcp:50052 | xargs kill']);
  });
});
