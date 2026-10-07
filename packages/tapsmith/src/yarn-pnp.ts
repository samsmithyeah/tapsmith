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

/**
 * Whether this process runs under Yarn's PnP runtime, which sets
 * `process.versions.pnp` wherever `.pnp.cjs` is loaded (`yarn tapsmith …`,
 * and every Node process Yarn starts in the project).
 */
export function isYarnPnp(versions: Readonly<Record<string, string | undefined>> = process.versions): boolean {
  return typeof versions.pnp === 'string';
}

/** Why `command` cannot run here, or undefined when it can. */
export function yarnPnpRefusal(
  command: string,
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): CliRefusal | undefined {
  if (!TEST_RUNNING_COMMANDS.has(command) || !isYarnPnp(versions)) return undefined;
  return { code: 'YARN_PNP_UNSUPPORTED', message: YARN_PNP_MESSAGE, fix: YARN_PNP_FIX };
}
