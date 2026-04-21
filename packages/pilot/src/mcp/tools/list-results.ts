import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerListResultsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'pilot_list_results',
    'List test results from the current UI session. Shows pass/fail/skip status, duration, and error messages for each test. Use after a test run to inspect results or check which tests failed.',
    {
      status: z.enum(['passed', 'failed', 'skipped']).optional().describe('Filter by status'),
      file: z.string().optional().describe('Filter by file path substring'),
    },
    async ({ status, file }) => {
      let results = dispatcher.getResults();

      if (status) results = results.filter((r) => r.status === status);
      if (file) results = results.filter((r) => r.filePath.includes(file));

      if (results.length === 0) {
        const msg = dispatcher.getResults().length === 0
          ? 'No test results yet. Run tests first with pilot_run_tests.'
          : 'No results match the filter.';
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      const lines: string[] = [];
      const passed = results.filter((r) => r.status === 'passed').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      lines.push(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)\n`);

      for (const r of results) {
        const icon = r.status === 'passed' ? 'PASS' : r.status === 'failed' ? 'FAIL' : 'SKIP';
        const dur = r.duration != null ? ` (${r.duration}ms)` : '';
        const proj = r.projectName ? ` [${r.projectName}]` : '';
        lines.push(`[${icon}] ${r.fullName}${dur}${proj}`);
        lines.push(`       ${r.filePath}`);
        if (r.error) lines.push(`       Error: ${r.error}`);
        if (r.tracePath) lines.push(`       Trace: ${r.tracePath}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
