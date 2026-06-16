import { describe, it, expect } from 'vitest';
import { groupAgents, agentsLabel, agentsTooltip } from '../ui-mode/mcp-agents.js';

describe('groupAgents()', () => {
  it('collapses duplicate client names into counts, preserving order', () => {
    expect(groupAgents([
      { name: 'claude-code', version: '1.2' },
      { name: 'codex-mcp-client', version: '0.5' },
      { name: 'claude-code', version: '1.2' },
    ])).toEqual([
      { name: 'claude-code', count: 2 },
      { name: 'codex-mcp-client', count: 1 },
    ]);
  });

  it('returns an empty array for no agents', () => {
    expect(groupAgents([])).toEqual([]);
  });
});

describe('agentsLabel()', () => {
  it('shows the single agent name', () => {
    expect(agentsLabel([{ name: 'claude-code', version: '1.2' }])).toBe('claude-code');
  });

  it('shows a count for multiple agents (including duplicates)', () => {
    expect(agentsLabel([
      { name: 'claude-code', version: '1.2' },
      { name: 'claude-code', version: '1.2' },
    ])).toBe('2 agents');
  });

  it('is empty when nothing is connected', () => {
    expect(agentsLabel([])).toBe('');
  });
});

describe('agentsTooltip()', () => {
  it('lists distinct agents with ×N for duplicates', () => {
    expect(agentsTooltip([
      { name: 'claude-code', version: '1.2' },
      { name: 'claude-code', version: '1.2' },
      { name: 'codex-mcp-client', version: '0.5' },
    ])).toBe('claude-code ×2\ncodex-mcp-client');
  });
});
