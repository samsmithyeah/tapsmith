import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, configPathOf, type TapsmithConfig } from '../config.js';

const CONFIG_NAMES = ['tapsmith.config.ts', 'tapsmith.config.js', 'tapsmith.config.mjs'];

export interface McpConfigLoadResult {
  config: TapsmithConfig
  configPath?: string
  /**
   * Why no config file backs this session. Set only when `configPath` is
   * absent, in which case the config is Tapsmith's defaults applied to the
   * working directory — it will glob whatever it finds there and has no app to
   * launch, so every run fails. Callers must put this in front of the user
   * rather than letting a synthesized config pass for a real one.
   */
  warning?: string
}

export async function loadMcpConfig(configFile?: string): Promise<McpConfigLoadResult> {
  if (configFile) {
    const configPath = path.resolve(process.cwd(), configFile);
    const configDir = path.dirname(configPath);
    return {
      config: await loadConfig(configDir, path.basename(configPath)),
      configPath,
    };
  }

  const cwd = process.cwd();
  // `configPathOf`, not the path we probed for: a candidate that throws on
  // import leaves the session on defaults, and naming it anyway would hide
  // that behind a real-looking config.
  const cwdConfig = findConfigInDir(cwd);
  const nested = findImmediateNestedConfigs(cwd);

  if (cwdConfig) {
    const config = await loadConfig(cwd);
    const loaded = configPathOf(config);
    if (loaded) return { config, configPath: loaded };
    // It exists and it is broken. Falling through to a nested config here
    // would answer a question nobody asked: the session would report itself
    // as backed by some other directory's config, with no warning, while the
    // import error the user needs to see went only to stderr.
    return { config, warning: warningFor(cwd, cwdConfig, nested) };
  }

  if (nested.length === 1) {
    const config = await loadConfig(nested[0].dir);
    const loaded = configPathOf(config);
    if (loaded) return { config, configPath: loaded };
    return { config, warning: warningFor(cwd, nested[0].configPath, nested) };
  }

  return { config: await loadConfig(cwd), warning: warningFor(cwd, undefined, nested) };
}

/**
 * Why no config file backs this session.
 *
 * `unloadable` is the config that exists but throws on import, if there is
 * one. Saying "none was found" for it would send the reader looking for a
 * missing file when the real cause — a syntax error, a missing dependency —
 * went only to stderr.
 */
function warningFor(
  cwd: string,
  unloadable: string | undefined,
  nested: Array<{ dir: string; configPath: string }>,
): string {
  const nestedList = nested.map((e) => path.relative(cwd, e.configPath)).join(', ');
  const alternatives = nested.filter((e) => e.configPath !== unloadable);
  const suggestion = unloadable
    ? `${path.relative(cwd, unloadable)} was found but could not be loaded — the import error is above. Fix it, `
      // Naming the alternatives matters most here: when the broken config is
      // the one in the working directory, `--config` is only actionable if the
      // reader knows there are other configs to point it at.
      + (alternatives.length > 0
        ? `or pass one of the configs below it (${alternatives.map((e) => path.relative(cwd, e.configPath)).join(', ')}) with \`--config <file>\`.`
        : 'or pass a different config with `--config <file>`.')
    : nested.length > 1
      ? `Multiple configs were found below it (${nestedList}) — `
        + 'pass one with `--config <file>`, or start the server with its directory as the working directory.'
      : `No ${CONFIG_NAMES.join(' / ')} was found there or one level below. `
        + 'Pass one with `--config <file>`, or start the server with your test project as the working directory.';

  return `No Tapsmith config file is backing this session (working directory: ${cwd}). ${suggestion} `
    + 'Until then the session runs on defaults: it has no app to launch, so tests cannot run, '
    + 'and the discovered test list may include files that are not Tapsmith tests.';
}

function findConfigInDir(dir: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const configPath = path.join(dir, name);
    if (fs.existsSync(configPath)) return configPath;
  }
  return undefined;
}

function findImmediateNestedConfigs(root: string): Array<{ dir: string; configPath: string }> {
  const found: Array<{ dir: string; configPath: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const dir = path.join(root, entry.name);
    const configPath = findConfigInDir(dir);
    if (configPath) found.push({ dir, configPath });
  }
  return found;
}
