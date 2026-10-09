import { describe, it, expect, vi } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import type { GeneratedSelector } from '../trace-viewer/components/selector-generation.js';

// Pin what validation says, so the test is about what formatHierarchy does
// with a suggestion that failed it.
const validated = vi.hoisted(() => ({ result: [] as GeneratedSelector[] }));
vi.mock('../trace-viewer/components/selector-uniqueness.js', () => ({
  disambiguateSelectors: () => validated.result,
}));

const { formatHierarchy } = await import('../mcp/hierarchy-formatter.js');

function button(): HierarchyNode {
  return {
    tagName: 'node',
    attributes: new Map([['class', 'android.widget.Button'], ['text', 'Save'], ['clickable', 'true']]),
    children: [],
    depth: 0,
  };
}

describe('formatHierarchy drops suggestions that failed validation (PILOT-659)', () => {
  it('falls back to the next suggestion that resolves', () => {
    validated.result = [
      { code: 'device.getByDescription("Stale")', label: 'Description (may not match)', priority: 8, mayNotMatch: true },
      { code: 'device.locator({ className: "android.widget.Button" })', label: 'Class name', priority: 9 },
    ];
    expect(formatHierarchy([button()]).locators).toEqual(['[1] device.locator({ className: "android.widget.Button" })']);
  });

  it('emits no ref at all when no suggestion resolves', () => {
    validated.result = [
      { code: 'device.getByDescription("Stale")', label: 'Description (may not match)', priority: 8, mayNotMatch: true },
    ];
    const { tree, locators } = formatHierarchy([button()]);
    expect(locators).toEqual([]);
    expect(tree).toBe('- button "Save"');
  });
});
