import { useState, useCallback, useEffect, useMemo } from 'preact/hooks';
import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { parseHierarchyXml } from './hierarchy-utils.js';
import { generateSelectors, type GeneratedSelector } from './selector-generation.js';
import { parseSelectorString, findMatchingNodes, getNodeBounds } from './selector-matching.js';
import { disambiguateSelectors } from './selector-uniqueness.js';

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
  .st-strict-warning { padding: 6px 10px; font-size: 11px; color: var(--color-warning, #e2b340); border-bottom: 1px solid var(--color-border); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; flex-shrink: 0; }
  .st-strict-warning code { background: var(--color-bg-tertiary); padding: 1px 4px; border-radius: 3px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 10px; }
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
    // Validate against the hierarchy under runtime semantics: ambiguous
    // suggestions are upgraded ({ exact: true } / role name) or get a
    // positional chain appended (selector-uniqueness.ts).
    return disambiguateSelectors(roots, pickedNode, generateSelectors(pickedNode));
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

  // Strict mode (PILOT-226): an ambiguous selector without a positional
  // chain will throw at runtime — warn here, where the user is composing it.
  const hasPositionalChain = /\.(first|last)\(\)|\.nth\(\s*-?\d+\s*\)/.test(selector);
  const strictWarning = matchCount !== null && matchCount > 1 && !hasPositionalChain;

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
      {strictWarning && (
        <div class="st-strict-warning">
          ⚠ {matchCount} matches — runtime actions/assertions will throw a strict
          mode violation. Refine the selector (<code>{'{ exact: true }'}</code>,{' '}
          <code>getByRole</code>) or add <code>.first()</code>.
        </div>
      )}
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

// Pick/hover logic lives in selector-pick.ts (plain TS, unit-testable);
// re-exported here for the UI entry points that import from this module.
export { handlePickFromScreenshot, handleHoverFromScreenshot } from './selector-pick.js';
