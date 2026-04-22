import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher, TestTreeEntry } from '../test-dispatcher.js';

export function registerListTestsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'pilot_list_tests',
    'List all test files, projects, and test names discovered by the current UI session. Returns the full test tree so you can see describe blocks and individual test names. Use this to find test names before running specific tests with pilot_run_tests.',
    {},
    async () => {
      const tree = dispatcher.getTestTree();
      const projects = dispatcher.getProjects();
      if (tree.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No test files discovered.' }] };
      }

      const lines: string[] = [];
      if (projects.length > 0) {
        lines.push(`Projects: ${projects.join(', ')}`);
        lines.push('');
      }

      formatTree(tree, lines, 0);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

function formatTree(nodes: TestTreeEntry[], lines: string[], depth: number): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth);
    switch (node.type) {
      case 'project':
        lines.push(`${indent}[project] ${node.name}`);
        break;
      case 'file':
        lines.push(`${indent}[file] ${node.filePath}`);
        break;
      case 'suite':
        lines.push(`${indent}[suite] ${node.name}`);
        break;
      case 'test':
        lines.push(`${indent}[test] ${node.name}  —  "${node.fullName}"`);
        break;
    }
    if (node.children) formatTree(node.children, lines, depth + 1);
  }
}
