import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTestFiles,
  getTestDiscoveryWatchRoots,
  matchesTestIgnore,
  matchesTestFile,
  relativeTestPath,
} from '../test-file-discovery.js';

describe('test-file-discovery helpers', () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-discovery-'));
    rootDir = path.join(tempDir, 'repo');
    fs.mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('matches configured test files and applies default ignores', () => {
    expect(matchesTestFile(path.join(rootDir, 'tests', 'new.test.ts'), ['**/*.test.ts'], rootDir)).toBe(true);
    expect(matchesTestFile(path.join(rootDir, 'node_modules', 'pkg', 'new.test.ts'), ['**/*.test.ts'], rootDir)).toBe(false);
    expect(matchesTestFile(path.join(rootDir, 'dist', 'new.test.ts'), ['**/*.test.ts'], rootDir)).toBe(false);
  });

  it('applies project ignore patterns', () => {
    const filePath = path.join(rootDir, 'tests', 'smoke-login.test.ts');

    expect(matchesTestFile(filePath, ['tests/**/*.test.ts'], rootDir, ['**/smoke-*.test.ts'])).toBe(false);
  });

  it('resolves relative file paths from the configured rootDir', () => {
    expect(relativeTestPath('tests/new.test.ts', rootDir)).toBe('tests/new.test.ts');
    expect(matchesTestFile('tests/new.test.ts', ['tests/**/*.test.ts'], rootDir)).toBe(true);
  });

  it('matches default ignore patterns for directories and descendants', () => {
    expect(matchesTestIgnore('node_modules')).toBe(true);
    expect(matchesTestIgnore('node_modules/pkg/new.test.ts')).toBe(true);
    expect(matchesTestIgnore('dist')).toBe(true);
    expect(matchesTestIgnore('dist/new.test.ts')).toBe(true);
    expect(matchesTestIgnore('tests/dist.test.ts')).toBe(false);
  });

  it('derives watch roots from the static part of glob patterns', () => {
    fs.mkdirSync(path.join(rootDir, 'e2e', 'tests'), { recursive: true });

    expect(getTestDiscoveryWatchRoots(['e2e/tests/**/*.test.ts', '**/*.spec.ts'], rootDir)).toEqual([
      rootDir,
      path.join(rootDir, 'e2e', 'tests'),
    ]);
  });

  it('falls back to the nearest existing parent for missing test directories', () => {
    fs.mkdirSync(path.join(rootDir, 'e2e'), { recursive: true });

    expect(getTestDiscoveryWatchRoots(['e2e/missing/**/*.test.ts'], rootDir)).toEqual([
      path.join(rootDir, 'e2e'),
    ]);
  });

  describe('discoverTestFiles', () => {
    const touch = (rel: string): void => {
      const file = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    };

    beforeEach(() => {
      for (const rel of [
        'tests/b.test.ts',
        'tests/a.test.ts',
        'tests/nested/deep/c.test.ts',
        'tests/smoke-login.test.ts',
        'tests/helper.ts',
        'top.test.ts',
        '.hidden/dot.test.ts',
        'tests/.cache/dot.test.ts',
        'node_modules/pkg/dep.test.ts',
        'dist/built.test.ts',
        'packages/app/node_modules/pkg/nested-dep.test.ts',
      ]) {
        touch(rel);
      }
    });

    it('returns sorted absolute paths and skips dot-dirs, node_modules and dist', async () => {
      await expect(discoverTestFiles(['**/*.test.ts'], rootDir)).resolves.toEqual([
        path.join(rootDir, 'tests', 'a.test.ts'),
        path.join(rootDir, 'tests', 'b.test.ts'),
        path.join(rootDir, 'tests', 'nested', 'deep', 'c.test.ts'),
        path.join(rootDir, 'tests', 'smoke-login.test.ts'),
        path.join(rootDir, 'top.test.ts'),
      ]);
    });

    it('dedupes files matched by several patterns and applies project ignores', async () => {
      await expect(
        discoverTestFiles(['tests/**/*.test.ts', 'tests/*.test.ts', './top.test.ts'], rootDir, undefined, ['**/smoke-*.test.ts']),
      ).resolves.toEqual([
        path.join(rootDir, 'tests', 'a.test.ts'),
        path.join(rootDir, 'tests', 'b.test.ts'),
        path.join(rootDir, 'tests', 'nested', 'deep', 'c.test.ts'),
        path.join(rootDir, 'top.test.ts'),
      ]);
    });

    it('returns nothing when no file matches', async () => {
      await expect(discoverTestFiles(['missing/**/*.test.ts'], rootDir)).resolves.toEqual([]);
    });

    it('returns explicit files resolved against rootDir without globbing', async () => {
      await expect(discoverTestFiles(['**/*.test.ts'], rootDir, ['tests/a.test.ts', 'tests/a.test.ts', 'nope.ts'])).resolves.toEqual([
        path.join(rootDir, 'tests', 'a.test.ts'),
        path.join(rootDir, 'nope.ts'),
      ]);
    });
  });
});
