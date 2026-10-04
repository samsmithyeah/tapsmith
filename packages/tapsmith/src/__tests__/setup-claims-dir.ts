import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

// Device claims (PILOT-381) go to a throwaway registry per Vitest worker: a
// test that opens a fake device session must never claim — or be refused — a
// device in the developer's real `~/.tapsmith/claims`, nor one another worker
// claimed for the same fake serial. Removed after each file (a worker's exit
// hooks do not reliably run); the next file starts from an empty registry.
const dir = path.join(os.tmpdir(), `tapsmith-unit-claims-${process.pid}`);
process.env.TAPSMITH_CLAIMS_DIR = dir;
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
