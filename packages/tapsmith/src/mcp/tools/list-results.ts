import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { readTraceSummary } from './trace-utils.js';
import { matchesTestFilter } from '../../test-filter.js';
import { clipText, MCP_TEXT_BUDGET_BYTES, serializedTextBytes } from '../response-limits.js';

// ─── Response size ───
//
// This is where an agent comes back for every failure a bounded run_tests
// summary left out, so it must fit one MCP response itself (PILOT-657) and
// still reach any one result in full: errors are clipped while several
// results are listed, shown whole once the filters leave one, and results past
// the budget are counted rather than cut mid-entry.

/** An error's length while several results are listed. */
const LISTED_ERROR_CHARS = 2_000;
const LINE_CHARS = 500;
/** Text for the result entries, under the response budget with room for the header and note. */
const ENTRIES_BUDGET_BYTES = MCP_TEXT_BUDGET_BYTES - 4 * 1024;

export function registerListResultsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_list_results',
    'List test results from the most recent test run. Shows pass/fail/skip status, duration, and error messages for each test. Use after a test run to inspect results or check which tests failed. Pass details=true to include trace steps for failed tests. Long output is bounded: errors are shortened while several results are listed (filter down to one test to see its error in full), and results past the response limit are counted, not shown. Only covers the latest run — use tapsmith_suite_status for status accumulated across every run in the session, including tests that have not run yet.',
    {
      status: z.enum(['passed', 'failed', 'skipped']).optional().describe('Filter by status'),
      file: z.string().optional().describe('Filter by file path substring'),
      test: z.string().optional().describe('Filter by test name: a case-insensitive substring of "Describe > test name", as tapsmith_run_tests\' `test` matches it'),
      details: z.boolean().optional().describe('Include trace steps for failed tests (default false)'),
    },
    async ({ status, file, test, details }) => {
      let results = dispatcher.getResults();

      if (status) results = results.filter((r) => r.status === status);
      if (file) results = results.filter((r) => r.filePath.includes(file));
      if (test) results = results.filter((r) => matchesTestFilter(r.fullName, test));

      if (results.length === 0) {
        const msg = dispatcher.getResults().length === 0
          ? 'No test results yet. Run tests first with tapsmith_run_tests.'
          : 'No results match the filter.';
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      const lines: string[] = [];
      const passed = results.filter((r) => r.status === 'passed').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      const interrupted = results.filter((r) => r.status === 'interrupted').length;
      // Named only when it happened, so an ordinary run reads as it always has.
      const stopped = interrupted > 0 ? `, ${interrupted} interrupted` : '';
      lines.push(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped${stopped} (${results.length} total)\n`);

      // One result is what an agent filters down to for the whole error.
      const clip = (value: string, max: number, hint?: string): string =>
        results.length === 1 ? value : clipText(value, max, hint);
      let entriesBytes = 0;
      for (const [index, r] of results.entries()) {
        const entry: string[] = [];
        const icon = r.status === 'passed'
          ? 'PASS'
          : r.status === 'failed'
            ? 'FAIL'
            : r.status === 'interrupted' ? 'STOP' : 'SKIP';
        const dur = r.duration != null ? ` (${r.duration}ms)` : '';
        const proj = r.projectName ? ` [${r.projectName}]` : '';
        entry.push(`[${icon}] ${r.fullName}${dur}${proj}`);
        entry.push(`       ${r.filePath}`);
        if (r.error) entry.push(`       Error: ${clip(r.error, LISTED_ERROR_CHARS, 'pass this test\'s name as `test` to see it in full')}`);
        for (const w of r.warnings ?? []) entry.push(`       Warning: ${clip(w, LINE_CHARS)}`);
        if (details && r.status === 'failed' && r.tracePath) {
          const summary = readTraceSummary(r.tracePath);
          if (summary) {
            if (summary.steps.length > 0) {
              entry.push('');
              entry.push('       Steps leading to failure:');
              for (const step of summary.steps) entry.push(`         ${clip(step, LINE_CHARS)}`);
            }
            if (summary.deviceLogs.length > 0) {
              entry.push('');
              entry.push('       Device logs (errors/warnings):');
              for (const log of summary.deviceLogs) entry.push(`         ${clip(log, LINE_CHARS)}`);
            }
            entry.push('');
          }
        }
        if (r.tracePath) entry.push(`       Trace: ${r.tracePath}`);

        const entryBytes = serializedTextBytes(entry.join('\n')) + 1;
        // The first entry always goes in; the response boundary bounds it.
        if (index > 0 && entriesBytes + entryBytes > ENTRIES_BUDGET_BYTES) {
          lines.push('');
          lines.push(`... ${results.length - index} more result(s) not shown: the list reached the MCP response limit. Narrow it with the status, file or test filters.`);
          break;
        }
        entriesBytes += entryBytes;
        lines.push(...entry);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
