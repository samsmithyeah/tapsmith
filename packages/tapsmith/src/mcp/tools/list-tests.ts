import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DiscoveryError, TestDispatcher, TestTreeEntry } from '../test-dispatcher.js';

/** Errors listed in full before collapsing to a count. */
const MAX_LISTED_DISCOVERY_ERRORS = 10;

export function registerListTestsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_list_tests',
    'List all test files, projects, and test names discovered by the current MCP test session. Returns the full test tree grouped by project (e.g. "android", "ios"), with absolute file paths, describe blocks, and individual test names. Call this before tapsmith_run_tests to get the exact file paths, test names, and project names needed as arguments.',
    {},
    async () => {
      await dispatcher.ensureInitialized?.();
      const tree = dispatcher.getTestTree();
      const projects = dispatcher.getProjects();
      const failures = dispatcher.getDiscoveryErrors?.() ?? [];
      if (tree.length === 0 && failures.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No test files discovered.' }] };
      }

      const lines: string[] = [];
      if (projects.length > 0) {
        lines.push(`Projects: ${projects.join(', ')}`);
        lines.push('');
      }

      formatTree(tree, lines, 0);
      appendDiscoveryErrors(failures, lines);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

/**
 * Report files that failed to load. Without this the list simply comes up
 * short, and a caller has no way to tell "this file has no tests" from "this
 * file could not be imported" — so it reasons about a suite it cannot see.
 */
function appendDiscoveryErrors(failures: DiscoveryError[], lines: string[]): void {
  if (failures.length === 0) return;

  if (lines.length > 0) lines.push('');
  lines.push(
    `WARNING: ${failures.length} test file(s) failed to load and are missing from the list above. `
    + 'They cannot be run until the error is fixed.',
  );
  for (const failure of failures.slice(0, MAX_LISTED_DISCOVERY_ERRORS)) {
    lines.push(`  ${failure.filePath}: ${failure.error}`);
  }
  const remaining = failures.length - MAX_LISTED_DISCOVERY_ERRORS;
  if (remaining > 0) lines.push(`  … and ${remaining} more`);
}

function formatTree(nodes: TestTreeEntry[], lines: string[], depth: number): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth);
    const iso = formatIsolation(node.use);
    switch (node.type) {
      case 'project':
        lines.push(`${indent}[project] ${node.name}${iso}`);
        break;
      case 'file':
        lines.push(`${indent}[file] ${node.filePath}${iso}`);
        break;
      case 'suite':
        lines.push(`${indent}[suite] ${node.name}${iso}`);
        break;
      case 'test':
        lines.push(`${indent}[test] ${node.name}  —  "${node.fullName}"${iso}`);
        break;
    }
    if (node.children) formatTree(node.children, lines, depth + 1);
  }
}

/**
 * The isolation a node declares (`test.use({ appReset, appResetScope,
 * appState })`, or project-level `use`), so an MCP client can explain why a
 * test resets the way it does. Nothing for the implicit default — the tree
 * stays compact unless a file opts into something.
 */
function formatIsolation(use: TestTreeEntry['use']): string {
  if (!use) return '';
  const parts: string[] = [];
  if (use.appReset !== undefined) parts.push(`appReset: ${use.appReset}`);
  if (use.appResetScope !== undefined) parts.push(`appResetScope: ${use.appResetScope}`);
  if (use.appState !== undefined) parts.push(`appState: ${use.appState === '' ? '"" (cleared)' : use.appState}`);
  return parts.length > 0 ? `  {${parts.join(', ')}}` : '';
}
