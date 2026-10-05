/**
 * `tapsmith test [args...] [--grep]` resolves its selection before any device
 * or daemon work (PILOT-553): a glob, directory or filter that matches nothing,
 * a missing file, or a grep that selects no test, fails with "No tests found"
 * at once instead of after a device boot.
 *
 * Drives the *built* CLI in a scratch project, with `adb` and the daemon
 * replaced by stand-ins that record being reached — so "before any device
 * work" is asserted, not inferred from timing. Rebuild (`npm run build`) after
 * changing the code these cover; a local run with no build skips them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PKG_DIR = path.resolve(__dirname, '..', '..');
const CLI = path.join(PKG_DIR, 'dist', 'cli.js');
const DIST_BUILT = fs.existsSync(CLI);

if (!DIST_BUILT && !process.env.CI) {
  console.warn('cli-test-selection.test.ts: skipped — dist/ is not built (run `npm run build`).');
}

const testFile = (describeName: string, tests: string[]): string =>
  'import { test, describe } from "tapsmith";\n'
  + `describe(${JSON.stringify(describeName)}, () => {\n`
  + tests.map((t) => `  test(${JSON.stringify(t)}, async () => {});\n`).join('')
  + '});\n';

describe.skipIf(!DIST_BUILT && !process.env.CI)('tapsmith test selection', { timeout: 60_000 }, () => {
  let root: string;
  let marker: string;
  let fakeBin: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-select-')));
    marker = path.join(root, 'device-work.log');
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "select-app", "private": true, "type": "module" }\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(PKG_DIR, path.join(root, 'node_modules', 'tapsmith'), 'dir');
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false };\n');
    fs.mkdirSync(path.join(root, 'tests', 'pw'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'login.test.ts'), testFile('login', ['signs in']));
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'signup.test.ts'), testFile('signup', ['creates an account']));
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'helper.ts'), 'export const x = 1;\n');

    // Stand-ins for everything device-side: each records that it was reached
    // and fails, so a run that gets past selection stops there.
    fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    for (const tool of ['adb', 'emulator', 'xcrun', 'tapsmith-core']) {
      const script = path.join(fakeBin, tool);
      fs.writeFileSync(script, `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(marker)}\nexit 1\n`);
      fs.chmodSync(script, 0o755);
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(...args: string[]): { status: number | null; output: string; reachedDevice: boolean } {
    const result = spawnSync(process.execPath, [CLI, 'test', ...args], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        ANDROID_HOME: path.join(root, 'no-sdk'),
        ANDROID_SDK_ROOT: path.join(root, 'no-sdk'),
        TAPSMITH_DAEMON_BIN: path.join(fakeBin, 'tapsmith-core'),
        TAPSMITH_TELEMETRY: '0',
        HOME: root,
        CI: '',
        GITHUB_ACTIONS: '',
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      reachedDevice: fs.existsSync(marker),
    };
  }

  it.each([
    ['a glob that matches no test file', ['tests/other/*.test.ts']],
    ['a directory with no test files', ['fake-bin']],
    ['a filter that matches no test file path', ['checkout']],
    ['a missing file', ['tests/nope.test.ts']],
  ])('fails with "No tests found" before any device work for %s', (_label, args) => {
    const { status, output, reachedDevice } = run(...args);
    expect(output).toContain('No tests found.');
    expect(output).toContain(`"${args[0]}" matched no test file`);
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('fails with "No tests found" before any device work when --grep selects no test', () => {
    const { status, output, reachedDevice } = run('--grep', 'zzzz');
    expect(output).toContain('No tests found: no test matches grep /zzzz/.');
    expect(output).toContain('  - login > signs in');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it.each([
    ['a glob', ['tests/pw/*.test.ts']],
    ['a directory', ['tests/pw']],
    ['a filter', ['login']],
    ['a matching --grep', ['--grep', 'creates']],
  ])('gets past selection for %s', (_label, args) => {
    const { output, reachedDevice } = run(...args);
    expect(output).not.toContain('No tests found');
    expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(reachedDevice).toBe(true);
  });

  it('warns about an argument that matched nothing and runs the rest', () => {
    const { output, reachedDevice } = run('login', 'zzzz');
    expect(output).toContain('Warning: "zzzz" matched no test file');
    expect(reachedDevice).toBe(true);
  });

  it('reads the test names for --grep in a child, never importing a test file in the CLI process', () => {
    // A test file's top-level code must not run in the process that later
    // imports it for the run: a second evaluation re-runs its side effects,
    // and a helper it imports stays cached with registrations made for the
    // throwaway discovery context.
    const log = path.join(root, 'imports.log');
    fs.writeFileSync(path.join(root, 'tests', 'pw', 'login.test.ts'),
      'import * as fs from "node:fs";\n'
      + `fs.appendFileSync(${JSON.stringify(log)}, (typeof process.send) + "\\n");\n`
      + testFile('login', ['signs in']));
    const { reachedDevice } = run('--grep', 'signs in');
    expect(reachedDevice).toBe(true);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual(['function']);
  });

  it('names the projects\' testMatch when no argument matches in a projects config', () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"] }] };\n');
    const { status, output, reachedDevice } = run('typo');
    expect(output).toContain('"typo" matched no test file');
    expect(output).toContain('(tests/pw/**/*.test.ts)');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });

  it('reports, rather than runs, a named file no project covers', () => {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'x.test.ts'), testFile('x', ['y']));
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'),
      'export default { platform: "android", package: "com.example", launchEmulators: false, '
      + 'projects: [{ name: "pw", testMatch: ["tests/pw/**/*.test.ts"] }] };\n');
    const { status, output, reachedDevice } = run('scripts/x.test.ts');
    expect(output).toContain('scripts/x.test.ts is not matched by any project\'s testMatch');
    expect(status).toBe(1);
    expect(reachedDevice).toBe(false);
  });
});
