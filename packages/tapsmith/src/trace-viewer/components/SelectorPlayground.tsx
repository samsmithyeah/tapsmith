import { useState, useCallback, useEffect, useMemo } from 'preact/hooks';
import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { parseHierarchyXml } from './hierarchy-utils.js';
import { generateSelectors, generateBestSelector, findBetterDescendant, hasGoodSelectors, type GeneratedSelector } from './selector-generation.js';
import { parseSelectorString, findMatchingNodes, getNodeBounds, hitTest } from './selector-matching.js';

function findParent(roots: HierarchyNode[], target: HierarchyNode): HierarchyNode | null {
  for (const root of roots) {
    const result = findParentWalk(root, target);
    if (result) return result;
  }
  return null;
}

function findParentWalk(node: HierarchyNode, target: HierarchyNode): HierarchyNode | null {
  for (const child of node.children) {
    if (child === target) return node;
    const result = findParentWalk(child, target);
    if (result) return result;
  }
  return null;
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// ─── Selector Tab (lives in detail tabs) ───

const SELECTOR_TAB_STYLES = `
  .st-container { display: flex; flex-direction: column; height: 100%; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 12px; }
  .st-input-row { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
  .st-input { flex: 1; padding: 5px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 4px; color: var(--color-text-secondary); font-family: inherit; font-size: 12px; outline: none; min-width: 0; }
  .st-input:focus { border-color: var(--color-accent); }
  .st-input::placeholder { color: var(--color-text-faintest); }
  .st-count { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
  .st-count.has-matches { color: var(--color-success); }
  .st-count.no-matches { color: var(--color-error); }
  .st-section-label { padding: 8px 10px 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--color-text-faint); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .st-options { flex: 1; overflow-y: auto; padding: 0 10px 8px; }
  .st-option { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; cursor: pointer; margin-bottom: 2px; }
  .st-option:hover { background: var(--color-bg-hover); }
  .st-option.selected { background: var(--color-bg-selected); }
  .st-option-code { flex: 1; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-option-label { font-size: 10px; color: var(--color-text-faint); flex-shrink: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-transform: uppercase; letter-spacing: 0.3px; }
  .st-option-copy { padding: 2px 6px; background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-accent); cursor: pointer; font-size: 10px; font-family: inherit; flex-shrink: 0; opacity: 0; transition: opacity 0.1s; }
  .st-option:hover .st-option-copy { opacity: 1; }
  .st-option-copy:hover { background: var(--color-border); }
  .st-empty { padding: 10px; color: var(--color-text-faintest); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .st-pick-hint { padding: 10px; color: var(--color-text-muted); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; }
  .st-pick-hint code { background: var(--color-bg-tertiary); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  .st-setup-hint { padding: 4px 10px 6px; font-size: 11px; color: var(--color-text-faint); font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .st-setup-hint code { color: var(--color-text-muted); }
`;

let stStylesInjected = false;
function injectStStyles() {
  if (stStylesInjected) return;
  stStylesInjected = true;
  const el = document.createElement('style');
  el.textContent = SELECTOR_TAB_STYLES;
  document.head.appendChild(el);
}

interface SelectorTabProps {
  hierarchyXml: string | undefined
  pickedNode: HierarchyNode | null
  onHighlightsChange: (bounds: Bounds[]) => void
  selector: string
  onSelectorChange: (selector: string) => void
}

export function SelectorTab({ hierarchyXml, pickedNode, onHighlightsChange, selector, onSelectorChange }: SelectorTabProps) {
  injectStStyles();

  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const roots = useMemo(
    () => hierarchyXml ? parseHierarchyXml(hierarchyXml) : [],
    [hierarchyXml],
  );

  const generatedSelectors = useMemo<GeneratedSelector[]>(() => {
    if (!pickedNode) return [];
    const raw = generateSelectors(pickedNode);
    if (roots.length === 0) return raw;
    const pickedBounds = pickedNode.attributes.get('bounds') ?? '';
    // Check each selector for uniqueness against the hierarchy. Non-unique
    // selectors get .nth(N) appended and are demoted below unique ones.
    return raw.map((s) => {
      const parsed = parseSelectorString(s.code);
      if (!parsed) return s;
      const matches = findMatchingNodes(roots, parsed);
      if (matches.length <= 1) return s;
      const idx = matches.findIndex((m) => m.attributes.get('bounds') === pickedBounds);
      if (idx === -1) return s;
      const nthSuffix = idx === 0 ? '.first()' : idx === matches.length - 1 ? '.last()' : `.nth(${idx})`;
      return {
        ...s,
        code: `${s.code}${nthSuffix}`,
        label: `${s.label} (${matches.length} matches)`,
        priority: Math.max(s.priority, 8),
      };
    }).sort((a, b) => a.priority - b.priority);
  }, [pickedNode, roots]);

  const isWebViewPick = pickedNode?.attributes.get('webview') === 'true';

  const matchCount = useMemo(() => {
    if (!selector.trim() || roots.length === 0) return null;
    const parsed = parseSelectorString(selector);
    if (!parsed) return null;
    return findMatchingNodes(roots, parsed).length;
  }, [selector, roots]);

  useEffect(() => {
    if (!selector.trim() || roots.length === 0) {
      onHighlightsChange([]);
      return;
    }
    const parsed = parseSelectorString(selector);
    if (!parsed) {
      onHighlightsChange([]);
      return;
    }
    const matches = findMatchingNodes(roots, parsed);
    const bounds = matches.map(getNodeBounds).filter((b): b is Bounds => b !== null);
    onHighlightsChange(bounds);
  }, [selector, roots, onHighlightsChange]);

  const handleInput = useCallback((e: Event) => {
    onSelectorChange((e.target as HTMLInputElement).value);
  }, [onSelectorChange]);

  const handleCopy = useCallback((code: string, idx: number) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  }, []);

  const handleSelectOption = useCallback((code: string) => {
    onSelectorChange(code);
  }, [onSelectorChange]);

  const countLabel = matchCount === null
    ? ''
    : matchCount === 1
      ? '1 match'
      : `${matchCount} matches`;

  const countClass = matchCount === null
    ? 'st-count'
    : matchCount > 0
      ? 'st-count has-matches'
      : 'st-count no-matches';

  return (
    <div class="st-container">
      <div class="st-input-row">
        <input
          class="st-input"
          type="text"
          placeholder='device.getByText("Login") · device.getByRole("button", { name: "Submit" })'
          value={selector}
          onInput={handleInput}
        />
        <span class={countClass}>{countLabel}</span>
      </div>
      <div class="st-options">
        {generatedSelectors.length > 0 && (
          <>
            <div class="st-section-label">Suggested locators</div>
            {isWebViewPick && (
              <div class="st-setup-hint">
                <code>const webview = await device.webview()</code>
              </div>
            )}
            {generatedSelectors.map((s, i) => (
              <div
                key={i}
                class={`st-option${selector === s.code ? ' selected' : ''}`}
                onClick={() => handleSelectOption(s.code)}
              >
                <span class="st-option-code">{s.code}</span>
                <span class="st-option-label">{s.label}</span>
                <button
                  class="st-option-copy"
                  onClick={(e) => { e.stopPropagation(); handleCopy(s.code, i); }}
                >
                  {copiedIdx === i ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ))}
          </>
        )}
        {generatedSelectors.length === 0 && !selector && (
          <div class="st-pick-hint">
            Click the <code>⊙</code> button on the screenshot to pick an element, or type a locator above to highlight matches.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pick Handler (called from parent on screenshot click) ───

export function handlePickFromScreenshot(
  roots: HierarchyNode[],
  clickX: number,
  clickY: number,
): { node: HierarchyNode; selector: string; bounds: Bounds } | null {
  const hitNode = hitTest(roots, clickX, clickY);
  if (!hitNode) return null;
  // When the hit node is a generic container with only fallback selectors,
  // promote a descendant that has a meaningful selector (e.g. textfield
  // with placeholder inside a wrapper View). If the node is a leaf (no
  // children), check siblings with overlapping bounds instead.
  let betterNode = findBetterDescendant(hitNode);
  if (!betterNode && hitNode.children.length === 0) {
    const hitBounds = getNodeBounds(hitNode);
    if (hitBounds) {
      const parent = findParent(roots, hitNode);
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === hitNode) continue;
          const sb = getNodeBounds(sibling);
          if (sb && boundsOverlap(hitBounds, sb)) {
            const found = findBetterDescendant(sibling) ?? (hasGoodSelectors(sibling) ? sibling : null);
            if (found) { betterNode = found; break; }
          }
        }
      }
    }
  }
  if (!betterNode) betterNode = hitNode;
  const bounds = getNodeBounds(betterNode);
  if (!bounds) return null;
  return { node: betterNode, selector: generateBestSelector(betterNode), bounds };
}

// ─── Hover Handler (called from parent on screenshot mousemove) ───

export function handleHoverFromScreenshot(
  roots: HierarchyNode[],
  x: number,
  y: number,
): Bounds | null {
  const node = hitTest(roots, x, y);
  if (!node) return null;
  return getNodeBounds(node);
}
