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
vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    waitForReady(): Promise<boolean> { return waitForReady(); }
    ping(): Promise<{ version: string }> { return Promise.resolve({ version: 'test' }); }
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

const { startDaemon, closeAllClients } = await import('../mcp/connection.js');
const { mcpDaemonLogPath } = await import('../mcp/port-file.js');

class FakeDaemon extends EventEmitter {
  pid = 99999;
  kill = vi.fn(() => true);
  unref(): void {}
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

  it('quotes the daemon\'s log when it never answers', async () => {
    const daemon = new FakeDaemon();
    spawnMock.mockImplementation((_bin: string, _args: string[], opts: { stdio: [string, number, number] }) => {
      fs.writeSync(opts.stdio[2], 'Error: address already in use\n');
      return daemon;
    });
    waitForReady = () => Promise.resolve(false);

    expect(await startDaemon()).toBeNull();
    expect(daemon.kill).toHaveBeenCalled();
    expect(stderr).toContain('Failed to start daemon');
    expect(stderr).toContain('Error: address already in use');
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
