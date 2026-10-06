import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Ignoring test results (PILOT-562) ───

/** Where a run writes traces, screenshots and reports by default (`outputDir`). */
const RESULTS_ENTRY = 'tapsmith-results/';
const RESULTS_BLOCK = `# Tapsmith test results (traces, screenshots, reports)\n${RESULTS_ENTRY}\n`;

/** A .gitignore line that already ignores the results directory at any depth or at the root. */
const RESULTS_LINE = /^\/?tapsmith-results(?:\/(?:\*\*?)?)?$/;

/**
 * Whether git already ignores the results directory here — through a
 * repository .gitignore above the project, `.git/info/exclude` or the user's
 * global excludes. False outside a repository or without git.
 */
function gitIgnoresResults(cwd: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', RESULTS_ENTRY], { cwd, stdio: 'ignore', timeout: 5_000 });
  return result.status === 0;
}

/**
 * Makes sure git ignores `tapsmith-results/`, so the first `git status`
 * after a run is not a pile of traces and screenshots (the precedent is
 * create-playwright, which adds `test-results/` and friends). Appends the
 * entry to the project's .gitignore, creating it if there is none, unless
 * it is already listed there or git already ignores the directory. Throws
 * when the file cannot be written; init reports that and carries on.
 */
export function ignoreTestResults(cwd: string, isIgnored: (cwd: string) => boolean = gitIgnoresResults): 'created' | 'added' | 'present' {
  const file = path.join(cwd, '.gitignore');
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing?.split(/\r?\n/).some((line) => RESULTS_LINE.test(line.trim()))) return 'present';
  if (isIgnored(cwd)) return 'present';

  if (existing === undefined) {
    fs.writeFileSync(file, RESULTS_BLOCK);
    return 'created';
  }
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(file, `${separator}${RESULTS_BLOCK}`);
  return 'added';
}

/** ignoreTestResults(), with a failure turned into the warning init prints. */
export function ignoreTestResultsOrWarn(cwd: string): 'created' | 'added' | 'present' | { warning: string } {
  try {
    return ignoreTestResults(cwd);
  } catch (err) {
    return { warning: `Could not add ${RESULTS_ENTRY} to .gitignore (${err instanceof Error ? err.message : String(err)}): add it yourself so test results stay out of git` };
  }
}
