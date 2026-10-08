import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatConfigLoadFailure } from '../config-load-report.js';
import { parseEsbuildErrors } from '../config.js';

describe('parseEsbuildErrors()', () => {
  it('reads each located error, with a 1-based column', () => {
    const message = 'Transform failed with 2 errors:\n'
      + '/p/tapsmith.config.ts:5:2: ERROR: Expected "}" but found "timeout"\n'
      + '/p/helper.ts:1:0: ERROR: Unexpected end of file';
    expect(parseEsbuildErrors(message)).toEqual([
      { file: '/p/tapsmith.config.ts', line: 5, column: 3, text: 'Expected "}" but found "timeout"' },
      { file: '/p/helper.ts', line: 1, column: 1, text: 'Unexpected end of file' },
    ]);
  });

  it('is undefined for any other message', () => {
    expect(parseEsbuildErrors('boom')).toBeUndefined();
    expect(parseEsbuildErrors('Transform failed with 1 error:\nno location here')).toBeUndefined();
  });
});

describe('formatConfigLoadFailure()', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-config-report-'));
    file = path.join(dir, 'tapsmith.config.ts');
    fs.writeFileSync(file, 'export default {\n  apk: "a.apk",\n  package: "x"\n  timeout: 1000,\n};\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints a syntax error once, with a code frame and a caret, and no loader frames', () => {
    const cause = new Error(`Transform failed with 1 error:\n${file}:4:2: ERROR: Expected "}" but found "timeout"`);
    cause.stack = `Error: ${cause.message}\n    at failureErrorWithLog (/x/node_modules/esbuild/lib/main.js:1752:15)`;
    const err = new Error(`Failed to load config file ${file}:4:3: Expected "}" but found "timeout"`, { cause });
    const out = formatConfigLoadFailure(err, {
      configPath: file,
      location: { file, line: 4, column: 3, text: 'Expected "}" but found "timeout"' },
    }, { color: false });

    expect(out.split('Expected "}"')).toHaveLength(2);
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('Transform failed');
    expect(out).toBe([
      `Failed to load config file ${file}:4:3: Expected "}" but found "timeout"`,
      '',
      '    2 |   apk: "a.apk",',
      '    3 |   package: "x"',
      '  > 4 |   timeout: 1000,',
      '      |   ^',
      '    5 | };',
    ].join('\n'));
  });

  it('points a config that throws at its own line, with only its own frames', () => {
    const cause = new Error('boom');
    cause.stack = 'Error: boom\n'
      + `    at file://${file}?tapsmith-config=123:3:9\n`
      + '    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)\n'
      + '    at importConfigModuleWithTsx (/x/node_modules/tapsmith/dist/config.js:10:1)';
    const err = new Error(`Failed to load config file ${file}: boom`, { cause });
    const out = formatConfigLoadFailure(err, { configPath: file }, { color: false });

    expect(out.split('boom')).toHaveLength(2);
    expect(out).toContain('  > 3 |   package: "x"');
    expect(out).toContain(`    at ${file}:3:9`);
    expect(out).not.toContain('node:internal');
    expect(out).not.toContain('node_modules');
  });

  it('prints just the message when there is nothing to point at', () => {
    const err = new Error(`Failed to load config file ${file}: Cannot find module 'x'`);
    expect(formatConfigLoadFailure(err, { configPath: file }, { color: false })).toBe(err.message);
  });
});
