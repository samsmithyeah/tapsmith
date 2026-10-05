import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTestFiles,
  getTestDiscoveryWatchRoots,
  matchesTestIgnore,
  matchesTestFile,
  noTestFilesFoundMessage,
  relativeTestPath,
  resolveTestFileArgs,
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
        discoverTestFiles(['tests/**/*.test.ts', 'tests/*.test.ts', './top.test.ts'], rootDir, ['**/smoke-*.test.ts']),
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

  });

  describe('resolveTestFileArgs', () => {
    const touch = (rel: string): string => {
      const file = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      return file;
    };
    let candidates: string[];

    beforeEach(() => {
      candidates = [
        touch('tests/pw/login.test.ts'),
        touch('tests/pw/signup.test.ts'),
        touch('tests/other/Checkout.test.ts'),
        touch('top.test.ts'),
      ].sort();
      touch('tests/pw/helper.ts');
      touch('scripts/standalone.test.ts');
    });

    const resolve = (args: string[], roots = [rootDir]) => resolveTestFileArgs(args, candidates, roots);

    it('keeps an existing file, even one outside testMatch, and dedupes', () => {
      expect(resolve(['tests/pw/login.test.ts', 'scripts/standalone.test.ts', './tests/pw/login.test.ts'])).toEqual({
        files: [path.join(rootDir, 'tests/pw/login.test.ts'), path.join(rootDir, 'scripts/standalone.test.ts')],
        unmatched: [],
      });
    });

    it('accepts an absolute file path', () => {
      const file = path.join(rootDir, 'top.test.ts');
      expect(resolve([file]).files).toEqual([file]);
    });

    it('resolves a relative file from a later root (the working directory) when rootDir lacks it', () => {
      const cwd = path.join(rootDir, 'tests');
      expect(resolve(['pw/signup.test.ts'], [rootDir, cwd]).files).toEqual([path.join(rootDir, 'tests/pw/signup.test.ts')]);
    });

    it('expands a directory to the discovered test files under it, never its helpers', () => {
      expect(resolve(['tests/pw']).files).toEqual([
        path.join(rootDir, 'tests/pw/login.test.ts'),
        path.join(rootDir, 'tests/pw/signup.test.ts'),
      ]);
      expect(resolve(['tests/pw/']).files).toHaveLength(2);
    });

    it('reports a directory that holds no test file as unmatched', () => {
      expect(resolve(['scripts'])).toEqual({ files: [], unmatched: ['scripts'] });
    });

    it('expands a glob over the discovered test files', () => {
      expect(resolve(['tests/pw/*.test.ts']).files).toEqual([
        path.join(rootDir, 'tests/pw/login.test.ts'),
        path.join(rootDir, 'tests/pw/signup.test.ts'),
      ]);
      expect(resolve(['./tests/**/*.test.ts']).files).toHaveLength(3);
      expect(resolve([path.join(rootDir, 'tests/other/*.ts')]).files).toEqual([path.join(rootDir, 'tests/other/Checkout.test.ts')]);
    });

    it('does not let a glob pull in helpers or files outside testMatch', () => {
      expect(resolve(['tests/pw/*']).files).toEqual([
        path.join(rootDir, 'tests/pw/login.test.ts'),
        path.join(rootDir, 'tests/pw/signup.test.ts'),
      ]);
      expect(resolve(['scripts/*.test.ts'])).toEqual({ files: [], unmatched: ['scripts/*.test.ts'] });
    });

    it('treats any other argument as a case-insensitive filter over the test file paths', () => {
      expect(resolve(['login']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['checkout']).files).toEqual([path.join(rootDir, 'tests/other/Checkout.test.ts')]);
      expect(resolve(['pw/']).files).toHaveLength(2);
    });

    it('reads the filter as a regular expression, like Playwright', () => {
      expect(resolve(['(login|signup)\\.test']).files).toHaveLength(2);
      expect(resolve(['/^top\\./']).files).toEqual([path.join(rootDir, 'top.test.ts')]);
    });

    it('reads a regular expression with glob-like characters as a filter when it globs nothing', () => {
      expect(resolve(['login.*test']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['/log.*in/']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['sign(up)?']).files).toEqual([path.join(rootDir, 'tests/pw/signup.test.ts')]);
      expect(resolve(['[ls]\\w+\\.test']).files).toHaveLength(2);
      expect(resolve(['/^tests\\/pw\\/(login|signup)/']).files).toHaveLength(2);
    });

    it('ignores a sticky or global flag, which would carry state from one file to the next', () => {
      expect(resolve(['/login/y']).files).toEqual([path.join(rootDir, 'tests/pw/login.test.ts')]);
      expect(resolve(['/test/gy']).files).toHaveLength(4);
    });

    it('falls back to a literal substring when the filter is not a valid regular expression', () => {
      expect(resolve(['login(']).unmatched).toEqual(['login(']);
    });

    it('matches the filter against the path relative to rootDir, not the rootDir name', () => {
      // rootDir is .../repo: an absolute-path match would select every file.
      expect(resolve(['repo'])).toEqual({ files: [], unmatched: ['repo'] });
    });

    it('reports a missing file as unmatched rather than resolving it literally', () => {
      expect(resolve(['tests/nope.test.ts'])).toEqual({ files: [], unmatched: ['tests/nope.test.ts'] });
    });

    it('keeps the matches of each argument and names only the ones that matched nothing', () => {
      expect(resolve(['signup', 'zzzz', 'login'])).toEqual({
        files: [path.join(rootDir, 'tests/pw/signup.test.ts'), path.join(rootDir, 'tests/pw/login.test.ts')],
        unmatched: ['zzzz'],
      });
    });
  });

  describe('noTestFilesFoundMessage', () => {
    it('says no file matched testMatch when no argument was given', () => {
      const message = noTestFilesFoundMessage({
        args: [], unmatched: [], outsideProjects: [], testMatch: ['**/*.test.ts'], rootDir: '/proj',
      });
      expect(message).toMatch(/^No tests found\./);
      expect(message).toContain('No file under /proj matches testMatch **/*.test.ts');
    });

    it('names every argument that matched nothing and how arguments are read', () => {
      const message = noTestFilesFoundMessage({
        args: ['login', 'tests/nope.test.ts'],
        unmatched: ['login', 'tests/nope.test.ts'],
        outsideProjects: [],
        testMatch: ['tests/**/*.test.ts'],
        rootDir: '/proj',
      });
      expect(message).toMatch(/^No tests found\./);
      expect(message).toContain('"login" matched no test file');
      expect(message).toContain('"tests/nope.test.ts" matched no test file');
      expect(message).toContain('a file, a directory, a glob, or a regular expression matched against the test file paths');
      expect(message).toContain('tests/**/*.test.ts');
    });

    it('names a file no project runs', () => {
      const message = noTestFilesFoundMessage({
        args: ['scripts/x.test.ts'], unmatched: [], outsideProjects: ['scripts/x.test.ts'], testMatch: ['tests/**'], rootDir: '/proj',
      });
      expect(message).toContain('scripts/x.test.ts is not matched by any project\'s testMatch');
    });
  });
});
