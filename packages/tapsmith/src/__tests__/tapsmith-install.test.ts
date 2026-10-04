import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isMissingTapsmithError,
  isTapsmithResolvableFrom,
  tapsmithInstallCommand,
} from '../config.js';

// `npx tapsmith init` and a global install run Tapsmith from outside the
// project, so the config and tests it writes import a package the project
// does not have (PILOT-551).

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-install-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function installTapsmithStub(at: string): void {
  write(path.join(at, 'node_modules/tapsmith/package.json'), '{ "name": "tapsmith", "exports": { ".": { "default": "./index.js" } } }\n');
  write(path.join(at, 'node_modules/tapsmith/index.js'), 'export {};\n');
}

describe('isTapsmithResolvableFrom()', () => {
  it('is false for a project without tapsmith', () => {
    write('package.json', '{}\n');
    expect(isTapsmithResolvableFrom(dir)).toBe(false);
  });

  it('is true when tapsmith is in the project\'s node_modules', () => {
    installTapsmithStub('.');
    expect(isTapsmithResolvableFrom(dir)).toBe(true);
  });

  it('is true from a subdirectory when an ancestor has it (a monorepo root)', () => {
    installTapsmithStub('.');
    fs.mkdirSync(path.join(dir, 'apps/mobile'), { recursive: true });
    expect(isTapsmithResolvableFrom(path.join(dir, 'apps/mobile'))).toBe(true);
  });
});

describe('tapsmithInstallCommand()', () => {
  it('defaults to npm when nothing names a package manager', async () => {
    write('package.json', '{}\n');
    expect(await tapsmithInstallCommand(dir)).toEqual({ command: 'npm', args: ['i', '-D', 'tapsmith'], display: 'npm i -D tapsmith' });
  });

  it.each([
    ['package-lock.json', 'npm i -D tapsmith'],
    ['yarn.lock', 'yarn add -D tapsmith'],
    ['pnpm-lock.yaml', 'pnpm add -D tapsmith'],
    ['bun.lock', 'bun add -D tapsmith'],
  ])('follows the lockfile %s', async (lockfile, display) => {
    write('package.json', '{}\n');
    write(lockfile, '');
    expect((await tapsmithInstallCommand(dir)).display).toBe(display);
  });

  it('follows the packageManager field', async () => {
    write('package.json', '{ "packageManager": "pnpm@9.1.0" }\n');
    expect((await tapsmithInstallCommand(dir)).display).toBe('pnpm add -D tapsmith');
  });

  it('finds a workspace root\'s lockfile from a subdirectory', async () => {
    write('yarn.lock', '');
    write('apps/mobile/package.json', '{}\n');
    expect((await tapsmithInstallCommand(path.join(dir, 'apps/mobile'))).display).toBe('yarn add -D tapsmith');
  });
});

describe('isMissingTapsmithError()', () => {
  const missing = (message: string, code: string): Error => Object.assign(new Error(message), { code });

  it('recognises the CommonJS error', () => {
    expect(isMissingTapsmithError(missing("Cannot find module 'tapsmith'\nRequire stack:\n- /p/tapsmith.config.ts", 'MODULE_NOT_FOUND'))).toBe(true);
  });

  it('recognises the ESM error', () => {
    expect(isMissingTapsmithError(missing("Cannot find package 'tapsmith' imported from /p/tapsmith.config.ts", 'ERR_MODULE_NOT_FOUND'))).toBe(true);
  });

  it('recognises a tapsmith subpath', () => {
    expect(isMissingTapsmithError(missing("Cannot find module 'tapsmith/trace-format.schema.json'", 'MODULE_NOT_FOUND'))).toBe(true);
  });

  it.each([
    ["Cannot find module 'tapsmith-helpers'", 'MODULE_NOT_FOUND'],
    ["Cannot find package '@acme/tapsmith' imported from /p/x.ts", 'ERR_MODULE_NOT_FOUND'],
    ["Cannot find module './tapsmith'", 'MODULE_NOT_FOUND'],
    ["Cannot find module 'tapsmith'", 'SOME_OTHER_CODE'],
  ])('does not mistake %s (%s) for it', (message, code) => {
    expect(isMissingTapsmithError(missing(message, code))).toBe(false);
  });

  it('is false for non-errors', () => {
    expect(isMissingTapsmithError(undefined)).toBe(false);
    expect(isMissingTapsmithError("Cannot find module 'tapsmith'")).toBe(false);
  });
});
