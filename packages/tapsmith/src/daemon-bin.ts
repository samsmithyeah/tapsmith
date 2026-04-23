/**
 * Locate the `tapsmith-core` daemon binary for ephemeral-daemon CLI commands
 * (`list-devices`, `configure-ios-network`, etc.).
 *
 * The daemon ships alongside the monorepo at `packages/tapsmith-core/target/release/tapsmith-core`
 * but isn't published to the user's PATH by default. The resolution order
 * below tries the environment, then the monorepo-relative build dir from
 * a few reasonable cwds, then finally PATH. Returns the first path that
 * exists; throws a descriptive error if none do.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BIN_NAME = 'tapsmith-core';

/**
 * Return a path suitable for passing to `spawn` as the daemon binary.
 *
 * Resolution order:
 *   1. `TAPSMITH_DAEMON_BIN` env var if it points at an existing file.
 *   2. Monorepo release build under `packages/tapsmith-core/target/release/`,
 *      searched relative to (a) cwd and (b) this module's install dir.
 *   3. Plain `tapsmith-core` name if something on `PATH` resolves to it.
 *
 * Throws an Error with an actionable hint when nothing matches, so
 * callers can surface it verbatim.
 */
export function findDaemonBin(): string {
  const candidates: string[] = [];

  const envBin = process.env['TAPSMITH_DAEMON_BIN'];
  if (envBin) candidates.push(envBin);

  // Monorepo release build, relative to cwd. Covers `cd packages/tapsmith && npx tapsmith ...`
  // and `cd <repo-root> && npx tapsmith ...`.
  candidates.push(
    path.resolve(process.cwd(), 'packages/tapsmith-core/target/release', BIN_NAME),
    path.resolve(process.cwd(), '../tapsmith-core/target/release', BIN_NAME),
    path.resolve(process.cwd(), '../packages/tapsmith-core/target/release', BIN_NAME),
    path.resolve(process.cwd(), '../../packages/tapsmith-core/target/release', BIN_NAME),
  );

  // npm-installed platform-specific binary (e.g. @tapsmith/core-darwin-arm64)
  const platform = process.platform;
  const arch = process.arch;
  const platformPkg = `@tapsmith/core-${platform}-${arch}`;
  try {
    const dist = path.dirname(__filename);
    candidates.push(
      path.resolve(dist, '..', 'node_modules', platformPkg, BIN_NAME),
      path.resolve(dist, '..', '..', '..', platformPkg, BIN_NAME),
    );
  } catch {
    // __dirname may not be defined — skip.
  }

  // Monorepo release build relative to this module's install dir.
  // `import.meta.url` isn't available in CJS builds, so walk up from
  // __dirname (dist/) to find a sibling `packages/tapsmith-core`.
  try {
    // dist/cli.js lives at packages/tapsmith/dist/cli.js; from dist, up 3 dirs
    // is the repo root, then packages/tapsmith-core/target/release.
    const dist = path.dirname(__filename);
    candidates.push(
      path.resolve(dist, '../../tapsmith-core/target/release', BIN_NAME),
      path.resolve(dist, '../../../packages/tapsmith-core/target/release', BIN_NAME),
    );
  } catch {
    // __dirname/filename may not be defined in some ESM shims — skip.
  }

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  // Last resort: resolve by PATH via `which` / `where`. Cross-platform
  // shortcut: call execFileSync('which', [...]) on darwin/linux,
  // execFileSync('where', [...]) on win32. We wrap both in a try because
  // neither command exists on a stripped container.
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const resolved = execFileSync(whichCmd, [BIN_NAME], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/)[0];
    if (resolved && isExecutable(resolved)) return resolved;
  } catch {
    // tapsmith-core not on PATH — fall through.
  }

  throw new Error(
    `Could not find the tapsmith-core daemon binary.\n\n` +
      `Tapsmith looked in:\n` +
      candidates.map((c) => `  • ${c}`).join('\n') +
      `\n  • $PATH (via \`${whichCmd} ${BIN_NAME}\`)\n\n` +
      `Fix one of:\n` +
      `  1. Build it from the monorepo: cd packages/tapsmith-core && cargo build --release\n` +
      `  2. Point TAPSMITH_DAEMON_BIN at an existing binary:\n` +
      `     export TAPSMITH_DAEMON_BIN=/absolute/path/to/tapsmith-core\n`,
  );
}

function isExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
