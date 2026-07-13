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
export class SessionResultsStore {
  private readonly _results = new Map<string, TestResultEntry>();

  /** Merge final (passed/failed/skipped) results; a later result for the same test wins. */
  merge(results: TestResultEntry[]): void {
    for (const r of results) {
      if (r.status !== 'passed' && r.status !== 'failed' && r.status !== 'skipped') continue;
      this._results.set(this._key(r.projectName, r.filePath, r.fullName), r);
    }
  }

  get(projectName: string | undefined, filePath: string, fullName: string): TestResultEntry | undefined {
    return this._results.get(this._key(projectName, filePath, fullName));
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
