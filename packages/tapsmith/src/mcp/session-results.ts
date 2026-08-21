import type { TestDispatcher, TestResultEntry } from './test-dispatcher.js';

// ─── SessionResultsStore ───

/**
 * Test results accumulated across every run in an MCP session.
 *
 * `dispatcher.getResults()` only reflects the most recent run (each run resets
 * it), so batched `tapsmith_run_tests` calls would otherwise lose visibility of
 * earlier batches. The store merges each run's final results, keyed by
 * project/file/test, so `tapsmith_suite_status` can join them with the
 * discovered test tree into a whole-suite board.
 */
/** Statuses that represent an outcome, as opposed to a test still in flight. */
const SETTLED_STATUSES = new Set<TestResultEntry['status']>([
  'passed', 'failed', 'skipped', 'interrupted',
]);

export class SessionResultsStore {
  private readonly _results = new Map<string, TestResultEntry>();

  /** Merge settled results; a later result for the same test wins. */
  merge(results: TestResultEntry[]): void {
    for (const r of results) {
      // Settled statuses only — 'idle' and 'running' say nothing yet. A stopped
      // test belongs here: it did not reach a verdict, but the board saying
      // "not run" would conflate the test we cut short with the ones we never
      // attempted, and disagree with `list_results` about the same run.
      if (!SETTLED_STATUSES.has(r.status)) continue;
      // A real result proves the file ran, which retires the synthetic "failed
      // to run" entry for it. That entry is keyed on a name no real test has,
      // so nothing would ever overwrite it: fix the import error, re-run green,
      // and the board would still report the original failure for the rest of
      // the session.
      if (!r.fileLevelFailure) this._dropFileLevelFailure(r.projectName, r.filePath);
      this._results.set(this._key(r.projectName, r.filePath, r.fullName), r);
    }
  }

  private _dropFileLevelFailure(projectName: string | undefined, filePath: string): void {
    for (const [key, entry] of this._results) {
      if (entry.fileLevelFailure && entry.filePath === filePath && entry.projectName === projectName) {
        this._results.delete(key);
      }
    }
  }

  get(projectName: string | undefined, filePath: string, fullName: string): TestResultEntry | undefined {
    return this._results.get(this._key(projectName, filePath, fullName));
  }

  /** Every result held, for callers that need what the test tree cannot show. */
  all(): TestResultEntry[] {
    return [...this._results.values()];
  }

  private _key(projectName: string | undefined, filePath: string, fullName: string): string {
    return `${projectName ?? ''}::${filePath}::${fullName}`;
  }
}

// One store per underlying device/test session. UI mode creates a separate
// McpServer per connected client, all sharing one dispatcher, so the store is
// keyed off the dispatcher — every client sees the same accumulated board.
const _stores = new WeakMap<TestDispatcher, SessionResultsStore>();

export function getSessionResultsStore(dispatcher: TestDispatcher): SessionResultsStore {
  let store = _stores.get(dispatcher);
  if (!store) {
    store = new SessionResultsStore();
    _stores.set(dispatcher, store);
  }
  return store;
}
