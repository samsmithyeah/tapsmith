/**
 * The Node.js floor (PILOT-542): one constant, matching `engines.node`, that
 * the CLI's entry checks before loading anything else and `doctor` reports.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTsxBin } from '../child-scripts.js';
import {
  MIN_NODE_MAJOR,
  ignoreTypelessPackageWarnings,
  isSupportedNodeVersion,
  unsupportedNodeMessage,
} from '../node-runtime.js';

const PKG_DIR = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf-8')) as {
  engines: { node: string };
  bin: Record<string, string>;
};

describe('MIN_NODE_MAJOR', () => {
  it('is the floor package.json engines declares', () => {
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
  });
});

describe('isSupportedNodeVersion()', () => {
  it('requires the floor major or newer', () => {
    expect(isSupportedNodeVersion('18.20.4')).toBe(false);
    expect(isSupportedNodeVersion('20.20.0')).toBe(false);
    expect(isSupportedNodeVersion('21.9.0')).toBe(false);
    expect(isSupportedNodeVersion('22.0.0')).toBe(true);
    expect(isSupportedNodeVersion('24.13.0')).toBe(true);
    expect(isSupportedNodeVersion('26.1.0')).toBe(true);
  });
});

describe('unsupportedNodeMessage()', () => {
  it('names the running version, the floor and the fix', () => {
    const message = unsupportedNodeMessage('20.20.0');
    expect(message).toContain('Node.js 20.20.0');
    expect(message).toContain(`Tapsmith requires Node.js ${MIN_NODE_MAJOR} or newer`);
    expect(message).toContain('https://nodejs.org');
  });
});

describe('ignoreTypelessPackageWarnings()', () => {
  const originalEmit = process.emit;
  const originalArgv = [...process.execArgv];
  afterEach(() => {
    process.emit = originalEmit;
    process.execArgv.splice(0, process.execArgv.length, ...originalArgv);
  });

  it('drops only MODULE_TYPELESS_PACKAGE_JSON warnings', () => {
    const seen: string[] = [];
    const listener = (warning: Error): void => {
      seen.push((warning as Error & { code?: string }).code ?? warning.message);
    };
    // Only ours: Node's own listener would print the warning that passes.
    const nodeListeners = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', listener);
    try {
      ignoreTypelessPackageWarnings();
      const typeless = Object.assign(new Error('Module type of file:///x.js is not specified'), { name: 'Warning', code: 'MODULE_TYPELESS_PACKAGE_JSON' });
      const other = Object.assign(new Error('something else'), { name: 'Warning', code: 'OTHER_WARNING' });
      process.emit('warning', typeless);
      process.emit('warning', other);
    } finally {
      process.off('warning', listener);
      for (const l of nodeListeners) process.on('warning', l);
    }
    expect(seen).toEqual(['OTHER_WARNING']);
  });
});

describe('ignoreTypelessPackageWarnings() in forked children', () => {
  // Workers, UI mode, watch and MCP fork children that natively import the
  // user's `.js` tests; the shebang flag used to reach them via execArgv.
  // Plain node, not tsx (whose loader hides the warning), so this runs the
  // built module: CI builds dist/ before the unit tests.
  const distRuntime = path.join(PKG_DIR, 'dist', 'node-runtime.js');
  const originalExecArgv = [...process.execArgv];
  let dir: string | undefined;
  afterEach(() => {
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    process.emit = originalEmitForFork;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const originalEmitForFork = process.emit;

  it('are forked with the warning disabled', () => {
    ignoreTypelessPackageWarnings();
    expect(process.execArgv).toContain('--disable-warning=MODULE_TYPELESS_PACKAGE_JSON');
  });

  function runParent(ignore: boolean): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-typeless-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"typeless"}\n');
    fs.writeFileSync(path.join(dir, 'esm.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'child.mjs'), "await import('./esm.js');\n");
    fs.writeFileSync(path.join(dir, 'parent.mjs'), [
      "import { fork } from 'node:child_process';",
      `import { ignoreTypelessPackageWarnings } from ${JSON.stringify(pathToFileURL(distRuntime).href)};`,
      ignore ? 'ignoreTypelessPackageWarnings();' : '',
      "const child = fork(new URL('./child.mjs', import.meta.url).pathname, [], { stdio: 'inherit' });",
      "await new Promise((resolve) => child.on('exit', resolve));",
    ].join('\n'));
    const result = spawnSync(process.execPath, [path.join(dir, 'parent.mjs')], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    return result.stderr;
  }

  // Node detects module syntax in typeless .js files, and warns about it, from
  // 22.7; on 22.0–22.6 there is no warning to drop.
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeWarns = major > 22 || (major === 22 && minor >= 7);

  it.skipIf(!fs.existsSync(distRuntime) || !nodeWarns)('do not print the warning (built dist/)', () => {
    // Control first: without the call, a forked child on this Node warns.
    expect(runParent(false)).toContain('MODULE_TYPELESS_PACKAGE_JSON');
    expect(runParent(true)).not.toContain('MODULE_TYPELESS_PACKAGE_JSON');
  }, 60_000);
});

// ─── The bin entry ───

describe('the tapsmith bin', () => {
  const tsx = resolveTsxBin(PKG_DIR);
  const binSrc = path.join(PKG_DIR, 'src', 'bin.ts');

  /** Run src/bin.ts under tsx, with `process.versions.node` reporting `version`. */
  function runBin(version: string, args: string[]): SpawnSyncReturns<string> {
    const spoof = `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'${version}'})`;
    return spawnSync(tsx!, [binSrc, ...args], {
      cwd: PKG_DIR,
      encoding: 'utf-8',
      env: { ...process.env, NODE_OPTIONS: `--import=${spoof}`, NO_COLOR: '1' },
      timeout: 60_000,
    });
  }

  it('is dist/bin.js, run by plain node with no flags', () => {
    // A shebang flag older Node does not know (`--disable-warning` is
    // 20.11+) fails as "node: bad option" before the version check runs.
    expect(pkg.bin.tapsmith).toBe('dist/bin.js');
    const firstLine = fs.readFileSync(binSrc, 'utf-8').split('\n')[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('refuses an unsupported Node with the message and exit code 1', () => {
    const result = runBin('20.20.0', ['--version']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(unsupportedNodeMessage('20.20.0'));
    expect(result.stdout).toBe('');
  }, 60_000);

  it('answers --json with the error envelope on stdout', () => {
    // docs/api-reference.md "JSON output": one JSON document on stdout, even on failure.
    const result = runBin('20.20.0', ['doctor', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: 'UNSUPPORTED_NODE',
        message: `You are running Node.js 20.20.0. Tapsmith requires Node.js ${MIN_NODE_MAJOR} or newer.`,
        fix: `Install Node.js ${MIN_NODE_MAJOR} or newer (https://nodejs.org), then run the command again.`,
      },
    });
  }, 60_000);

  it('runs the CLI on a supported Node', () => {
    const result = runBin(`${MIN_NODE_MAJOR}.0.0`, ['--version']);
    expect(result.stderr).not.toContain('Tapsmith requires Node.js');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  }, 60_000);
});
