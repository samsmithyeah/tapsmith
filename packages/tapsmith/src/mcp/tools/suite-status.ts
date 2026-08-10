import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher, TestTreeEntry } from '../test-dispatcher.js';
import { getSessionResultsStore } from '../session-results.js';

type SuiteTestStatus = 'passed' | 'failed' | 'skipped' | 'not run';

interface SuiteTestRow {
  projectName?: string
  filePath: string
  fullName: string
  status: SuiteTestStatus
  error?: string
}

export function registerSuiteStatusTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_suite_status',
    'Report the status of every test in the discovered test tree — passed, failed, skipped, or not run — accumulated across all test runs in this MCP session. Unlike tapsmith_list_results (which only covers the most recent run), results build up across batched tapsmith_run_tests calls, so this shows the complete suite board including tests that have not run yet.',
    {
      file: z.string().optional().describe('Filter by file path substring'),
      details: z.boolean().optional().describe('List every test with its status (default false: per-file counts plus failed test names)'),
    },
    async ({ file, details }) => {
      await dispatcher.ensureInitialized?.();
      const store = getSessionResultsStore(dispatcher);
      // Read-time merge: also captures runs this tool never saw start
      // (e.g. triggered from the UI or another attached MCP client).
      store.merge(dispatcher.getResults());

      const tree = dispatcher.getTestTree();
      if (tree.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No test files discovered.' }] };
      }

      let rows: SuiteTestRow[] = [];
      collectRows(tree, undefined, store, rows);
      if (file) rows = rows.filter((r) => r.filePath.includes(file));
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No tests match the filter.' }] };
      }

      const lines: string[] = [];
      const total = rows.length;
      const counts = countByStatus(rows);
      const run = total - counts['not run'];
      lines.push(`Suite status: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts['not run']} not run (${run}/${total} tests run)`);
      if (dispatcher.isRunning()) {
        lines.push('A test run is in progress — counts update as tests finish.');
      }
      lines.push('');

      // Group by project + file, preserving tree order.
      const groups = new Map<string, SuiteTestRow[]>();
      for (const row of rows) {
        const key = `${row.projectName ?? ''}::${row.filePath}`;
        const list = groups.get(key);
        if (list) list.push(row);
        else groups.set(key, [row]);
      }

      for (const groupRows of groups.values()) {
        const { projectName, filePath } = groupRows[0];
        const proj = projectName ? ` [${projectName}]` : '';
        const fileCounts = countByStatus(groupRows);
        const summary = (Object.entries(fileCounts) as Array<[SuiteTestStatus, number]>)
          .filter(([, n]) => n > 0)
          .map(([status, n]) => `${n} ${status}`)
          .join(', ');
        lines.push(`${filePath}${proj}: ${summary}`);
        for (const row of groupRows) {
          if (details) {
            lines.push(`  [${statusIcon(row.status)}] ${row.fullName}`);
            if (row.error) lines.push(`         Error: ${row.error}`);
          } else if (row.status === 'failed') {
            lines.push(`  FAIL: ${row.fullName}${row.error ? ` — ${row.error}` : ''}`);
          }
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

/**
 * Flatten the test tree into one row per test leaf, joined with the session's
 * accumulated results. Tests without a recorded result are 'not run'. Project
 * nodes set the projectName for everything beneath them, matching how run
 * results are keyed.
 *
 * A project node's name is used as-is. The dispatcher only builds project
 * nodes when the config declares projects of its own, so a node named
 * "default" is a project the user named that — and its results are recorded
 * under that name. Mapping it to `undefined` here missed every one of them and
 * reported a completed run as entirely 'not run'.
 */
function collectRows(
  nodes: TestTreeEntry[],
  projectName: string | undefined,
  store: ReturnType<typeof getSessionResultsStore>,
  out: SuiteTestRow[],
): void {
  for (const node of nodes) {
    if (node.type === 'test') {
      const result = store.get(projectName, node.filePath, node.fullName);
      out.push({
        projectName,
        filePath: node.filePath,
        fullName: node.fullName,
        status: result ? (result.status as SuiteTestStatus) : 'not run',
        error: result?.error,
      });
    }
    if (node.children) {
      const childProject = node.type === 'project' ? node.name : projectName;
      collectRows(node.children, childProject, store, out);
    }
  }
}

function countByStatus(rows: SuiteTestRow[]): Record<SuiteTestStatus, number> {
  const counts: Record<SuiteTestStatus, number> = { passed: 0, failed: 0, skipped: 0, 'not run': 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

function statusIcon(status: SuiteTestStatus): string {
  switch (status) {
    case 'passed': return 'PASS';
    case 'failed': return 'FAIL';
    case 'skipped': return 'SKIP';
    case 'not run': return ' -- ';
  }
}
