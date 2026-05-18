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

export function mcpActivityFilePath(): string {
  if (process.env.TAPSMITH_MCP_ACTIVITY_FILE) {
    return path.resolve(process.env.TAPSMITH_MCP_ACTIVITY_FILE);
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    return path.join('/tmp', `tapsmith-mcp-activity-${uid}.ndjson`);
  }
  return path.join(os.homedir() || os.tmpdir(), '.tapsmith', 'mcp-activity.ndjson');
}
