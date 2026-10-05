/**
 * Read every test file's test names in a child process, for the check that a
 * `--grep` selects something before `tapsmith test` touches a device
 * (PILOT-553). See selection-preflight-child.ts for why it is a child.
 */

import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveChildLoader } from './child-scripts.js';

export interface PreflightRequest {
  type: 'discover-names';
  files: string[];
}

export interface PreflightResponse {
  type: 'names';
  results: Array<{ file: string; names?: string[]; error?: string }>;
}

/** Long enough for a slow machine to import a large suite under tsx. */
const PREFLIGHT_TIMEOUT_MS = 60_000;

/**
 * Each file's test names, or `undefined` for a file that failed to load (and
 * for every file when the child itself failed or timed out): the run then goes
 * ahead and reports whatever is wrong itself.
 */
export function discoverTestNames(
  files: string[],
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): Promise<Map<string, string[] | undefined>> {
  // import.meta.dirname is src/ or dist/; the package root is one level up.
  const jsScript = path.resolve(import.meta.dirname, 'selection-preflight-child.js');
  const tsScript = path.resolve(import.meta.dirname, 'selection-preflight-child.ts');
  const script = !fs.existsSync(jsScript) && fs.existsSync(tsScript) ? tsScript : jsScript;
  const pkgDir = path.resolve(import.meta.dirname, '..');
  // From every file being checked, not this shard's: a shard of .js files
  // still has to import the suite's .ts files to answer the same way.
  const loader = resolveChildLoader([script], files, pkgDir);
  const unknown = new Map<string, string[] | undefined>(files.map((f) => [f, undefined]));

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Map<string, string[] | undefined>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof fork>;
    try {
      child = fork(script, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        ...(loader ? { execPath: loader } : {}),
        env: { ...process.env, NODE_PATH: path.resolve(pkgDir, '..') },
      });
    } catch {
      resolve(unknown);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      settle(unknown);
    }, timeoutMs);
    timer.unref?.();

    child.on('message', (msg: PreflightResponse) => {
      if (msg?.type !== 'names') return;
      settle(new Map(msg.results.map((r) => [r.file, r.names])));
    });
    child.on('error', () => settle(unknown));
    child.on('exit', () => settle(unknown));
    const request: PreflightRequest = { type: 'discover-names', files };
    child.send(request, (err) => { if (err) settle(unknown); });
  });
}
