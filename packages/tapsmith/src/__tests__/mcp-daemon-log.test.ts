import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDaemonLog, readDaemonLogSince, type DaemonLog } from '../mcp/daemon-log.js';
import { mcpDaemonLogPath } from '../mcp/port-file.js';

// The MCP server's daemon used to write to a stderr pipe the server read. The
// daemon is started `--outlive-parent`, so once the server exited it was
// writing into a pipe nobody read (PILOT-453). It writes to a file instead.

let tmpDir: string;
let savedHome: string | undefined;
let savedLog: string | undefined;
let opened: DaemonLog[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-daemon-log-'));
  savedHome = process.env.HOME;
  savedLog = process.env.TAPSMITH_DAEMON_LOG;
  process.env.HOME = tmpDir;
  delete process.env.TAPSMITH_DAEMON_LOG;
  opened = [];
});

afterEach(() => {
  for (const log of opened) {
    try { fs.closeSync(log.fd); } catch { /* already closed */ }
  }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedLog === undefined) delete process.env.TAPSMITH_DAEMON_LOG; else process.env.TAPSMITH_DAEMON_LOG = savedLog;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function open(warn: (msg: string) => void = () => {}, maxBytes?: number): DaemonLog | null {
  const log = openDaemonLog(warn, maxBytes);
  if (log) opened.push(log);
  return log;
}

describe('openDaemonLog', () => {
  it('defaults to a per-project file in the daemon state directory', () => {
    const log = open();
    expect(log?.path).toBe(mcpDaemonLogPath());
    expect(log?.path.startsWith(path.join(tmpDir, '.tapsmith', 'daemons') + path.sep)).toBe(true);
    expect(fs.existsSync(log!.path)).toBe(true);
  });

  it('is private to the user', () => {
    const log = open();
    expect(fs.statSync(log!.path).mode & 0o077).toBe(0);
  });

  it('honours TAPSMITH_DAEMON_LOG, the documented override', () => {
    const custom = path.join(tmpDir, 'logs', 'my-daemon.log');
    process.env.TAPSMITH_DAEMON_LOG = custom;
    const log = open();
    expect(log?.path).toBe(custom);
    expect(fs.existsSync(custom)).toBe(true);
  });

  it('appends rather than truncating, so a peer daemon\'s output survives', () => {
    const first = open()!;
    fs.writeSync(first.fd, 'from the first daemon\n');
    const second = open()!;
    expect(second.startOffset).toBe('from the first daemon\n'.length);
    fs.writeSync(second.fd, 'from the second daemon\n');
    expect(fs.readFileSync(second.path, 'utf-8')).toBe('from the first daemon\nfrom the second daemon\n');
  });

  it('rotates the default log once it grows past the cap, keeping one old copy', () => {
    const logPath = mcpDaemonLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'x'.repeat(200));
    const log = open(() => {}, 100)!;
    expect(log.startOffset).toBe(0);
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('x'.repeat(200));
  });

  it('never rotates a file the user named', () => {
    const custom = path.join(tmpDir, 'mine.log');
    fs.writeFileSync(custom, 'x'.repeat(200));
    process.env.TAPSMITH_DAEMON_LOG = custom;
    const log = open(() => {}, 100)!;
    expect(log.startOffset).toBe(200);
    expect(fs.existsSync(`${custom}.1`)).toBe(false);
  });

  it('warns and returns null when the log cannot be opened', () => {
    // A directory where the file should be: open() fails with EISDIR.
    const blocked = path.join(tmpDir, 'blocked.log');
    fs.mkdirSync(blocked);
    process.env.TAPSMITH_DAEMON_LOG = blocked;
    const warnings: string[] = [];
    expect(open((m) => warnings.push(m))).toBeNull();
    expect(warnings.join('\n')).toContain(blocked);
    expect(warnings.join('\n')).toContain('discarded');
  });
});

describe('readDaemonLogSince', () => {
  it('returns only what this daemon wrote, as its last lines', () => {
    const logPath = mcpDaemonLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'an older daemon\n');
    const log = open()!;
    fs.writeSync(log.fd, 'line 1\nline 2\nline 3\n');
    expect(readDaemonLogSince(log, 2)).toBe('line 2\nline 3');
  });

  it('is empty when the daemon wrote nothing, or the file is gone', () => {
    const log = open()!;
    expect(readDaemonLogSince(log)).toBe('');
    fs.rmSync(log.path);
    expect(readDaemonLogSince(log)).toBe('');
  });
});
