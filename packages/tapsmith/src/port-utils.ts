/**
 * TCP port utilities shared by the CLI and the parallel dispatcher.
 *
 * Lives in its own module to avoid pulling cli.ts (and its heavy import
 * graph) into dispatcher.ts.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * Pick a free ephemeral TCP port by binding `0` on loopback, reading the
 * assigned port, then closing the server. Avoids the collision window that
 * random-in-a-range schemes have when multiple CLI invocations race.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('Failed to acquire ephemeral port'));
      }
    });
  });
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Find PIDs listening on a TCP port. Works on macOS (lsof) and Linux (fuser). */
export function findPidsOnPort(port: string | number): number[] {
  try {
    if (process.platform === 'darwin') {
      // -sTCP:LISTEN restricts matches to the listening socket. Without it,
      // lsof also returns processes with *established* connections to the
      // port — including the caller's own gRPC probe socket, so the
      // stale-daemon kill loops in cli.ts/dispatcher.ts SIGTERMed the CLI
      // itself (silent exit 143 during startup).
      return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n))
        .filter(pid => pid !== process.pid);
    }
    // Linux: ss (iproute2) with -l restricts matches to listening sockets.
    // fuser was used previously, but it read the wrong stream (PIDs go to
    // stdout, not stderr — so it never found anything) and, like lsof
    // without -sTCP:LISTEN, it matches both ends of established
    // connections. -H drops the header; -p appends
    // users:(("cmd",pid=N,fd=M)) per socket.
    const result = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf-8' });
    const pids = [...(result.stdout || '').matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    return [...new Set(pids)].filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

/**
 * Free a TCP host port we're about to use as an agent forward target by
 * killing any stale process listening on it. The common offender is a
 * leftover iOS `TapsmithAgent` (XCUITest socket server) from a previous iOS
 * run — its host-localhost socket squats on the port we want to use for
 * `adb forward`, silently shadowing the Android agent and routing every
 * subsequent command to the wrong device. The same issue can happen with
 * a leftover `tapsmith-core` daemon from a crashed previous run.
 *
 * We only kill processes whose command name matches a known stale-agent
 * pattern (`TapsmithAgen`, `tapsmith-core`, `xctest`) so we never touch
 * unrelated user processes.
 */
export function freeStaleAgentPort(
  port: number,
  onProgress?: (event: { port: number; pid: number; command: string }) => void,
): void {
  const pids = findPidsOnPort(port);
  if (pids.length === 0) return;

  const stalePatterns = /TapsmithAgen|tapsmith-core|xctest/;
  for (const pid of pids) {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
      if (!stalePatterns.test(cmd)) continue;
      if (onProgress) {
        onProgress({ port, pid, command: cmd });
      } else {
        process.stderr.write(`${DIM}Freeing agent port ${port} from stale ${cmd} (pid ${pid}).${RESET}\n`);
      }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    } catch {
      // ps failed (process gone) — nothing to do
    }
  }
}
