import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, type TapsmithConfig } from '../config.js';

const CONFIG_NAMES = ['tapsmith.config.ts', 'tapsmith.config.js', 'tapsmith.config.mjs'];

export interface McpConfigLoadResult {
  config: TapsmithConfig
  configPath?: string
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
  const cwdConfig = findConfigInDir(cwd);
  if (cwdConfig) {
    return { config: await loadConfig(cwd), configPath: cwdConfig };
  }

  const nested = findImmediateNestedConfigs(cwd);
  if (nested.length === 1) {
    return {
      config: await loadConfig(nested[0].dir),
      configPath: nested[0].configPath,
    };
  }

  if (nested.length > 1) {
    const dirs = nested.map((entry) => path.relative(cwd, entry.dir)).join(', ');
    process.stderr.write(`[tapsmith-mcp] Multiple nested Tapsmith configs found (${dirs}). Use --config to choose one.\n`);
  }

  return { config: await loadConfig(cwd) };
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
