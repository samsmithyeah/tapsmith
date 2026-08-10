import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

function projectHash(): string {
  return crypto
    .createHash('sha256')
    .update(process.cwd())
    .digest('hex')
    .slice(0, 8);
}

export function uiPortFilePath(): string {
  const hash = projectHash();
  return path.join(os.tmpdir(), `tapsmith-ui-port-${hash}`);
}

/**
 * Registry of daemons started by headless MCP sessions in this project.
 *
 * A session that starts its own daemon picks a free port, so nothing else can
 * find it: the next session probes the default address, misses, and starts
 * another daemon against the same device. Recording the address here lets
 * sessions reuse a running daemon the way they already reuse one on the
 * default port.
 */
export function mcpDaemonRegistryPath(): string {
  // Under the home directory, not the temp dir, because `os.tmpdir()` reads
  // `TMPDIR` — and an MCP server is spawned by its client, which may sanitize
  // the environment (the reference stdio transport passes only a small
  // allow-list, dropping `TMPDIR`). The path would then differ between a
  // client-launched session and a shell-launched one, so two sessions in the
  // same project would keep separate registries and each start its own daemon:
  // exactly the pile-up this file exists to prevent.
  //
  // Its own subdirectory, so the permission tightening in `privateRegistryFile`
  // applies here and never to a `~/.tapsmith` the user shares with other tools.
  return path.join(daemonStateDir(), `mcp-daemons-${projectHash()}.json`);
}

function daemonStateDir(): string {
  const home = os.homedir();
  if (home) return path.join(home, '.tapsmith', 'daemons');
  // No home directory to speak of: fall back to a per-user temp directory. The
  // name is derived only from the project path, so on a multi-user host anyone
  // could otherwise plant a file and hand the session a daemon address of their
  // choosing — which is why the writer verifies the directory before trusting
  // it (see `privateRegistryFile`).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `tapsmith-${uid}`);
}

export function mcpActivityFilePath(): string {
  if (process.env.TAPSMITH_MCP_ACTIVITY_FILE) {
    return path.resolve(process.env.TAPSMITH_MCP_ACTIVITY_FILE);
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    return path.join(os.tmpdir(), `tapsmith-mcp-activity-${uid}.ndjson`);
  }
  return path.join(os.homedir() || os.tmpdir(), '.tapsmith', 'mcp-activity.ndjson');
}
