import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverTestNames } from '../selection-preflight.js';

// Forks the real child (under tsx, from src/), so allow for a cold start.
describe('discoverTestNames', { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-preflight-')));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it('reads each file, and marks one that fails to load as unknown', async () => {
    const empty = write('empty.test.mjs', 'export {};\n');
    const broken = write('broken.test.mjs', 'throw new Error("boom");\n');
    const names = await discoverTestNames([empty, broken]);
    expect(names.get(empty)).toEqual([]);
    expect(names.has(broken)).toBe(true);
    expect(names.get(broken)).toBeUndefined();
  });

  it('gives up on a file whose import never finishes, marking every file unknown, and leaves no process behind', async () => {
    const marker = path.join(dir, 'pid');
    const hang = write('hang.test.mjs',
      `import * as fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n`);
    const names = await discoverTestNames([hang], 3_000);
    expect([...names]).toEqual([[hang, undefined]]);
    const pid = Number(fs.readFileSync(marker, 'utf-8'));
    // The process importing the file — under tsx, a grandchild — is gone too.
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
