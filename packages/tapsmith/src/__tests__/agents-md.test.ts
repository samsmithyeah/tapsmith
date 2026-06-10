import { describe, it, expect } from 'vitest';
import { renderAgentsSection, mergeAgentsMd, AGENTS_BEGIN, AGENTS_END } from '../agents-md.js';

describe('renderAgentsSection()', () => {
  it('renders fenced section with run/debug/MCP guidance', () => {
    const section = renderAgentsSection();
    expect(section.startsWith(AGENTS_BEGIN)).toBe(true);
    expect(section.trimEnd().endsWith(AGENTS_END)).toBe(true);
    expect(section).toContain('npx tapsmith test');
    expect(section).toContain('getByRole');
    expect(section).toContain('claude mcp add tapsmith');
    expect(section).toContain('tapsmith doctor --json');
  });
});

describe('mergeAgentsMd()', () => {
  const section = renderAgentsSection();

  it('creates a new file body when no existing content', () => {
    const merged = mergeAgentsMd(undefined, section);
    expect(merged).toContain(AGENTS_BEGIN);
    expect(merged.trimEnd().endsWith(AGENTS_END)).toBe(true);
  });

  it('appends to existing content without touching it', () => {
    const merged = mergeAgentsMd('# My project\n\nStuff.\n', section);
    expect(merged.startsWith('# My project')).toBe(true);
    expect(merged).toContain('Stuff.');
    expect(merged).toContain(AGENTS_BEGIN);
  });

  it('replaces an existing tapsmith section idempotently', () => {
    const v1 = mergeAgentsMd('# Mine\n', section);
    const v2 = mergeAgentsMd(v1, section);
    expect(v2).toBe(v1);
    expect(v2.match(new RegExp(AGENTS_BEGIN, 'g'))).toHaveLength(1);
  });

  it('preserves content after the end marker', () => {
    const existing = `# Top\n\n${AGENTS_BEGIN}\nold stuff\n${AGENTS_END}\n\n# Bottom\n`;
    const merged = mergeAgentsMd(existing, section);
    expect(merged).toContain('# Top');
    expect(merged).toContain('# Bottom');
    expect(merged).not.toContain('old stuff');
  });
});
