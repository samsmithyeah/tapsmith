import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerListTestsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'pilot_list_tests',
    'List all test files and projects discovered by the current UI session. Use this to find available test files and project names before running them with pilot_run_tests.',
    {},
    async () => {
      const files = dispatcher.getTestFiles();
      const projects = dispatcher.getProjects();
      if (files.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No test files discovered.' }] };
      }
      const parts: string[] = [];
      if (projects.length > 0) {
        parts.push(`Projects: ${projects.join(', ')}`);
        parts.push('');
      }
      parts.push(`${files.length} test file(s):`);
      parts.push('');
      parts.push(...files);
      return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
    },
  );
}
