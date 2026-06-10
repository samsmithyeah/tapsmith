import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { disambiguateSelectors } from '../trace-viewer/components/selector-uniqueness.js';
import { formatHierarchy } from '../mcp/hierarchy-formatter.js';

function makeNode(tagName: string, attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  const node: HierarchyNode = {
    tagName,
    attributes: new Map(Object.entries(attrs)),
    children,
    depth: 0,
  };
  const setDepth = (n: HierarchyNode, d: number) => {
    n.depth = d;
    n.children.forEach((c) => setDepth(c, d + 1));
  };
  setDepth(node, 0);
  return node;
}

/**
 * The story-app sign-in screen that motivated PILOT-226: a subtitle
 * "Sign in to continue to DreamSpinner" appears earlier in the tree than the
 * "Sign in" button. device.getByText("Sign in") substring-matches both at
 * runtime and taps the subtitle.
 */
function signInScreen(): { roots: HierarchyNode[]; subtitle: HierarchyNode; button: HierarchyNode } {
  const subtitle = makeNode('XCUIElementTypeStaticText', {
    type: 'XCUIElementTypeStaticText',
    label: 'Sign in to continue to DreamSpinner',
    clickable: 'false',
  });
  const button = makeNode('XCUIElementTypeButton', {
    type: 'XCUIElementTypeButton',
    label: 'Sign in',
    clickable: 'true',
  });
  const root = makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther' }, [subtitle, button]);
  return { roots: [root], subtitle, button };
}

describe('disambiguateSelectors (PILOT-226)', () => {
  it('keeps suggestions that are already unique', () => {
    const { roots, button } = signInScreen();
    const result = disambiguateSelectors(roots, button, generateSelectors(button));
    // getByRole("button", { name: "Sign in" }) is unique — stays on top untouched
    expect(result[0].code).toBe('device.getByRole("button", { name: "Sign in" })');
  });

  it('upgrades an ambiguous substring getByText to { exact: true } without demotion', () => {
    const { roots, button } = signInScreen();
    const result = disambiguateSelectors(roots, button, generateSelectors(button));
    const textSuggestion = result.find((s) => s.code.includes('getByText'));
    expect(textSuggestion).toBeDefined();
    // "Sign in" substring-matches the subtitle too; { exact: true } pins the button
    expect(textSuggestion!.code).toBe('device.getByText("Sign in", { exact: true })');
    expect(textSuggestion!.label).not.toContain('matches');
    expect(textSuggestion!.priority).toBeLessThan(8);
  });

  it('falls back to a positional chain when no upgrade pins the node', () => {
    const itemA = makeNode('node', { class: 'android.widget.TextView', text: 'Item 1' });
    const itemB = makeNode('node', { class: 'android.widget.TextView', text: 'Item 2' });
    const root = makeNode('node', { class: 'android.view.ViewGroup' }, [itemA, itemB]);
    // Suggestion that substring-matches both items and has no unique exact form
    const ambiguous = [{ code: 'device.getByText("Item")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], itemB, ambiguous);
    expect(result[0].code).toBe('device.getByText("Item").last()');
    expect(result[0].label).toContain('2 matches');
    expect(result[0].priority).toBeGreaterThanOrEqual(8);
  });

  it('upgrades a bare getByRole with the accessible name when that is unique', () => {
    const save = makeNode('node', { class: 'android.widget.Button', text: 'Save' });
    const cancel = makeNode('node', { class: 'android.widget.Button', text: 'Cancel' });
    const root = makeNode('node', { class: 'android.view.ViewGroup' }, [save, cancel]);
    const ambiguous = [{ code: 'device.getByRole("button")', label: 'Role', priority: 2 }];
    const result = disambiguateSelectors([root], cancel, ambiguous);
    expect(result[0].code).toBe('device.getByRole("button", { name: "Cancel" })');
    expect(result[0].priority).toBe(2);
  });

  it('marks suggestions that do not resolve to the picked node', () => {
    const other = makeNode('node', { class: 'android.widget.TextView', text: 'Other' });
    const root = makeNode('node', {}, [other]);
    const wrong = [{ code: 'device.getByText("Nope")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], other, wrong);
    expect(result[0].label).toContain('may not match');
    expect(result[0].priority).toBeGreaterThanOrEqual(8);
  });

  it('disambiguates identical siblings by position (reference identity)', () => {
    const twinA = makeNode('node', { class: 'android.widget.TextView', text: 'Twin' });
    const twinB = makeNode('node', { class: 'android.widget.TextView', text: 'Twin' });
    const root = makeNode('node', {}, [twinA, twinB]);
    const suggestion = [{ code: 'device.getByText("Twin", { exact: true })', label: 'Text', priority: 6 }];
    // Same tree → reference identity lets the second twin get .last(), not .first()
    const result = disambiguateSelectors([root], twinB, suggestion);
    expect(result[0].code).toBe('device.getByText("Twin", { exact: true }).last()');
  });
});

describe('formatHierarchy suggested selectors (PILOT-226)', () => {
  it('emits a uniquely resolving selector for every ref on the sign-in screen', () => {
    const { roots } = signInScreen();
    const { selectors } = formatHierarchy(roots);
    const buttonRef = selectors.find((s) => s.includes('Sign in') && !s.includes('continue'));
    expect(buttonRef).toBeDefined();
    // Must NOT be the ambiguous substring selector that broke story-app
    expect(buttonRef).not.toContain('device.getByText("Sign in")\n');
    expect(buttonRef).toMatch(/getByRole\("button", \{ name: "Sign in" \}\)|getByText\("Sign in", \{ exact: true \}\)/);
  });

  it('appends a positional chain when nothing else disambiguates', () => {
    const itemA = makeNode('node', { class: 'android.widget.TextView', text: 'Item', clickable: 'true' });
    const itemB = makeNode('node', { class: 'android.widget.TextView', text: 'Item', clickable: 'true' });
    const root = makeNode('node', { class: 'android.view.ViewGroup' }, [itemA, itemB]);
    const { selectors } = formatHierarchy([root]);
    expect(selectors.length).toBeGreaterThanOrEqual(2);
    expect(selectors[0]).toContain('.first()');
    expect(selectors[1]).toContain('.last()');
  });
});

describe('exact-text upgrade quoting (PR #124 review)', () => {
  it('escapes bare double quotes when the source suggestion was single-quoted', () => {
    const a = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi"' });
    const b = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi" again' });
    const root = makeNode('node', {}, [a, b]);
    const suggestion = [{ code: `device.getByText('Say "hi"')`, label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], a, suggestion);
    expect(result[0].code).toBe('device.getByText("Say \\"hi\\"", { exact: true })');
  });

  it('does not double-escape backslash sequences from double-quoted sources', () => {
    const a = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi"' });
    const b = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi" again' });
    const root = makeNode('node', {}, [a, b]);
    const suggestion = [{ code: 'device.getByText("Say \\"hi\\"")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], a, suggestion);
    expect(result[0].code).toBe('device.getByText("Say \\"hi\\"", { exact: true })');
  });
});
