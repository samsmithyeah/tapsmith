import * as fs from 'node:fs';
import * as path from 'node:path';
import { mcpDaemonLogPath } from './port-file.js';

/**
 * The default log is rotated past this size when a daemon starts, keeping one
 * old copy, so a project that starts daemons for months does not grow a file
 * without bound. Big enough for many sessions of `info`-level output.
 */
const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** How many of a failed daemon's own log lines its error message quotes. */
const FAILURE_TAIL_LINES = 20;

export interface DaemonLog {
  /** Open for appending; hand it to `spawn` as the daemon's stdout and stderr, then close it. */
  fd: number
  path: string
  /** The file's size when it was opened: everything after it is this daemon's. */
  startOffset: number
}

/**
 * Open the file a headless MCP session's daemon writes its output to.
 *
 * `TAPSMITH_DAEMON_LOG` when set — the same override `tapsmith test` honours —
 * otherwise a per-project file beside the daemon registry. Appended, never
 * truncated: sessions in one project share the default file, and a daemon a
 * peer adopted may still be writing to it. Only the default file is rotated; a
 * file the user named is theirs to manage.
 *
 * Returns null, after a warning, when the file cannot be opened: the daemon
 * then runs with its output discarded rather than not at all.
 */
export function openDaemonLog(
  warn: (message: string) => void,
  maxBytes: number = DAEMON_LOG_MAX_BYTES,
): DaemonLog | null {
  const override = process.env.TAPSMITH_DAEMON_LOG;
  const logPath = override ? path.resolve(override) : mcpDaemonLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    let fd: number;
    if (override) {
      // The user's own file: a symlink they set up is theirs to follow.
      fd = fs.openSync(logPath, 'a', 0o600);
    } else {
      assertPrivateStateDir(path.dirname(logPath));
      rotateIfOversized(logPath, maxBytes);
      // Never through a link: with no home directory the state dir is a
      // predictable temp path, and a link planted at the log's name would
      // otherwise point our appends at a file of someone else's choosing.
      const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
      fd = fs.openSync(logPath, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
    }
    return { fd, path: logPath, startOffset: fs.fstatSync(fd).size };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Could not open daemon log ${logPath}; daemon output will be discarded: ${message}`);
    return null;
  }
}

/**
 * The same checks the daemon registry makes before trusting its directory
 * (`privateRegistryFile` in connection.ts): a real directory, not a link, owned
 * by us, and closed to everyone else. `mkdir`'s mode does nothing to a
 * directory that already existed.
 */
function assertPrivateStateDir(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user`);
  }
  if (stat.mode & 0o077) fs.chmodSync(dir, 0o700);
}

function rotateIfOversized(logPath: string, maxBytes: number): void {
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return; // No log yet.
  }
  if (size <= maxBytes) return;
  // A daemon still holding the old file keeps writing to it under its new
  // name, so its output lands in `.1`. A second rotation while that daemon
  // is still alive replaces `.1`, and the rest of its output goes to an
  // unlinked file: accepted, since it needs two 5 MB rotations within one
  // daemon's lifetime, and rotating under a live writer is not worth more.
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    // A session starting alongside this one rotated it first: nothing to do.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * The last lines written to the log since this daemon opened it — what a
 * "failed to start" message quotes, now that the daemon's stderr no longer
 * reaches the server's. Mostly this daemon's own output; a peer daemon in the
 * same project starting at the same moment can add lines too.
 */
export function readDaemonLogSince(
  log: Pick<DaemonLog, 'path' | 'startOffset'>,
  maxLines: number = FAILURE_TAIL_LINES,
): string {
  let content: string;
  try {
    const fd = fs.openSync(log.path, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.max(0, size - log.startOffset);
      if (length === 0) return '';
      // The tail is all that is quoted; never read a runaway log whole.
      const readLength = Math.min(length, 64 * 1024);
      const buffer = Buffer.alloc(readLength);
      fs.readSync(fd, buffer, 0, readLength, size - readLength);
      content = buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  return content.split('\n').filter((line) => line.trim().length > 0).slice(-maxLines).join('\n');
}
