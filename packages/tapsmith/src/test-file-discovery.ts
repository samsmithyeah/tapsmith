import * as path from 'node:path';
import * as fs from 'node:fs';
import { glob } from 'glob';
import { minimatch } from 'minimatch';

export const DEFAULT_TEST_IGNORE = ['**/node_modules/**', '**/dist/**'];

export async function discoverTestFiles(
  patterns: string[],
  rootDir: string,
  explicitFiles?: string[],
  extraIgnore?: string[],
): Promise<string[]> {
  if (explicitFiles && explicitFiles.length > 0) {
    return explicitFiles.map((f) => path.resolve(rootDir, f));
  }

  const ignore = [...DEFAULT_TEST_IGNORE, ...(extraIgnore ?? [])];
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      absolute: true,
      ignore,
    });
    files.push(...matches);
  }

  return [...new Set(files)].sort();
}

export function relativeTestPath(filePath: string, rootDir: string): string {
  return path
    .relative(rootDir, path.resolve(rootDir, filePath))
    .split(path.sep)
    .join('/');
}

export function matchesTestFile(
  filePath: string,
  patterns: string[],
  rootDir: string,
  extraIgnore?: string[],
): boolean {
  const relative = relativeTestPath(filePath, rootDir);
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false;

  if (matchesTestIgnore(relative, extraIgnore)) return false;
  return patterns.some((pattern) => minimatch(relative, normalizeGlobPattern(pattern)));
}

export function matchesTestIgnore(relativePath: string, extraIgnore?: string[]): boolean {
  const relative = normalizeGlobPattern(relativePath).replace(/\/+$/, '');
  if (!relative) return false;

  const ignore = [...DEFAULT_TEST_IGNORE, ...(extraIgnore ?? [])];
  return ignore.some((pattern) => matchesIgnorePattern(relative, pattern));
}

export function getTestDiscoveryWatchRoots(patterns: string[], rootDir: string): string[] {
  const roots = new Set<string>();
  for (const pattern of patterns) {
    let candidate = path.resolve(rootDir, staticDirectoryPrefix(pattern));
    const relative = path.relative(rootDir, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      candidate = rootDir;
    }
    while (!isExistingDirectory(candidate) && candidate !== rootDir) {
      candidate = path.dirname(candidate);
    }
    roots.add(candidate);
  }
  return [...roots].sort();
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll('\\', '/');
}

function matchesIgnorePattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeGlobPattern(pattern);
  return minimatch(relativePath, normalizedPattern)
    || minimatch(`${relativePath}/__tapsmith_ignore_probe__`, normalizedPattern);
}

function staticDirectoryPrefix(pattern: string): string {
  const normalized = normalizeGlobPattern(pattern).replace(/^\.\//, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  const firstGlob = parts.findIndex(hasGlobMagic);
  const staticParts = firstGlob >= 0
    ? parts.slice(0, firstGlob)
    : parts.slice(0, Math.max(0, parts.length - 1));
  return path.join(...staticParts);
}

function hasGlobMagic(part: string): boolean {
  return /[*?[\]{}]/.test(part) || /^[!+@?*]\(.+\)$/.test(part);
}

function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
