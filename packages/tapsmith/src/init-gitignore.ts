import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Ignoring test output (PILOT-562) ───

/**
 * Where runs write by default: `outputDir` (traces, screenshots, JSON and
 * JUnit results) and the HTML reporter's `outputFolder`.
 */
const OUTPUT_ENTRIES = ['tapsmith-results/', 'tapsmith-report/'];
const BLOCK_COMMENT = '# Tapsmith test output (traces, screenshots, reports)';

/** A .gitignore line that already ignores `entry`'s directory at any depth or at the root. */
function listsEntry(line: string, entry: string): boolean {
  const name = entry.replace(/\/$/, '');
  return new RegExp(`^/?${name}(?:/(?:\\*\\*?)?)?$`).test(line.trim());
}

/**
 * The entries git already ignores here — through a repository .gitignore
 * above the project, `.git/info/exclude` or the user's global excludes.
 * None outside a repository or without git.
 */
function gitIgnoredEntries(cwd: string, entries: string[]): string[] {
  const result = spawnSync('git', ['check-ignore', '--no-index', ...entries], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Makes sure git ignores what a run writes, so the first `git status` after
 * one is not a pile of traces, screenshots and reports (the precedent is
 * create-playwright, which adds `test-results/` and `playwright-report/`).
 * Appends the entries missing from the project's .gitignore, creating it if
 * there is none, skipping any it already lists or git already ignores.
 * Throws when the file cannot be written; init reports that and carries on.
 */
export function ignoreTestResults(
  cwd: string,
  ignoredByGit: (cwd: string, entries: string[]) => string[] = gitIgnoredEntries,
): 'created' | 'added' | 'present' {
  const file = path.join(cwd, '.gitignore');
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = existing?.split(/\r?\n/) ?? [];
  let missing = OUTPUT_ENTRIES.filter((entry) => !lines.some((line) => listsEntry(line, entry)));
  if (missing.length > 0) {
    const ignored = new Set(ignoredByGit(cwd, missing));
    missing = missing.filter((entry) => !ignored.has(entry));
  }
  if (missing.length === 0) return 'present';

  const block = `${BLOCK_COMMENT}\n${missing.map((entry) => `${entry}\n`).join('')}`;
  if (existing === undefined) {
    fs.writeFileSync(file, block);
    return 'created';
  }
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(file, `${separator}${block}`);
  return 'added';
}

/** ignoreTestResults(), with a failure turned into the warning init prints. */
export function ignoreTestResultsOrWarn(cwd: string): 'created' | 'added' | 'present' | { warning: string } {
  try {
    return ignoreTestResults(cwd);
  } catch (err) {
    return {
      warning: `Could not add ${OUTPUT_ENTRIES.join(' and ')} to .gitignore (${err instanceof Error ? err.message : String(err)}): add them yourself so test output stays out of git`,
    };
  }
}
