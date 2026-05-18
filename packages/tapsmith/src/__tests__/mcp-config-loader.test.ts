import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMcpConfig } from '../mcp/config-loader.js';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe('loadMcpConfig()', () => {
  it('discovers a single immediate nested config from a repo root cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tapsmith-mcp-config-root-'));
    try {
      const e2e = join(root, 'e2e');
      mkdirSync(e2e);
      writeFileSync(join(e2e, 'tapsmith.config.mjs'), 'export default { package: "dev.example" };\n');
      process.chdir(root);

      const result = await loadMcpConfig();

      expect(result.config.package).toBe('dev.example');
      expect(realpathSync(result.config.rootDir)).toBe(realpathSync(e2e));
      expect(realpathSync(result.configPath!)).toBe(realpathSync(join(e2e, 'tapsmith.config.mjs')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('roots an explicit config path at the config file directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tapsmith-mcp-explicit-config-'));
    try {
      const e2e = join(root, 'e2e');
      mkdirSync(e2e);
      writeFileSync(join(e2e, 'tapsmith.config.ios.mjs'), 'export default { package: "dev.ios" };\n');
      process.chdir(root);

      const result = await loadMcpConfig('e2e/tapsmith.config.ios.mjs');

      expect(result.config.package).toBe('dev.ios');
      expect(realpathSync(result.config.rootDir)).toBe(realpathSync(e2e));
      expect(realpathSync(result.configPath!)).toBe(realpathSync(join(e2e, 'tapsmith.config.ios.mjs')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
