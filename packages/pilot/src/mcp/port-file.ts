import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export function uiPortFilePath(): string {
  const projectHash = crypto
    .createHash('sha256')
    .update(process.cwd())
    .digest('hex')
    .slice(0, 8);
  return path.join(os.tmpdir(), `pilot-ui-port-${projectHash}`);
}
