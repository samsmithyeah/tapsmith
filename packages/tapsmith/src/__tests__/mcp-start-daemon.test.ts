import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// How the headless MCP server starts its daemon: where the daemon's output
// goes, and what happens to a daemon the session is still waiting on when the
// session ends (PILOT-453). No real daemon — spawn and gRPC are faked.

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

let waitForReady: () => Promise<boolean>;
let ping: () => Promise<{ version: string; agentConnected?: boolean }>;
vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    waitForReady(): Promise<boolean> { return waitForReady(); }
    ping(): Promise<{ version: string; agentConnected?: boolean }> { return ping(); }
    close(): void {}
  },
}));

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/fake/tapsmith-core' }));

let nextPort = 41000;
let pickPort: () => Promise<number> = () => Promise.resolve(nextPort++);
vi.mock('../port-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../port-utils.js')>()),
  pickFreePort: () => pickPort(),
}));

const { startDaemon, closeAllClients, ensureConnected } = await import('../mcp/connection.js');
const { mcpDaemonLogPath } = await import('../mcp/port-file.js');

class FakeDaemon extends EventEmitter {
  pid: number | undefined = 99999;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  // Like a real one, a killed daemon exits.
  kill = vi.fn(() => {
    if (this.exitCode === null && this.signalCode === null) this.exitWith(null, 'SIGTERM');
    return true;
  });
  unref(): void {}
  exitWith(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', code, signal));
  }
}

let tmpDir: string;
let savedHome: string | undefined;
let savedLog: string | undefined;
let stderr: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-start-daemon-'));
  savedHome = process.env.HOME;
  savedLog = process.env.TAPSMITH_DAEMON_LOG;
  process.env.HOME = tmpDir;
  delete process.env.TAPSMITH_DAEMON_LOG;
  spawnMock.mockReset();
  pickPort = () => Promise.resolve(nextPort++);
  ping = () => Promise.resolve({ version: 'test', agentConnected: true });
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  closeAllClients();
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedLog === undefined) delete process.env.TAPSMITH_DAEMON_LOG; else process.env.TAPSMITH_DAEMON_LOG = savedLog;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// What the MCP client sees: the tool result, not the server's stderr, which
// few clients show (PILOT-463).
describe('ensureConnected', () => {
  it('puts the daemon\'s own error in the tool error when the daemon it starts exits', async () => {
    // Nothing is running, so the session starts a daemon, which dies.
    waitForReady = () => Promise.resolve(false);
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      const daemon = new FakeDaemon();
      fs.writeSync(opts.stdio[2], 'Error: tapsmith-core refused to start: mitmproxy not found\n');
      daemon.exitWith(1);
      return daemon;
    });

    const err = await ensureConnected().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Error: tapsmith-core refused to start: mitmproxy not found');
    expect(message).toContain(`Daemon log: ${mcpDaemonLogPath()}`);
    expect(message).not.toContain('Is tapsmith-core installed?');
  });

  it('says why a daemon it found could not be used', async () => {
    // A daemon answers on the default port, but its ping fails.
    waitForReady = () => Promise.resolve(true);
    ping = () => Promise.reject(new Error('14 UNAVAILABLE: Connection dropped'));

    const err = await ensureConnected().then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain('Could not connect to the daemon at localhost:50051: 14 UNAVAILABLE: Connection dropped');
    expect((err as Error).message).not.toContain('installed');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('startDaemon', () => {
  it('hands the daemon a log file for stdout and stderr, never a pipe back to the server', async () => {
    let stdio: unknown;
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: unknown; detached: boolean }) => {
      stdio = opts.stdio;
      expect(opts.detached).toBe(true);
      const [, out, err] = opts.stdio as [string, number, number];
      fs.writeSync(err, 'daemon says hello\n');
      expect(out).toBe(err);
      return new FakeDaemon();
    });
    waitForReady = () => Promise.resolve(true);

    const conn = await startDaemon();
    expect(conn).not.toBeNull();
    expect(Array.isArray(stdio)).toBe(true);
    expect((stdio as unknown[])[0]).toBe('ignore');
    expect(typeof (stdio as unknown[])[2]).toBe('number');
    expect(fs.readFileSync(mcpDaemonLogPath(), 'utf-8')).toBe('daemon says hello\n');
    expect(stderr).toContain(`log: ${mcpDaemonLogPath()}`);
  });

  it('fails with the daemon\'s own words and its log path when it exits, without asking about the install', async () => {
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      fs.writeSync(opts.stdio[2], 'Error: address already in use\n');
      daemon.exitWith(1);
      return daemon;
    });
    // Never answers: only the exit can end the wait, and it must, at once.
    waitForReady = () => new Promise(() => {});

    const err = await startDaemon('ios').then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.split('\n')).toEqual([
      'Failed to start a ios daemon: tapsmith-core exited with code 1 before it answered',
      '  Recent daemon output:',
      '    Error: address already in use',
      `  Daemon log: ${mcpDaemonLogPath()}`,
    ]);
    // The server's stderr still says it too.
    expect(stderr).toContain('Error: address already in use');
  });

  it('asks whether tapsmith-core is installed when it could not be run', async () => {
    const daemon = new FakeDaemon();
    daemon.pid = undefined;
    spawnMock.mockImplementation(() => {
      setImmediate(() => daemon.emit('error', Object.assign(new Error('spawn /fake/tapsmith-core ENOENT'), { code: 'ENOENT' })));
      return daemon;
    });
    waitForReady = () => new Promise(() => {});

    const err = await startDaemon().then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain('spawn /fake/tapsmith-core ENOENT');
    expect((err as Error).message).toContain('Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN');
  });

  it('reports a binary for another architecture (spawn throws) through the same formatted error, with its log path', async () => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC', errno: -8, syscall: 'spawn' });
    });

    const err = await startDaemon('android').then(() => undefined, (e: unknown) => e);
    const lines = (err as Error).message.split('\n');
    expect(lines[0]).toBe('Failed to start a android daemon: could not run tapsmith-core: /fake/tapsmith-core is not an executable for this machine (ENOEXEC)');
    expect(lines[1]).toContain(`than this Node (${process.platform}-${process.arch})`);
    expect(lines.at(-1)).toBe(`  Daemon log: ${mcpDaemonLogPath()}`);
    expect((err as Error).message).not.toContain('Is tapsmith-core installed?');
    // The server's stderr says it too.
    expect(stderr).toContain('is not an executable for this machine');
  });

  it('says it did not answer when it neither answers nor exits', async () => {
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation(() => daemon);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      waitForReady = () => new Promise((resolve) => setTimeout(() => resolve(false), 10_000));
      const starting = startDaemon().then(() => undefined, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      const err = await starting;
      expect((err as Error).message).toMatch(/tapsmith-core did not answer on 127\.0\.0\.1:\d+ within 10s/);
      expect((err as Error).message).not.toContain('installed');
      expect(daemon.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still starts the daemon, output discarded, when the log cannot be opened', async () => {
    const blocked = path.join(tmpDir, 'blocked.log');
    fs.mkdirSync(blocked);
    process.env.TAPSMITH_DAEMON_LOG = blocked;
    let stdio: unknown;
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: unknown }) => {
      stdio = opts.stdio;
      return new FakeDaemon();
    });
    waitForReady = () => Promise.resolve(true);

    expect(await startDaemon()).not.toBeNull();
    expect(stdio).toBe('ignore');
    expect(stderr).toContain('daemon output will be discarded');
  });

  it('stops a daemon that is still starting when the session closes', async () => {
    // The client leaves during the seconds a daemon takes to answer. The
    // daemon is detached and `--outlive-parent`, and not yet registered or in
    // the connection list: nothing else would ever stop it.
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation(() => daemon);
    let ready!: (ok: boolean) => void;
    waitForReady = () => new Promise<boolean>((resolve) => { ready = resolve; });

    const starting = startDaemon();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    closeAllClients();
    expect(daemon.kill).toHaveBeenCalled();

    ready(false);
    expect(await starting).toBeNull();
  });

  it('does not join a closed session when the daemon answers just after the close', async () => {
    // The kill and a `waitForReady` that already succeeded race: the daemon
    // answers, and the connection must not land in the list the close reset.
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation(() => daemon);
    let ready!: (ok: boolean) => void;
    waitForReady = () => new Promise<boolean>((resolve) => { ready = resolve; });

    const starting = startDaemon();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    closeAllClients();
    ready(true);
    expect(await starting).toBeNull();
    expect(daemon.kill).toHaveBeenCalled();
  });

  it('never spawns a daemon for a session that closed while it was picking ports', async () => {
    let releasePort!: () => void;
    const portGate = new Promise<void>((resolve) => { releasePort = resolve; });
    pickPort = async () => { await portGate; return nextPort++; };
    waitForReady = () => Promise.resolve(true);

    const starting = startDaemon();
    closeAllClients();
    releasePort();
    expect(await starting).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
