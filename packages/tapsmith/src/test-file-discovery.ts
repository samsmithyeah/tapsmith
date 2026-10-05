import * as path from 'node:path';
import * as fs from 'node:fs';
import { glob } from 'glob';
import { minimatch } from 'minimatch';

export const DEFAULT_TEST_IGNORE = ['**/node_modules/**', '**/dist/**'];

export async function discoverTestFiles(
  patterns: string[],
  rootDir: string,
  extraIgnore?: string[],
): Promise<string[]> {
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

// ─── Positional test-file arguments ───

export interface TestFileArgResolution {
  /** Absolute paths, each argument's matches in order, deduplicated. */
  files: string[];
  /** The arguments that selected no file, as given. */
  unmatched: string[];
}

/**
 * Resolve `tapsmith test [args...]` to test files, the way Playwright reads
 * its positional arguments — before any device or daemon work, so an argument
 * that matches nothing fails at once instead of after device setup.
 *
 * Each argument is, in order of precedence:
 * - an existing file (absolute, or relative to the first of `roots` that has
 *   it): selected as is, even outside `testMatch`, so naming a file always
 *   runs it;
 * - an existing directory: the discovered test files under it;
 * - a glob: the discovered test files it matches, relative to any root or as
 *   an absolute pattern;
 * - anything else: a filter over the discovered test files' paths relative to
 *   `roots[0]` (rootDir) — a case-insensitive regular expression (`/re/flags`
 *   for explicit flags), or a literal substring when it is not a valid one.
 *   Playwright matches the absolute path; the relative one keeps a filter from
 *   matching every file through the name of a directory above them.
 *
 * Directories, globs and filters select only from `candidates` (the files
 * `testMatch` discovered), so they never pull a helper module in as a test.
 */
export function resolveTestFileArgs(
  args: string[],
  candidates: string[],
  roots: string[],
): TestFileArgResolution {
  const rootDir = roots[0];
  const files = new Set<string>();
  const unmatched: string[] = [];

  for (const arg of args) {
    const matches = matchTestFileArg(arg, candidates, roots, rootDir);
    if (matches.length === 0) unmatched.push(arg);
    for (const file of matches) files.add(file);
  }

  return { files: [...files], unmatched };
}

/**
 * The "No tests found" error for a run whose file selection came out empty:
 * what each argument failed to select, and how arguments are read.
 */
export function noTestFilesFoundMessage(opts: {
  args: string[];
  unmatched: string[];
  outsideProjects: string[];
  testMatch: string[];
  rootDir: string;
}): string {
  const lines = ['No tests found.'];
  const testMatch = opts.testMatch.join(', ');
  if (opts.args.length === 0) {
    lines.push(`No file under ${opts.rootDir} matches testMatch ${testMatch}.`);
    return lines.join('\n');
  }
  for (const arg of opts.unmatched) {
    lines.push(`  "${arg}" matched no test file.`);
  }
  for (const file of opts.outsideProjects) {
    lines.push(`  ${file} is not matched by any project's testMatch, so no project runs it.`);
  }
  lines.push(
    'Each argument is a file, a directory, a glob, or a regular expression matched against the test file paths '
    + `(relative to ${opts.rootDir}); directories, globs and expressions select among the files testMatch discovers (${testMatch}).`,
  );
  return lines.join('\n');
}

function matchTestFileArg(arg: string, candidates: string[], roots: string[], rootDir: string): string[] {
  for (const root of roots) {
    const resolved = path.resolve(root, arg);
    const stat = statOrUndefined(resolved);
    if (stat?.isFile()) return [resolved];
    if (stat?.isDirectory()) {
      const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
      return candidates.filter((file) => file.startsWith(prefix));
    }
  }

  if (normalizeGlobPattern(arg).split('/').some(hasGlobMagic)) {
    const pattern = normalizeGlobPattern(arg).replace(/^\.\//, '');
    return candidates.filter((file) => {
      if (minimatch(normalizeGlobPattern(file), pattern)) return true;
      return roots.some((root) => {
        const relative = relativeTestPath(file, root);
        return !relative.startsWith('../') && minimatch(relative, pattern);
      });
    });
  }

  const filter = testFileFilter(arg);
  return candidates.filter((file) => filter(relativeTestPath(file, rootDir)));
}

function testFileFilter(arg: string): (relativePath: string) => boolean {
  const explicit = /^\/(.+)\/([a-z]*)$/.exec(arg);
  try {
    const re = explicit ? new RegExp(explicit[1], explicit[2].replace('g', '')) : new RegExp(arg, 'i');
    return (relativePath) => re.test(relativePath);
  } catch {
    const needle = arg.toLowerCase();
    return (relativePath) => relativePath.toLowerCase().includes(needle);
  }
}

function statOrUndefined(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
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

  for (const pattern of DEFAULT_TEST_IGNORE) {
    if (matchesIgnorePattern(relative, pattern)) return true;
  }
  if (extraIgnore) {
    for (const pattern of extraIgnore) {
      if (matchesIgnorePattern(relative, pattern)) return true;
    }
  }
  return false;
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
