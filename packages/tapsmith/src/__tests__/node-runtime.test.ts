/**
 * The Node.js floor (PILOT-542): one constant, matching `engines.node`, that
 * the CLI's entry checks before loading anything else and `doctor` reports.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  afterEach(() => {
    process.emit = originalEmit;
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

  it('runs the CLI on a supported Node', () => {
    const result = runBin(`${MIN_NODE_MAJOR}.0.0`, ['--version']);
    expect(result.stderr).not.toContain('Tapsmith requires Node.js');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  }, 60_000);
});
