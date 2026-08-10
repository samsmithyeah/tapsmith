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
  if (cwdConfig) {
    const config = await loadConfig(cwd);
    const loaded = configPathOf(config);
    if (loaded) return { config, configPath: loaded };
  }

  const nested = findImmediateNestedConfigs(cwd);
  if (nested.length === 1) {
    const config = await loadConfig(nested[0].dir);
    const loaded = configPathOf(config);
    if (loaded) return { config, configPath: loaded };
  }

  const suggestion = nested.length > 1
    ? `Multiple configs were found below it (${nested.map((e) => path.relative(cwd, e.configPath)).join(', ')}) — `
      + 'pass one with `--config <file>`, or start the server with its directory as the working directory.'
    : `No ${CONFIG_NAMES.join(' / ')} was found there or one level below. `
      + 'Pass one with `--config <file>`, or start the server with your test project as the working directory.';

  return {
    config: await loadConfig(cwd),
    warning:
      `No Tapsmith config file is backing this session (working directory: ${cwd}). ${suggestion} `
      + 'Until then the session runs on defaults: it has no app to launch, so tests cannot run, '
      + 'and the discovered test list may include files that are not Tapsmith tests.',
  };
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
