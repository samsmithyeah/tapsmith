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
  // Under a per-user directory rather than loose in the shared temp dir: the
  // file name is derived only from the project path, so on a multi-user host
  // anyone could otherwise plant one and hand the session a daemon address of
  // their choosing. The directory is only as good as its permissions, which
  // the writer verifies before trusting it (see `privateRegistryFile`).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `tapsmith-${uid}`, `mcp-daemons-${projectHash()}.json`);
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
