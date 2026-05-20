import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTestDiscoveryWatchRoots,
  matchesTestFile,
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
});
