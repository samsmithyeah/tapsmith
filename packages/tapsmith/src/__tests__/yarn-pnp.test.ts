import { describe, expect, it } from 'vitest';
import { yarnPnpRefusal } from '../yarn-pnp.js';

// Yarn's `.pnp.cjs` runtime sets `process.versions.pnp` (to "3" on Yarn 2-4)
// in every process it is loaded into, which is how `yarn tapsmith …` runs.
const PNP = { node: '24.0.0', pnp: '3' };
const PLAIN = { node: '24.0.0' };

describe('yarnPnpRefusal()', () => {
  it('refuses the commands that run tests under Plug\'n\'Play, naming the linker fix', () => {
    for (const command of ['test', 'verify', 'mcp-server']) {
      const refusal = yarnPnpRefusal(command, PNP);
      expect(refusal, command).toBeDefined();
      expect(refusal!.code).toBe('YARN_PNP_UNSUPPORTED');
      expect(refusal!.message).toContain("Plug'n'Play");
      expect(refusal!.fix).toContain('nodeLinker: node-modules');
      expect(refusal!.fix).toContain('.yarnrc.yml');
      expect(refusal!.fix).toContain('yarn install');
    }
  });

  it('lets every other command run: they do not start tsx, the daemon or an agent from a file', () => {
    for (const command of ['doctor', 'init', 'list-devices', 'show-trace', 'show-report', 'telemetry', 'create-avd']) {
      expect(yarnPnpRefusal(command, PNP), command).toBeUndefined();
    }
  });

  it('refuses nothing outside Plug\'n\'Play', () => {
    for (const command of ['test', 'verify', 'mcp-server']) {
      expect(yarnPnpRefusal(command, PLAIN), command).toBeUndefined();
    }
  });
});
