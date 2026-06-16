// Shared helpers for summarizing connected MCP agents in the UI. Two instances
// of the same client report identical clientInfo (e.g. two Claude Codes both
// "claude-code"), so we group by name and show a count rather than repeating.

export interface McpAgent {
  name: string
  version: string
}

export interface GroupedAgent {
  name: string
  count: number
}

/** Group agents by name, preserving first-seen order, with a count each. */
export function groupAgents(agents: McpAgent[]): GroupedAgent[] {
  const counts = new Map<string, number>();
  for (const a of agents) {
    counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

/** Short label for the connection status, e.g. "claude-code" or "3 agents". */
export function agentsLabel(agents: McpAgent[]): string {
  if (agents.length === 0) return '';
  if (agents.length === 1) return agents[0].name;
  return `${agents.length} agents`;
}

/** Multi-line tooltip listing every agent with its version, deduped with counts. */
export function agentsTooltip(agents: McpAgent[]): string {
  const counts = new Map<string, number>();
  for (const a of agents) {
    const label = a.version ? `${a.name} ${a.version}` : a.name;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
    .join('\n');
}
