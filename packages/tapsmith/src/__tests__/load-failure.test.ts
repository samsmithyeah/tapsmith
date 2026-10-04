import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fileLoadFailureTitle, loadFailureTreeNode, withoutLoadFailedFiles, parseMissingImport, withMissingImportFrame } from '../load-failure.js';
import { extractStack } from '../trace/trace-collector.js';
import type { TestTreeNode } from '../ui-mode/ui-protocol.js';
import { formatError } from '../reporters/base.js';

// PILOT-545: a missing-module error's stack holds only resolver frames, so the
// reporter has no user frame to draw a code frame from. The helper adds one at
// the import that failed, from whichever message shape the loader produced.

let tempDir: string;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeTestFile(source: string): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-load-frame-'));
  fs.mkdirSync(path.join(tempDir, 'tests'));
  const file = path.join(tempDir, 'tests', 'a-broken.test.ts');
  fs.writeFileSync(file, source);
  return file;
}

function errorWithStack(message: string, name = 'Error'): Error {
  const error = new Error(message);
  error.stack = `${name}: ${message}\n    at node:internal/modules/cjs/loader:1517:15\n    at defaultResolve (node:internal/modules/esm/resolve:992:11)`;
  return error;
}

const SOURCE = [
  "import { test } from 'tapsmith';",
  "import { login } from '../helpers/login';",
  '',
  "test('signs in', async () => { await login(); });",
].join('\n');

describe('parseMissingImport', () => {
  it('reads tsx\'s CommonJS "Require stack" shape', () => {
    expect(parseMissingImport("Cannot find module '../helpers/login'\nRequire stack:\n- /p/tests/a.test.ts\n- /p/other.ts"))
      .toEqual({ specifier: '../helpers/login', importer: '/p/tests/a.test.ts', isPackage: false });
  });

  it('reads Node ESM\'s resolved-path "imported from" shape', () => {
    expect(parseMissingImport("Cannot find module '/p/helpers/login' imported from /p/tests/a.test.ts"))
      .toEqual({ specifier: '/p/helpers/login', importer: '/p/tests/a.test.ts', isPackage: false });
  });

  it('reads Vite\'s quoted "imported from" shape and file URLs', () => {
    expect(parseMissingImport("Cannot find module './x' imported from 'file:///p/tests/a.test.ts?t=1'"))
      .toEqual({ specifier: './x', importer: '/p/tests/a.test.ts', isPackage: false });
  });

  it('reads Node\'s missing-package shape', () => {
    expect(parseMissingImport("Cannot find package 'left-pad' imported from /p/tests/a.test.ts"))
      .toEqual({ specifier: 'left-pad', importer: '/p/tests/a.test.ts', isPackage: true });
  });

  it('ignores any other error', () => {
    expect(parseMissingImport('x.fixme is not a function')).toBeUndefined();
    expect(parseMissingImport("Cannot find module 'x'")).toBeUndefined();
  });
});

describe('withMissingImportFrame', () => {
  it('adds a frame at the import line for the tsx shape', () => {
    const file = writeTestFile(SOURCE);
    const error = withMissingImportFrame(errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`));
    expect(extractStack(error.stack!)[0]).toEqual({ file, line: 2, column: 23 });
  });

  it('matches the resolved path Node ESM reports against the specifier as written', () => {
    const file = writeTestFile(SOURCE);
    const resolved = path.join(tempDir, 'helpers', 'login');
    const error = withMissingImportFrame(errorWithStack(
      `Cannot find module '${resolved}' imported from ${file}`,
      'Error [ERR_MODULE_NOT_FOUND]',
    ));
    expect(extractStack(error.stack!)[0]).toEqual({ file, line: 2, column: 23 });
  });

  it('finds a missing package\'s subpath import', () => {
    const file = writeTestFile("import pad from 'left-pad/index.js';\n");
    const error = withMissingImportFrame(errorWithStack(`Cannot find package 'left-pad' imported from ${pathToFileURL(file).href}`));
    expect(extractStack(error.stack!)[0]).toEqual({ file, line: 1, column: 17 });
  });

  it('lets the console reporter render a code frame at the import', () => {
    const file = writeTestFile(SOURCE);
    const error = withMissingImportFrame(errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`));
    const out = formatError(error).replace(/\x1b\[\d+m/g, '');
    expect(out).toMatch(/> 2 \| import \{ login \} from '..\/helpers\/login';/);
  });

  it('leaves the error alone when the import line cannot be found', () => {
    const file = writeTestFile("// the import was generated at runtime\nawait import(name);\n");
    const original = errorWithStack(`Cannot find module '../helpers/login'\nRequire stack:\n- ${file}`);
    const stack = original.stack;
    expect(withMissingImportFrame(original).stack).toBe(stack);
  });

  it('leaves the error alone when the importer cannot be read', () => {
    const original = errorWithStack("Cannot find module './x'\nRequire stack:\n- /nonexistent/dir/a.test.ts");
    const stack = original.stack;
    expect(withMissingImportFrame(original).stack).toBe(stack);
  });

  it('leaves any other error alone', () => {
    const original = new TypeError('x.fixme is not a function');
    const stack = original.stack;
    expect(withMissingImportFrame(original).stack).toBe(stack);
  });
});

describe('loadFailureTreeNode', () => {
  it('keeps a file UI mode could not load in the tree, as one failed row with the error', () => {
    expect(loadFailureTreeNode('/repo/tests/a-broken.test.ts', "Cannot find module '../helpers/login'")).toEqual({
      id: '/repo/tests/a-broken.test.ts',
      type: 'file',
      name: 'a-broken.test.ts',
      filePath: '/repo/tests/a-broken.test.ts',
      fullName: 'a-broken.test.ts',
      status: 'idle',
      children: [{
        // Same id scheme and fullName as a discovered test, so the runner's
        // load-failure result for this file lands on this row.
        id: '/repo/tests/a-broken.test.ts::a-broken.test.ts — failed to load',
        type: 'test',
        name: 'a-broken.test.ts — failed to load',
        filePath: '/repo/tests/a-broken.test.ts',
        fullName: 'a-broken.test.ts — failed to load',
        status: 'failed',
        error: "Cannot find module '../helpers/login'",
      }],
    });
  });
});

describe('fileLoadFailureTitle', () => {
  it('names the file, so reporters that print only the title still say which file failed', () => {
    expect(fileLoadFailureTitle('/repo/tests/a-broken.test.ts')).toBe('a-broken.test.ts — failed to load');
  });
});

describe('withoutLoadFailedFiles', () => {
  const node = (type: TestTreeNode['type'], filePath: string, children?: TestTreeNode[]): TestTreeNode => ({
    id: `${type}:${filePath}`, type, name: filePath, filePath, fullName: filePath, status: 'idle', ...(children ? { children } : {}),
  });
  const ok = node('file', '/r/ok.test.ts', [node('test', '/r/ok.test.ts')]);
  const broken = loadFailureTreeNode('/r/broken.test.ts', 'boom');

  it('drops a file that failed to load, at the top level and under a project', () => {
    const failed = new Map([['/r/broken.test.ts', 'boom']]);
    expect(withoutLoadFailedFiles([ok, broken], failed)).toEqual([ok]);
    const project = node('project', '', [ok, broken]);
    expect(withoutLoadFailedFiles([project], failed)).toEqual([{ ...project, children: [ok] }]);
  });

  it('keeps every file when none failed', () => {
    expect(withoutLoadFailedFiles([ok, broken], new Map())).toEqual([ok, broken]);
  });
});
