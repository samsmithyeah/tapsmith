/**
 * Yarn Plug'n'Play (PILOT-560).
 *
 * Under PnP, packages stay inside zip archives in Yarn's cache and Node reaches
 * them only through the `.pnp.cjs` runtime Yarn loads into the process. Running
 * tests means starting tsx, the daemon and the device agents as programs from
 * files on disk, so a test run there fails with `spawn ENOTDIR` (tsx inside a
 * zip) or worse. Until that is supported, the commands that run tests refuse
 * up front with the one fix that works: the node-modules linker.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTapsmithResolvableFrom } from './config.js';

/** The commands that start tests, and with them tsx, the daemon and an agent. */
const TEST_RUNNING_COMMANDS = new Set(['test', 'verify', 'mcp-server']);

interface CliRefusal {
  code: string;
  message: string;
  fix: string;
}

const YARN_PNP_MESSAGE = "Tapsmith can't run tests in a Yarn Plug'n'Play install: it starts tsx, its daemon and "
  + "its device agents from files on disk, and Plug'n'Play keeps packages inside zip archives.";

export const YARN_PNP_FIX = 'Add `nodeLinker: node-modules` to .yarnrc.yml, run `yarn install`, then run the command again.';

interface PnpEnv {
  versions: Readonly<Record<string, string | undefined>>;
  /** Where the command runs: the project. */
  cwd: string;
}

const processEnv = (): PnpEnv => ({ versions: process.versions, cwd: process.cwd() });

/**
 * Whether Tapsmith is running in a Plug'n'Play install. Yarn's `.pnp.cjs`
 * runtime sets `process.versions.pnp` wherever it is loaded (`yarn tapsmith …`).
 * `npx tapsmith …` in such a project runs a downloaded copy under plain Node
 * instead, so that also counts: a `.pnp.cjs` at or above `cwd`, and no
 * `tapsmith` that resolves from `node_modules` (which rules out a stray
 * `.pnp.cjs` in a parent directory of a node-modules project).
 */
export function isYarnPnp(env: PnpEnv = processEnv()): boolean {
  if (typeof env.versions.pnp === 'string') return true;
  return hasPnpManifestAbove(env.cwd) && !isTapsmithResolvableFrom(env.cwd);
}

function hasPnpManifestAbove(dir: string): boolean {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.pnp.cjs'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** Why `command` cannot run here, or undefined when it can. */
export function yarnPnpRefusal(command: string, env: PnpEnv = processEnv()): CliRefusal | undefined {
  if (!TEST_RUNNING_COMMANDS.has(command) || !isYarnPnp(env)) return undefined;
  return { code: 'YARN_PNP_UNSUPPORTED', message: YARN_PNP_MESSAGE, fix: YARN_PNP_FIX };
}
