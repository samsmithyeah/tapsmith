import { parseSelectorString } from '../trace-viewer/components/selector-matching.js';
import type { ParsedSelector } from '../trace-viewer/components/selector-matching.js';
import type { Selector, SelectorKind } from '../selectors.js';
import { makeSelector } from '../selectors.js';
import { buildStrictModeViolationError, collapseSameTargetDuplicates } from '../element-handle.js';
import type { TapsmithGrpcClient, ElementInfo } from '../grpc-client.js';

export interface ParsedRuntimeSelector {
  selector: Selector;
  /** Positional chain (.first()/.last()/.nth(n)) parsed from the input, if any. */
  index?: number | 'first' | 'last';
}

export function parseSelectorToInternal(input: string): ParsedRuntimeSelector {
  const parsed = parseSelectorString(input);
  if (!parsed) {
    throw new Error(`Invalid selector: "${input}". Use a Tapsmith selector like device.getByRole("button", { name: "Login" })`);
  }
  return { selector: makeSelector(parsedSelectorToKind(parsed)), index: parsed.index };
}

function parsedSelectorToKind(parsed: ParsedSelector): SelectorKind {
  switch (parsed.type) {
    case 'text':
      return { type: 'text', value: parsed.value };
    case 'textContains':
      // getByText without { exact: true } — substring match, same as the SDK.
      return { type: 'textContains', value: parsed.value };
    case 'role':
      return { type: 'role', value: { role: parsed.value, name: parsed.name ?? '' } };
    case 'contentDesc':
      return { type: 'contentDesc', value: parsed.value };
    case 'hint':
      return { type: 'hint', value: parsed.value };
    case 'testId':
      return { type: 'testId', value: parsed.value };
    case 'className':
      return { type: 'className', value: parsed.value };
    case 'id':
      return { type: 'id', value: parsed.value };
    case 'label':
      return { type: 'label', value: parsed.value };
    default:
      throw new Error(`Unsupported selector type "${parsed.type}" for device actions. Use device.getByRole(), getByText(), getByDescription(), getByPlaceholder(), getByLabel(), or getByTestId().`);
  }
}

/** Format ElementInfo bounds in the hierarchy-XML style: [l,t][r,b]. */
export function formatBounds(bounds: ElementInfo['bounds']): string {
  if (!bounds) return '';
  return `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
}

/**
 * Build a selector targeting one already-resolved element, mirroring the
 * SDK's `_selectorForElement` (element-handle.ts). Used to honor a
 * positional chain when dispatching an action: the raw selector would make
 * the agent act on its first match, so re-target via an identifying
 * property instead.
 */
function selectorForElement(el: ElementInfo): Selector | undefined {
  if (el.resourceId) return makeSelector({ type: 'id', value: el.resourceId });
  if (el.contentDescription) return makeSelector({ type: 'contentDesc', value: el.contentDescription });
  if (el.text) return makeSelector({ type: 'text', value: el.text });
  return undefined;
}

const RESOLVE_TIMEOUT_MS = 5_000;
const RESOLVE_POLL_MS = 250;

export interface ResolvedActionTarget {
  /** Selector to dispatch the action with. */
  selector: Selector;
  /** Error message to surface instead of acting (ambiguous/not found/unaddressable). */
  error?: string;
}

/**
 * Resolve an action target through the runtime find path with the SDK's
 * strict-mode semantics (PILOT-226): polls findElements until the selector
 * matches, errors when it matches more than one element and no positional
 * chain was given, and honors .first()/.last()/.nth(n) by re-targeting the
 * resolved element.
 */
export async function resolveActionTarget(
  client: TapsmithGrpcClient,
  input: string,
): Promise<ResolvedActionTarget> {
  const { selector, index } = parseSelectorToInternal(input);
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

  let elements: ElementInfo[] = [];
  while (true) {
    const res = await client.findElements(selector, RESOLVE_POLL_MS);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — surface it
      // immediately instead of busy-waiting toward a generic "no match".
      return { selector, error: res.errorMessage };
    }
    elements = collapseSameTargetDuplicates(res.elements ?? []);
    if (elements.length > 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
  }

  if (elements.length === 0) {
    return { selector, error: `No elements match ${input} after waiting ${RESOLVE_TIMEOUT_MS}ms. Use tapsmith_snapshot or tapsmith_test_selector to inspect the current screen.` };
  }

  if (index === undefined) {
    if (elements.length > 1) {
      return { selector, error: buildStrictModeViolationError(input, elements).message };
    }
    return { selector };
  }

  // Negative indices count from the end, like the runtime's .nth()
  const idx = index === 'first' ? 0
    : index === 'last' ? elements.length - 1
    : index < 0 ? elements.length + index
    : index;
  const el = idx >= 0 && idx < elements.length ? elements[idx] : undefined;
  if (!el) {
    return { selector, error: `Index ${String(index)} is out of range: ${input} matched ${elements.length} element(s).` };
  }
  const targeted = selectorForElement(el);
  if (!targeted) {
    return { selector, error: `Cannot target match ${String(index)} of ${input}: the element has no resourceId, contentDescription, or text to address it by.` };
  }
  // The agent acts on the targeting selector's FIRST match in document
  // order. If an earlier match shares the identifying property, the action
  // would silently land on that element instead of the resolved index —
  // error out rather than mis-tap. (elements is in document order, so the
  // first sharer within the match set approximates the agent's pick.)
  const sharesProperty = (e: ElementInfo): boolean => {
    switch (targeted.kind.type) {
      case 'id': return e.resourceId === el.resourceId;
      case 'contentDesc': return e.contentDescription === el.contentDescription;
      case 'text': return e.text === el.text;
      default: return false;
    }
  };
  const firstSharer = elements.findIndex(sharesProperty);
  if (firstSharer !== -1 && firstSharer !== idx) {
    return {
      selector,
      error:
        `Cannot target match ${String(index)} of ${input}: its identifying property ` +
        `(${targeted.kind.type} ${JSON.stringify(String(targeted.kind.value))}) also matches an earlier element, ` +
        'so the action would land on the wrong one. Use a more specific selector (getByTestId, getByRole with name) for this element.',
    };
  }
  return { selector: targeted };
}
