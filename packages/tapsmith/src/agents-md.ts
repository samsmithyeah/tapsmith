/**
 * AGENTS.md scaffolding — gives the user's coding agent durable instructions
 * for running and debugging tapsmith tests. The section is fenced with
 * markers so re-running `tapsmith init` updates it idempotently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const AGENTS_BEGIN = '<!-- tapsmith:begin -->';
export const AGENTS_END = '<!-- tapsmith:end -->';

export function renderAgentsSection(): string {
  return `${AGENTS_BEGIN}
## Mobile testing with Tapsmith

This project uses [Tapsmith](https://github.com/tapsmith/tapsmith) for mobile E2E tests (Playwright-style API).

### Running tests

- Run all tests: \`npx tapsmith test\`
- Run one file: \`npx tapsmith test tests/example.test.ts\`
- Filter by name: \`npx tapsmith test --grep "login"\`
- Machine-readable results: \`npx tapsmith test --reporter json\` (writes \`tapsmith-results/results.json\`)
- Config lives in \`tapsmith.config.ts\`.

### Writing tests

- Prefer accessibility-first selectors: \`device.getByRole('button', { name: 'Login' })\`, \`device.getByText('Welcome')\`. Avoid className/xpath.
- Assertions auto-wait: \`await expect(device.getByText('Done')).toBeVisible()\`.

### Debugging failures

- Environment problems: \`npx tapsmith doctor --json\` (each failing check includes a \`fix\`).
- Verify the whole setup end-to-end: \`npx tapsmith verify --json\`.
- Failed runs record traces; open with \`npx tapsmith show-trace <trace.zip>\`.

### MCP server (recommended)

Register the Tapsmith MCP server to inspect the live app, validate selectors, and run tests from your agent:

- Claude Code: \`claude mcp add tapsmith -- npx tapsmith mcp-server\`
- Codex: \`codex mcp add tapsmith -- npx tapsmith mcp-server\`

Key tools: \`tapsmith_snapshot\` (accessibility tree + suggested selectors), \`tapsmith_test_selector\`, \`tapsmith_run_tests\`, \`tapsmith_read_trace\`.
${AGENTS_END}
`;
}

export function mergeAgentsMd(existing: string | undefined, section: string): string {
  if (existing === undefined || existing.trim() === '') {
    return section;
  }
  const beginIdx = existing.indexOf(AGENTS_BEGIN);
  const endIdx = existing.indexOf(AGENTS_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + AGENTS_END.length).replace(/^\n/, '');
    return `${before}${section}${after}`;
  }
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${section}`;
}

/** Writes/updates the tapsmith section in <cwd>/AGENTS.md. Returns the file path. */
export function writeAgentsMd(cwd: string): string {
  const filePath = path.join(cwd, 'AGENTS.md');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  fs.writeFileSync(filePath, mergeAgentsMd(existing, renderAgentsSection()));
  return filePath;
}
