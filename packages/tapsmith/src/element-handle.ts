/**
 * ElementHandle — a lazy reference to a UI element found by a Selector.
 *
 * Returned by `device.element(selector)`. Supports chaining with `.element()`
 * and all the same actions as Device (tap, type, …). Also serves as the
 * assertion target for `expect()`.
 */

import {
  type Selector,
  selectorToProto,
  formatSelector,
  withParent,
  _id,
  _text,
  _textContains,
  _contentDesc,
  _hint,
  _testId,
  _role,
  _className,
  _xpath,
  _label,
} from './selectors.js';
import type { TapsmithGrpcClient, ElementInfo, ActionResponse } from './grpc-client.js';
import { type TraceCapture, extractStack } from './trace/trace-collector.js';
import type { ActionCategory } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';
import { sleep, isAbortError } from './abort.js';

// ─── Public types ───

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Timeout for quick visibility probes in scrollIntoView(). Short so the
 *  loop isn't blocked waiting for an element that's simply off-screen. */
const SCROLL_PROBE_TIMEOUT_MS = 1000;
/** Settle time after swipe-based scrolling.  On iOS, ScrollView momentum
 *  deceleration takes 300-500ms and the first tap during deceleration is
 *  consumed to stop the scroll rather than being delivered to child views.
 *  500ms is the measured safe minimum for iOS. */
const SCROLL_SETTLE_MS = 500;

// ─── Locator options (escape hatch for non-accessible queries) ───

/**
 * Options for `device.locator()` and `ElementHandle.locator()`. Use only when
 * an accessible getter (`getByRole`, `getByText`, `getByDescription`,
 * `getByPlaceholder`, `getByTestId`) cannot identify the element. Exactly one
 * field must be set.
 */
export interface LocatorOptions {
  /** Native resource id (e.g. Android `R.id.foo` → `"foo"`). */
  id?: string;
  /** XPath expression. Android-only. Use sparingly. */
  xpath?: string;
  /** Native widget class name (e.g. `"android.widget.Button"`). */
  className?: string;
}

// ─── Filter options for .filter() ───

export interface FilterOptions {
  /** Keep elements whose text contains this string or matches this RegExp. */
  hasText?: string | RegExp;
  /** Keep elements that have a descendant matching this locator. */
  has?: ElementHandle;
  /** Exclude elements that have a descendant matching this locator. */
  hasNot?: ElementHandle;
  /** Exclude elements whose text contains this string or matches this RegExp. */
  hasNotText?: string | RegExp;
}

// ─── Internal options for modified handles ───

interface ElementHandleOptions {
  nthIndex?: number;
  filters?: FilterOptions[];
  /** Left operand for and() — the full handle `this` was called on. */
  andSelf?: ElementHandle;
  andHandle?: ElementHandle;
  /** Left operand for or() — the full handle `this` was called on. */
  orSelf?: ElementHandle;
  orHandle?: ElementHandle;
  /**
   * Parent scope for a `getBy*`/`locator()` call made on a *modified* handle
   * (e.g. `dialog.first().getByRole('button')`). The parent's modifiers can't
   * be folded into a nested Selector, so it is resolved to concrete element(s)
   * and the child is scoped to them by geometric containment (see _resolveAll).
   */
  scopeParent?: ElementHandle;
  resolvedElementsPromise?: Promise<ElementInfo[]>;
  /** Trace capture context, propagated from the Device. */
  traceCapture?: TraceCapture;
  /** Default inter-keystroke delay in ms, from config.typingDelay. */
  typingDelay?: number;
  /** Default double-tap interval in ms, from config.doubleTapInterval. */
  doubleTapInterval?: number;
}

// ─── Helpers ───

/** @internal — Convert public LocatorOptions into the internal Selector. */
export function locatorOptionsToSelector(options: LocatorOptions): Selector {
  const keys = (['id', 'xpath', 'className'] as const).filter((k) => options[k] !== undefined);
  if (keys.length !== 1) {
    throw new Error(
      `locator() expects exactly one of { id, xpath, className }, got ${keys.length === 0 ? 'none' : keys.join(', ')}`,
    );
  }
  const key = keys[0];
  if (key === 'id') return _id(options.id!);
  if (key === 'xpath') return _xpath(options.xpath!);
  return _className(options.className!);
}

/**
 * Result of boundsContain: 'contained' if child is within parent,
 * 'not_contained' if child is outside, 'indeterminate' if either has no bounds.
 */
type ContainmentResult = 'contained' | 'not_contained' | 'indeterminate';

function boundsContain(
  parent?: { left: number; top: number; right: number; bottom: number },
  child?: { left: number; top: number; right: number; bottom: number },
): ContainmentResult {
  if (!parent || !child) return 'indeterminate';
  const contained =
    child.left >= parent.left &&
    child.top >= parent.top &&
    child.right <= parent.right &&
    child.bottom <= parent.bottom;
  return contained ? 'contained' : 'not_contained';
}

/**
 * Test whether an error thrown from `_resolveOne` / `_resolveAll` is a
 * "no match yet" signal that auto-wait loops should swallow and retry,
 * vs. a genuine infrastructure failure (gRPC error, daemon crash, etc.)
 * that must propagate so the user sees the real cause.
 *
 * Keeps the list of pollable-error message prefixes in sync with the
 * throw sites in `_resolveOne` and anything `_resolveAll` surfaces for
 * empty/out-of-range matches.
 */
/**
 * Substring the Android agent stamps onto a transient UIAutomator
 * `StaleObjectException` (see `CommandHandler.kt`). It means the hierarchy
 * changed mid-snapshot — e.g. a React re-render right after a tap — which is
 * retryable: the next poll tick queries a settled tree. Treated as a pollable
 * "not yet" so the action poll loops keep waiting within their timeout budget
 * instead of failing the action outright. Without this, PILOT-226's strict
 * pre-action resolution (which uses the non-auto-waiting `findElements` RPC)
 * turns a momentary stale snapshot into a hard failure — the regression that
 * surfaced as flaky `wait-for` E2E tests.
 */
const STALE_SNAPSHOT_SIGNATURE = 'is stale (UI changed)';

function isPollableNotFoundError(err: unknown): boolean {
  // A strict mode violation means the selector DID resolve — to too many
  // elements. Retrying cannot fix ambiguity; it must propagate immediately.
  if (isStrictModeViolation(err)) return false;
  // A user stop (PILOT-222) must propagate — poll loops never retry it.
  if (isAbortError(err)) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.startsWith('Element not found:') ||
    msg.startsWith('nth(') ||
    // A transient stale snapshot — retry on the next poll tick rather than
    // surfacing the agent error as a fatal "findElements failed".
    isStaleSnapshotError(err)
  );
}

/**
 * True for a transient stale-snapshot error (see {@link STALE_SNAPSHOT_SIGNATURE}).
 * Distinct from a definitive "not found": a stale tick is *unreliable*, so
 * callers that interpret an empty result as a real state — notably `waitFor`'s
 * absence states (`'detached'`/`'hidden'`) — must retry rather than conclude
 * absence, or a single re-render blip would falsely satisfy the wait.
 */
function isStaleSnapshotError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(STALE_SNAPSHOT_SIGNATURE);
}

// ─── Strict mode (PILOT-226) ───

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const STRICT_MODE_VIOLATION_BRAND = Symbol.for('tapsmith.StrictModeViolationError');

/**
 * Thrown when a locator used for an action, single-element query, or
 * assertion resolves to more than one element. Mirrors Playwright's strict
 * mode: acting on an ambiguous selector is an error, never a silent
 * first-match. Disambiguate with `{ exact: true }`, `getByRole(role, { name })`,
 * `getByTestId()`, or `.first()/.nth()/.last()`.
 */
export class StrictModeViolationError extends Error {
  /** @internal */
  readonly [STRICT_MODE_VIOLATION_BRAND] = true;
  /** The elements the selector resolved to, in document order. */
  readonly elements: ElementInfo[];

  constructor(message: string, elements: ElementInfo[]) {
    super(message);
    this.name = 'StrictModeViolationError';
    this.elements = elements;
  }
}

/** Returns true if `err` is a {@link StrictModeViolationError} (brand-based, safe across CJS/ESM copies). */
export function isStrictModeViolation(err: unknown): err is StrictModeViolationError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[STRICT_MODE_VIOLATION_BRAND] === true
  );
}

/** Max elements listed in a strict mode violation message before truncating. */
const STRICT_ERROR_MAX_ELEMENTS = 10;

function truncateText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Escape a raw attribute value for embedding in a generated selector string. */
function escapeForSelector(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Best-effort unambiguous locator suggestion for one resolved element. */
function suggestSelectorFor(el: ElementInfo): string | undefined {
  if (el.resourceId) {
    // Android resource ids look like "com.pkg:id/foo"; getByTestId matches the suffix.
    const testId = el.resourceId.includes(':id/') ? el.resourceId.split(':id/').pop()! : el.resourceId;
    return `device.getByTestId("${escapeForSelector(testId)}")`;
  }
  const name = el.contentDescription || el.text;
  // Static text elements read better as getByText; real widgets as getByRole.
  if (el.role && el.role !== 'text' && name) {
    return `device.getByRole("${el.role}", { name: "${escapeForSelector(truncateText(name, 60))}" })`;
  }
  if (el.text) {
    return `device.getByText("${escapeForSelector(truncateText(el.text, 60))}", { exact: true })`;
  }
  return undefined;
}

/** @internal — Build the Playwright-style strict mode violation error. */
export function buildStrictModeViolationError(
  selectorDescription: string,
  elements: ElementInfo[],
): StrictModeViolationError {
  const lines = elements.slice(0, STRICT_ERROR_MAX_ELEMENTS).map((el, i) => {
    const kind = el.role || el.className || 'element';
    let line = `    ${i + 1}) ${kind}`;
    if (el.text) line += ` "${truncateText(el.text, 60)}"`;
    if (el.bounds) line += ` [${el.bounds.left},${el.bounds.top}][${el.bounds.right},${el.bounds.bottom}]`;
    const aka = suggestSelectorFor(el);
    if (aka) line += ` aka ${aka}`;
    return line;
  });
  if (elements.length > STRICT_ERROR_MAX_ELEMENTS) {
    lines.push(`    … and ${elements.length - STRICT_ERROR_MAX_ELEMENTS} more`);
  }
  const message =
    `strict mode violation: ${selectorDescription} resolved to ${elements.length} elements:\n` +
    `${lines.join('\n')}\n` +
    'Hint: use { exact: true }, getByRole(role, { name }), getByTestId(), or .first()/.nth()/.last() to target a single element.';
  return new StrictModeViolationError(message, elements);
}

/**
 * Collapse accessibility-tree duplicates that target the same visual element.
 *
 * The iOS tree often exposes a text element twice: a parent StaticText
 * carrying the accessibility attributes (testID, traits) and an inner
 * StaticText child with the same label and pixel-identical bounds. Acting on
 * either taps the same point, so treating them as distinct matches would
 * raise false strict-mode violations (PILOT-226). Only elements with
 * identical text AND identical non-degenerate bounds are collapsed —
 * distinct elements that merely overlap keep their own entries. Keeps the
 * first occurrence (document order — the attribute-carrying parent).
 *
 * @internal
 */
export function collapseSameTargetDuplicates(elements: ElementInfo[]): ElementInfo[] {
  if (elements.length < 2) return elements;
  const seen = new Set<string>();
  const result: ElementInfo[] = [];
  for (const el of elements) {
    const b = el.bounds;
    if (!b || b.right - b.left <= 0 || b.bottom - b.top <= 0) {
      result.push(el);
      continue;
    }
    const key = `${b.left},${b.top},${b.right},${b.bottom}|${el.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(el);
  }
  return result;
}

/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const ELEMENT_HANDLE_BRAND = Symbol.for('tapsmith.ElementHandle');

export class ElementHandle {
  /** @internal */
  readonly [ELEMENT_HANDLE_BRAND] = true;
  /** @internal */
  readonly _client: TapsmithGrpcClient;
  /** @internal */
  readonly _selector: Selector;
  /** @internal */
  readonly _timeoutMs: number;
  /** @internal */
  private readonly _options: ElementHandleOptions;

  /** @internal — Side-channel for assertion functions to report expected/actual. */
  _assertionResult: { expected: string | undefined; actual: string | undefined } = { expected: undefined, actual: undefined };

  /** @internal — Trace capture context from the Device, if tracing is active. */
  get _traceCapture(): TraceCapture | undefined {
    return this._options.traceCapture;
  }

  constructor(
    client: TapsmithGrpcClient,
    selector: Selector,
    timeoutMs: number,
    options?: ElementHandleOptions,
  ) {
    this._client = client;
    this._selector = selector;
    this._timeoutMs = timeoutMs;
    this._options = options ?? {};
  }

  // ── Scoping (Playwright-style getBy* methods) ──

  /**
   * Locate a descendant by visible text. Substring match by default; pass
   * `{ exact: true }` for an exact match.
   */
  getByText(text: string, options?: { exact?: boolean }): ElementHandle {
    return this._scoped(options?.exact ? _text(text) : _textContains(text));
  }

  /** Locate a descendant by accessibility role, optionally filtering by name or state. */
  getByRole(role: string, options?: { name?: string; checked?: boolean; disabled?: boolean; selected?: boolean; expanded?: boolean }): ElementHandle {
    return this._scoped(_role(role, options));
  }

  /**
   * Locate a descendant by its accessibility description (Android
   * `contentDescription`, iOS `accessibilityLabel`).
   */
  getByDescription(text: string): ElementHandle {
    return this._scoped(_contentDesc(text));
  }

  /** Locate a descendant by placeholder text (Android hint, iOS placeholder). */
  getByPlaceholder(text: string): ElementHandle {
    return this._scoped(_hint(text));
  }

  /** Locate a descendant by its test ID. */
  getByTestId(testId: string): ElementHandle {
    return this._scoped(_testId(testId));
  }

  /**
   * Locate a descendant input element by its associated label text. Finds
   * form controls whose accessible name is derived from a nearby label.
   */
  getByLabel(text: string): ElementHandle {
    return this._scoped(_label(text));
  }

  /**
   * Escape hatch: locate a descendant by native id, xpath, or class name.
   * Prefer accessible getters (`getByRole`, `getByText`, `getByDescription`)
   * when possible.
   */
  locator(options: LocatorOptions): ElementHandle {
    return this._scoped(locatorOptionsToSelector(options));
  }

  /** @internal */
  private _scoped(child: Selector): ElementHandle {
    if (this._hasModifiers()) {
      // The parent carries modifiers (.first(), .filter(), .and(), or a prior
      // scope) that can't be expressed as a nested Selector. Defer to runtime
      // geometric scoping: resolve the parent to concrete element(s), then keep
      // only children contained within them (Playwright-style subtree scoping).
      return new ElementHandle(this._client, child, this._timeoutMs, {
        scopeParent: this,
        traceCapture: this._options.traceCapture,
      });
    }
    const scoped = withParent(child, this._selector);
    return new ElementHandle(this._client, scoped, this._timeoutMs, { traceCapture: this._options.traceCapture });
  }

  // ── Positional selection (PILOT-15) ──

  /** Return a new handle targeting the first match. */
  first(): ElementHandle {
    this._assertNoResolvedCache('first');
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: 0,
    });
  }

  /** Return a new handle targeting the last match. */
  last(): ElementHandle {
    this._assertNoResolvedCache('last');
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: -1,
    });
  }

  /** Return a new handle targeting the match at `index` (0-based). Negative indices count from the end. */
  nth(index: number): ElementHandle {
    this._assertNoResolvedCache('nth');
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: index,
    });
  }

  /** @internal — Prevent re-indexing on handles returned by all(). */
  private _assertNoResolvedCache(method: string): void {
    if (this._options.resolvedElementsPromise) {
      throw new Error(
        `${method}() cannot be called on a handle returned by all(). ` +
          'Handles from all() already reference a specific element.',
      );
    }
  }

  // ── Filtering (PILOT-16) ──

  /** Narrow matches by additional criteria without changing the selector. */
  filter(criteria: FilterOptions): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      filters: [...(this._options.filters ?? []), criteria],
    });
  }

  // ── Combining selectors (PILOT-17) ──

  /**
   * Return a handle matching elements that satisfy both this and the other handle's selector.
   * `this` (with all its modifiers) becomes the left operand, preserving call order.
   */
  and(other: ElementHandle): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      andSelf: this,
      andHandle: other,
      traceCapture: this._options.traceCapture,
    });
  }

  /**
   * Return a handle matching elements that satisfy either this or the other handle's selector.
   * `this` (with all its modifiers) becomes the left operand, preserving call order.
   */
  or(other: ElementHandle): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      orSelf: this,
      orHandle: other,
      traceCapture: this._options.traceCapture,
    });
  }

  // ── Internal resolution helpers ──

  /** @internal */
  private _hasModifiers(): boolean {
    return (
      this._options.nthIndex !== undefined ||
      (this._options.filters !== undefined && this._options.filters.length > 0) ||
      this._options.andHandle !== undefined ||
      this._options.orHandle !== undefined ||
      this._options.scopeParent !== undefined
    );
  }

  /** @internal — Resolve all matching elements. Recursively resolves operands for and/or, then applies filters. */
  async _resolveAll(): Promise<ElementInfo[]> {
    if (this._options.andHandle) {
      const left = this._options.andSelf!;

      const [leftEls, rightEls] = await Promise.all([
        left._resolveAll(),
        this._options.andHandle._resolveAll(),
      ]);

      const rightIds = new Set(rightEls.map((e) => e.elementId));
      let elements = leftEls.filter((e) => rightIds.has(e.elementId));

      // Apply post-combination filters (from .and(b).filter(F))
      if (this._options.filters) {
        for (const f of this._options.filters) {
          elements = await this._applyFilter(elements, f);
        }
      }
      return elements;
    }

    if (this._options.orHandle) {
      const left = this._options.orSelf!;

      const [leftEls, rightEls] = await Promise.all([
        left._resolveAll(),
        this._options.orHandle._resolveAll(),
      ]);

      const combined = [...leftEls, ...rightEls];
      let elements = Array.from(
        new Map(combined.map((el) => [el.elementId, el])).values(),
      );

      // Apply post-combination filters (from .or(b).filter(F))
      if (this._options.filters) {
        for (const f of this._options.filters) {
          elements = await this._applyFilter(elements, f);
        }
      }
      return elements;
    }

    // Base case: no and/or — resolve selector then apply filters
    const res = await this._client.findElements(this._selector, this._timeoutMs);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — not "no match".
      // Surface it instead of letting it read as an empty result.
      throw new Error(`findElements failed: ${res.errorMessage}`);
    }
    let elements = collapseSameTargetDuplicates(res.elements ?? []);

    // Scope to a modified parent (getBy*/locator() called on a modified handle):
    // keep only matches geometrically contained within the resolved parent(s).
    if (this._options.scopeParent) {
      elements = await this._scopeToParent(elements, this._options.scopeParent);
    }

    if (this._options.filters) {
      for (const f of this._options.filters) {
        elements = await this._applyFilter(elements, f);
      }
    }

    return elements;
  }

  /**
   * @internal — Restrict `children` to those geometrically contained within the
   * resolved parent handle, the same containment primitive used by
   * `filter({ has })`. The parent's modifiers are honored: a positional parent
   * (`.first()`, `.nth()`, an `all()` handle) resolves to its single selected
   * element; a filter/and/or parent resolves to all of its matches, and a child
   * contained within *any* of them is in scope.
   *
   * Requires bounds: a parent or child without bounds cannot be confirmed
   * contained and is excluded (Add accessibility identifiers / ensure the
   * container reports bounds if scoping returns nothing).
   *
   * A missing or out-of-range positional parent resolves to an empty scope
   * (no children in scope) rather than throwing — so `count()`/`exists()` and
   * absence assertions on a scoped handle report 0/false/empty like
   * Playwright, instead of surfacing the parent's "not found" error.
   */
  private async _scopeToParent(children: ElementInfo[], parent: ElementHandle): Promise<ElementInfo[]> {
    const parentEls = await parent._resolveAll();
    const nthIndex = parent._options.nthIndex;

    let scopedParents = parentEls;
    if (nthIndex !== undefined) {
      const idx = nthIndex < 0 ? parentEls.length + nthIndex : nthIndex;
      scopedParents = idx >= 0 && idx < parentEls.length ? [parentEls[idx]] : [];
    }

    return children.filter((child) =>
      scopedParents.some((p) => boundsContain(p.bounds, child.bounds) === 'contained'),
    );
  }

  /** @internal */
  private async _applyFilter(
    elements: ElementInfo[],
    filter: FilterOptions,
  ): Promise<ElementInfo[]> {
    let result = elements;

    if (filter.hasText !== undefined) {
      result = result.filter((el) => {
        if (filter.hasText instanceof RegExp) return filter.hasText.test(el.text);
        return el.text.includes(filter.hasText as string);
      });
    }

    if (filter.hasNotText !== undefined) {
      result = result.filter((el) => {
        if (filter.hasNotText instanceof RegExp) return !filter.hasNotText.test(el.text);
        return !el.text.includes(filter.hasNotText as string);
      });
    }

    if (filter.has !== undefined) {
      const childSelector = withParent(filter.has._selector, this._selector);
      const childRes = await this._client.findElements(childSelector, this._timeoutMs);
      if (childRes.errorMessage) {
        // Don't silently mis-filter on a child-resolution failure: surface it
        // so a transient stale snapshot retries and a real daemon error fails
        // fast (via isPollableNotFoundError), as elsewhere.
        throw new Error(`findElements failed: ${childRes.errorMessage}`);
      }
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) => {
        // If parent has no bounds, we can't determine geometric containment — skip it
        if (!parent.bounds) return false;
        const results = childElements.map((child) => boundsContain(parent.bounds, child.bounds));
        const hasContained = results.some((r) => r === 'contained');
        if (hasContained) return true;
        // Fallback: if all results are indeterminate (child bounds undefined)
        // but the daemon returned children scoped to our selector, trust the
        // daemon's scoping and consider it a match.
        const allIndeterminate = results.length > 0 && results.every((r) => r === 'indeterminate');
        return allIndeterminate;
      });
    }

    if (filter.hasNot !== undefined) {
      const childSelector = withParent(filter.hasNot._selector, this._selector);
      const childRes = await this._client.findElements(childSelector, this._timeoutMs);
      if (childRes.errorMessage) {
        throw new Error(`findElements failed: ${childRes.errorMessage}`);
      }
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) => {
        if (!parent.bounds) return true;
        const results = childElements.map((child) => boundsContain(parent.bounds, child.bounds));
        // Exclude if any child is definitively contained
        if (results.some((r) => r === 'contained')) return false;
        // Mirror the `has` logic: if all results are indeterminate (child
        // bounds undefined) but the daemon returned children, trust the
        // daemon's scoping — the child IS present, so exclude the parent.
        const allIndeterminate = results.length > 0 && results.every((r) => r === 'indeterminate');
        if (allIndeterminate) return false;
        return true;
      });
    }

    return result;
  }

  /**
   * @internal — Resolve to a single target element, respecting nth index.
   *
   * Strict mode (PILOT-226): without a positional modifier, resolving to
   * more than one element is an error — never a silent first-match.
   */
  private async _resolveOne(): Promise<ElementInfo> {
    const elements = this._options.resolvedElementsPromise
      ? await this._options.resolvedElementsPromise
      : await this._resolveAll();
    const nthIndex = this._options.nthIndex;

    if (nthIndex !== undefined) {
      const idx = nthIndex < 0 ? elements.length + nthIndex : nthIndex;
      if (idx < 0 || idx >= elements.length) {
        const expectedCount = nthIndex >= 0 ? nthIndex + 1 : -nthIndex;
        throw new Error(
          `nth(${nthIndex}): expected at least ${expectedCount} element(s), but found ${elements.length}`,
        );
      }
      return elements[idx];
    }

    if (elements.length === 0) {
      throw new Error(`Element not found: ${this._describe()}`);
    }
    if (elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements[0];
  }

  /** @internal — Build a human-readable description of this handle for error messages. */
  private _describe(): string {
    const sel = formatSelector(this._selector);
    if (this._options.andHandle) {
      const left = this._options.andSelf?._describe() ?? sel;
      const right = this._options.andHandle._describe();
      let desc = `${left} AND ${right}`;
      if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
      return desc;
    }
    if (this._options.orHandle) {
      const left = this._options.orSelf?._describe() ?? sel;
      const right = this._options.orHandle._describe();
      let desc = `${left} OR ${right}`;
      if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
      return desc;
    }
    let desc = this._options.scopeParent ? `${this._options.scopeParent._describe()} >> ${sel}` : sel;
    if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
    return desc;
  }

  /**
   * @internal — Build a selector to target a specific resolved element.
   *
   * Uses the resolved element's identifying property (resourceId,
   * contentDescription, or text) to build a simple selector. For modified
   * handles (nth, filter), the caller should pass the pre-resolved element
   * from `_waitForEnabled` to `_actionSelector` to avoid re-resolution,
   * which is the primary defense against targeting the wrong element.
   *
   * @param info - The resolved ElementInfo to target.
   */
  private _selectorForElement(info: ElementInfo): Selector {
    if (info.resourceId) return _id(info.resourceId);
    if (info.contentDescription) return _contentDesc(info.contentDescription);
    if (info.text) return _text(info.text);
    throw new Error(
      'Cannot target element for action: element has no resourceId, contentDescription, or text. ' +
        'Add accessibility identifiers to your app to use positional/filtered actions.',
    );
  }

  /**
   * @internal — Single-tick strict resolution for an unmodified handle.
   *
   * Fetches ALL matches via findElements (the agent does not auto-wait on
   * this RPC — callers poll). Throws a StrictModeViolationError when the
   * selector resolves to more than one element; returns the single match or
   * undefined when there is none yet.
   */
  private async _findOneStrict(timeoutMs: number): Promise<ElementInfo | undefined> {
    const res = await this._client.findElements(this._selector, timeoutMs);
    if (res.errorMessage) {
      // Daemon-level failure (agent dead, command error) — not "no match".
      // Must not look like a pollable not-found, so the real cause surfaces.
      throw new Error(`findElements failed: ${res.errorMessage}`);
    }
    const elements = collapseSameTargetDuplicates(res.elements ?? []);
    if (elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements[0];
  }

  /**
   * @internal — Strict pre-action resolution for actions that don't require
   * the enabled state (type, scroll, focus, …). Polls until the locator
   * resolves (Playwright-style auto-wait).
   *
   * Modified handles resolve through `_resolveOne()` (strict for ambiguous
   * filter/and/or chains, exempt for positional ones). Unmodified handles
   * poll `findElements` so ambiguity is detected BEFORE the raw selector is
   * handed to the agent, which would otherwise act on the first match.
   * (A race between this check and the agent-side find is accepted — both
   * see elements in document order.)
   *
   * Returns the action's remaining timeout budget plus the resolved element
   * for modified handles (so `_actionSelector` can skip re-resolution).
   * `timeoutMs === 0` skips polling entirely, preserving the explicit
   * opt-out behavior of `_waitForEnabled`.
   */
  private async _strictResolve(): Promise<{ remainingMs: number; element?: ElementInfo }> {
    const timeoutMs = this._timeoutMs;
    if (timeoutMs === 0) return { remainingMs: 0 };
    const MIN_ACTION_BUDGET_MS = 1000;
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 250;
    while (true) {
      try {
        // Floor at 1ms — the daemon treats a 0 timeout as "use the 30s
        // default", which would stall the final poll tick for 30s.
        const findBudget = Math.min(POLL_MS, Math.max(1, deadline - Date.now()));
        const el = this._hasModifiers()
          ? await this._resolveOne()
          : await this._findOneStrict(findBudget);
        if (el) {
          const remaining = Math.max(0, deadline - Date.now());
          return {
            remainingMs: Math.min(timeoutMs, Math.max(remaining, MIN_ACTION_BUDGET_MS)),
            element: el,
          };
        }
      } catch (err) {
        // Keep polling on "no match yet" (including nth-out-of-range);
        // strict violations and infrastructure errors propagate immediately.
        if (!isPollableNotFoundError(err)) throw err;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Element ${this._describe()} was not found after waiting ${timeoutMs}ms`);
      }
      const sleepMs = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
      if (sleepMs > 0) await sleep(sleepMs, this._client._getAbortSignal?.());
    }
  }

  /**
   * @internal — Deep-clone a handle tree, overriding the timeout at every
   * node (and/or operands carry their own, often long, timeouts). Used by
   * assertion and waitFor poll ticks so a single tick is bounded by the short
   * per-tick budget instead of an operand's full timeout (e.g. 30s); the outer
   * poll loop owns the overall deadline.
   */
  private static _cloneWithTimeout(h: ElementHandle, timeoutMs: number): ElementHandle {
    return new ElementHandle(h._client, h._selector, timeoutMs, {
      ...h._options,
      // A re-timed clone is a fresh probe: drop any cached resolution from
      // all() so it re-queries with the new timeout instead of serving the
      // stale snapshot (_resolveOne short-circuits on this promise).
      resolvedElementsPromise: undefined,
      andSelf: h._options.andSelf ? ElementHandle._cloneWithTimeout(h._options.andSelf, timeoutMs) : undefined,
      andHandle: h._options.andHandle ? ElementHandle._cloneWithTimeout(h._options.andHandle, timeoutMs) : undefined,
      orSelf: h._options.orSelf ? ElementHandle._cloneWithTimeout(h._options.orSelf, timeoutMs) : undefined,
      orHandle: h._options.orHandle ? ElementHandle._cloneWithTimeout(h._options.orHandle, timeoutMs) : undefined,
      // Re-time the scope parent too, else resolving it during a poll tick
      // could block for the parent's full (e.g. 30s) timeout when not found.
      scopeParent: h._options.scopeParent ? ElementHandle._cloneWithTimeout(h._options.scopeParent, timeoutMs) : undefined,
    });
  }

  /**
   * @internal — Single-tick, modifier-aware resolution for assertions
   * (expect.ts). Returns the matching elements after applying any positional
   * modifier (so `.first()`/`.nth()` yield at most one element — fixing
   * assertions previously ignoring modifiers entirely).
   *
   * When `strict` is true and the handle has no positional modifier,
   * resolving to more than one element throws a StrictModeViolationError.
   * Absence-style checks (toBeHidden, negated visibility/existence) pass
   * `strict: false` and evaluate their condition over the full match set.
   */
  async _resolveForAssertion(timeoutMs: number, strict: boolean): Promise<ElementInfo[]> {
    let elements: ElementInfo[];
    if (
      this._options.filters?.length ||
      this._options.andHandle ||
      this._options.orHandle ||
      this._options.scopeParent !== undefined
    ) {
      // Filter/and/or/scope chains need client-side resolution; clone the whole
      // handle tree with a short timeout so a single assertion poll tick
      // stays fast — and/or operands carry their own (long) timeouts and
      // would otherwise cap each sub-query at e.g. 30s.
      const probe = new ElementHandle(this._client, this._selector, timeoutMs, {
        ...ElementHandle._cloneWithTimeout(this, timeoutMs)._options,
        nthIndex: undefined,
      });
      elements = await probe._resolveAll();
    } else {
      const res = await this._client.findElements(this._selector, timeoutMs);
      if (res.errorMessage) {
        throw new Error(`findElements failed: ${res.errorMessage}`);
      }
      elements = collapseSameTargetDuplicates(res.elements ?? []);
    }

    const nthIndex = this._options.nthIndex;
    if (nthIndex !== undefined) {
      const idx = nthIndex < 0 ? elements.length + nthIndex : nthIndex;
      return idx >= 0 && idx < elements.length ? [elements[idx]] : [];
    }
    if (strict && elements.length > 1) {
      throw buildStrictModeViolationError(this._describe(), elements);
    }
    return elements;
  }

  /**
   * @internal — Poll until the target element is enabled, matching Playwright's
   * behavior of auto-waiting before actionable operations (tap, longPress).
   *
   * Returns `{ remainingMs, element }` where `remainingMs` is the action
   * timeout budget and `element` is the resolved ElementInfo. This avoids a
   * redundant gRPC round-trip in `_actionSelector` (Fix 2: eliminate TOCTOU).
   *
   * The goal is to share the original user timeout across "wait for enabled" +
   * "execute action" instead of doubling it, BUT with a `MIN_ACTION_BUDGET_MS`
   * floor: if the element becomes enabled right at the deadline, we still hand
   * the action at least 1 s so it has time to run.
   *
   * When `this._timeoutMs === 0` the method skips polling entirely and
   * returns 0, preserving the pre-auto-wait behavior for callers that
   * explicitly opt out of the wait.
   *
   * Throws if the element is not found or still disabled after the timeout.
   */
  private async _waitForEnabled(): Promise<{ remainingMs: number; element?: ElementInfo }> {
    const timeoutMs = this._timeoutMs;
    // timeoutMs === 0 means "no polling": behave like the pre-auto-wait code
    // and hand the full zero budget straight to the action.
    if (timeoutMs === 0) return { remainingMs: 0 };
    const MIN_ACTION_BUDGET_MS = 1000;
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 250;
    let everFound = false;
    while (true) {
      try {
        // Floor at 1ms — the daemon treats a 0 timeout as "use the 30s
        // default", which would stall the final poll tick for 30s.
        const findBudget = Math.min(POLL_MS, Math.max(1, deadline - Date.now()));
        const el = this._hasModifiers()
          ? await this._resolveOne()
          : await this._findOneStrict(findBudget);
        if (el) {
          everFound = true;
          if (el.enabled) {
            const remaining = Math.max(0, deadline - Date.now());
            return {
              remainingMs: Math.min(timeoutMs, Math.max(remaining, MIN_ACTION_BUDGET_MS)),
              element: el,
            };
          }
        }
      } catch (err) {
        // Only swallow "element not found" style errors from _resolveOne
        // (which throws for empty matches, nth-out-of-range, and filter
        // mismatches). Any other error — notably gRPC failures like a
        // crashed daemon — must propagate so the user sees the real
        // cause instead of a misleading "Element not found after Nms".
        if (!isPollableNotFoundError(err)) throw err;
      }
      if (Date.now() >= deadline) {
        const desc = this._describe();
        throw new Error(
          everFound
            ? `Element ${desc} is disabled after waiting ${timeoutMs}ms`
            : `Element ${desc} was not found after waiting ${timeoutMs}ms`,
        );
      }
      const sleepMs = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
      if (sleepMs > 0) await sleep(sleepMs, this._client._getAbortSignal?.());
    }
  }

  /**
   * @internal — Get the selector to use for an action. For modified handles,
   * resolves the specific element first and returns a targeting selector.
   *
   * @param preResolved - Optional pre-resolved ElementInfo from _waitForEnabled
   *   to avoid a redundant gRPC round-trip (Fix 2: eliminate TOCTOU).
   */
  private async _actionSelector(preResolved?: ElementInfo): Promise<Selector> {
    if (!this._hasModifiers()) return this._selector;
    const el = preResolved ?? await this._resolveOne();
    return this._selectorForElement(el);
  }

  // ── Queries ──

  /** Resolve this handle to an ElementInfo. Throws if not found within timeout. */
  async find(): Promise<ElementInfo> {
    this._emitQueryStarted('find');
    const start = Date.now();
    try {
      let result: ElementInfo;
      if (this._hasModifiers()) {
        result = await this._resolveOne();
      } else {
        // Strict resolution (PILOT-226): poll findElements so multiple
        // matches throw instead of silently returning the first.
        const { element } = await this._strictResolve();
        if (!element) {
          throw new Error(`Element not found: ${this._describe()}`);
        }
        result = element;
      }
      await this._traceQuery('find', `Found: ${result.text || result.className}`, Date.now() - start, result.bounds);
      return result;
    } catch (err) {
      await this._traceQueryFailed('find', err, Date.now() - start);
      throw err;
    }
  }

  /** Returns true if the element exists in the current UI. */
  async exists(): Promise<boolean> {
    this._emitQueryStarted('exists');
    const start = Date.now();
    try {
      let found: boolean;
      if (this._hasModifiers()) {
        try {
          await this._resolveOne();
          found = true;
        } catch {
          found = false;
        }
      } else {
        const res = await this._client.findElement(this._selector, this._timeoutMs);
        found = res.found;
      }
      await this._traceQuery('exists', `Exists: ${found}`, Date.now() - start);
      return found;
    } catch (err) {
      await this._traceQueryFailed('exists', err, Date.now() - start);
      throw err;
    }
  }

  /** Return the number of elements matching the selector (PILOT-14). */
  async count(): Promise<number> {
    this._emitQueryStarted('count');
    const start = Date.now();
    try {
      const elements = await this._resolveAll();
      await this._traceQuery('count', `Count: ${elements.length}`, Date.now() - start);
      return elements.length;
    } catch (err) {
      await this._traceQueryFailed('count', err, Date.now() - start);
      throw err;
    }
  }

  /**
   * Return an array of ElementHandles, one for each matching element (PILOT-13).
   *
   * The resolved elements are cached in the returned handles, so iterating
   * and performing actions will not re-query `findElements` for each handle.
   */
  async all(): Promise<ElementHandle[]> {
    this._emitQueryStarted('all');
    const start = Date.now();
    try {
      const resolvedElementsPromise = this._resolveAll();
      const elements = await resolvedElementsPromise;
      await this._traceQuery('all', `Found ${elements.length} element(s)`, Date.now() - start);
      return elements.map((_, i) =>
        new ElementHandle(this._client, this._selector, this._timeoutMs, {
          ...this._options,
          nthIndex: i,
          resolvedElementsPromise,
        }),
      );
    } catch (err) {
      await this._traceQueryFailed('all', err, Date.now() - start);
      throw err;
    }
  }

  // ── Waiting ──

  /**
   * @internal — Resolve matches for a single `waitFor` poll tick.
   *
   * Returns `null` to signal "retry this tick": a transient stale snapshot is
   * an *unreliable* result, not a confirmed empty set, so the caller must not
   * interpret it as a reached state (this is what keeps `'detached'`/`'hidden'`
   * from falsely resolving on a re-render blip). A genuine not-found resolves
   * to `[]`; daemon-level failures propagate so the wait fails fast.
   */
  private async _resolveForWaitTick(findBudget: number): Promise<ElementInfo[] | null> {
    try {
      if (this._hasModifiers()) {
        // Clone with findBudget at every node so an and/or operand's own
        // (long) timeout doesn't stall this poll tick — the waitFor deadline
        // loop owns the overall wait.
        const pollHandle = ElementHandle._cloneWithTimeout(this, findBudget);
        return await pollHandle._resolveAll();
      }
      const res = await this._client.findElements(this._selector, findBudget);
      if (res.errorMessage) {
        // Surface daemon-level failures (agent dead, command error) so a real
        // fault fails fast instead of being swallowed as "no match" and timing
        // out with a generic "did not reach state" message.
        throw new Error(`findElements failed: ${res.errorMessage}`);
      }
      return collapseSameTargetDuplicates(res.elements ?? []);
    } catch (err) {
      if (!isPollableNotFoundError(err)) throw err;
      // Stale snapshot → retry (unreliable tick). Covers both this path and
      // the modified-handle path (_resolveAll throws the same signature).
      if (isStaleSnapshotError(err)) return null;
      return [];
    }
  }

  /**
   * Wait until this element reaches the specified state.
   *
   * - `'visible'` (default): element exists in the hierarchy AND is visible.
   * - `'hidden'`: element either doesn't exist OR exists with `visible === false`.
   * - `'attached'`: element exists in the hierarchy (regardless of visibility).
   * - `'detached'`: element does not exist in the hierarchy.
   */
  async waitFor(options?: {
    state?: 'visible' | 'hidden' | 'attached' | 'detached';
    timeout?: number;
  }): Promise<void> {
    const state = options?.state ?? 'visible';
    const timeoutMs = options?.timeout ?? this._timeoutMs;
    this._emitQueryStarted(`waitFor(${state})`);
    const start = Date.now();

    const POLL_MS = 250;
    const FIND_TIMEOUT_MS = 500;
    const deadline = start + timeoutMs;

    const checkState = async (): Promise<boolean> => {
      // Floor at 1ms — the daemon treats a 0 timeout as "use the 30s
      // default", which would stall the final poll tick for 30s.
      const findBudget = Math.min(FIND_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
      const resolved = await this._resolveForWaitTick(findBudget);
      // null = transient stale snapshot: skip this tick and retry rather than
      // treating an unreliable result as a real state.
      if (resolved === null) return false;
      let elements = resolved;

      // Respect nthIndex — target the specific element, not the full set
      const nthIndex = this._options.nthIndex;
      if (nthIndex !== undefined) {
        const idx = nthIndex < 0 ? elements.length + nthIndex : nthIndex;
        elements = (idx >= 0 && idx < elements.length) ? [elements[idx]] : [];
      } else if ((state === 'visible' || state === 'attached') && elements.length > 1) {
        // Strict mode (PILOT-226): waiting for presence on an ambiguous
        // selector is an error. Absence states ('hidden'/'detached') are
        // exempt — they evaluate over the full match set.
        throw buildStrictModeViolationError(this._describe(), elements);
      }

      const attached = elements.length > 0;
      const visible = attached && elements.some((el) => el.visible);

      switch (state) {
        case 'visible': return visible;
        case 'hidden': return !visible;
        case 'attached': return attached;
        case 'detached': return !attached;
      }
    };

    try {
      while (true) {
        if (await checkState()) {
          await this._traceQuery(`waitFor(${state})`, `State reached: ${state}`, Date.now() - start);
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Element ${this._describe()} did not reach state "${state}" after ${timeoutMs}ms`,
          );
        }
        const sleepMs = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
        if (sleepMs > 0) await sleep(sleepMs, this._client._getAbortSignal?.());
      }
    } catch (err) {
      await this._traceQueryFailed(`waitFor(${state})`, err, Date.now() - start);
      throw err;
    }
  }

  // ── Actions ──

  /**
   * @internal — Emit a "started" lifecycle signal for a query/scroll method
   * that doesn't go through tracedAction. Call this before the slow part of
   * the operation so UI mode shows an in-flight row with a spinner; the
   * matching _traceQuery at completion fires the 'completed' signal.
   */
  private _emitQueryStarted(action: string): void {
    const trace = this._traceCapture;
    if (!trace) return;
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    trace.collector._emitActionStarted({
      category: 'other',
      action,
      selector: JSON.stringify(selectorToProto(this._selector)),
      sourceLocation,
      stack,
      log: [],
      hasScreenshotBefore: false,
      hasHierarchyBefore: false,
    });
  }

  /**
   * @internal — Emit a trace event for a read-only query with a single
   * screenshot capture (the "after" shot showing current device state).
   */
  private async _traceQuery(action: string, result: string, durationMs: number, bounds?: ElementInfo['bounds']): Promise<void> {
    const trace = this._traceCapture;
    if (!trace) return;
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const { captures: beforeCaptures } = await trace.collector.captureBeforeAction(
      trace.takeScreenshot, trace.captureHierarchy,
    );
    trace.collector.addActionEvent({
      category: 'other',
      action,
      selector: JSON.stringify(selectorToProto(this._selector)),
      duration: durationMs,
      success: true,
      bounds,
      sourceLocation,
      stack,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      log: [result],
    });
  }

  /**
   * @internal — Emit a failed completion event for a query/scroll method
   * that threw. Pairs with _emitQueryStarted at the same actionIndex so the
   * UI mode in-flight slot clears even if user code catches the throw and
   * keeps running.
   */
  private async _traceQueryFailed(action: string, err: unknown, durationMs: number): Promise<void> {
    const trace = this._traceCapture;
    if (!trace) return;
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    const { captures: beforeCaptures } = await trace.collector.captureBeforeAction(
      trace.takeScreenshot, trace.captureHierarchy,
    );
    trace.collector.addActionEvent({
      category: 'other',
      action,
      selector: JSON.stringify(selectorToProto(this._selector)),
      duration: durationMs,
      success: false,
      error: errMsg,
      errorStack: errStack,
      sourceLocation,
      stack,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      log: [`${action} failed: ${errMsg}`],
    });
  }

  /** @internal — Wrap an action with trace recording. */
  private async _tracedAction(
    action: string,
    category: ActionCategory,
    fn: () => Promise<ActionResponse>,
    fallbackMsg: string,
    extra?: { inputValue?: string },
  ): Promise<void> {
    const trace = this._traceCapture;
    const ctx = trace ? {
      collector: trace.collector,
      takeScreenshot: trace.takeScreenshot,
      captureHierarchy: trace.captureHierarchy,
      findElement: (sel: Selector, timeout: number) => this._client.findElement(sel, timeout),
      captureTraceState: trace.captureTraceState,
    } : undefined;
    return tracedAction(ctx, action, category, this._selector, fn, fallbackMsg, extra);
  }

  /**
   * @internal — Run an action's pre-flight element resolution (auto-wait +
   * selector build) inside trace recording.
   *
   * Emits a `started` lifecycle event UP-FRONT (before the wait) so UI mode
   * shows the action in-flight with a spinner during the auto-wait, not only
   * after the element is found. On success: returns the resolved value and the
   * caller's _tracedAction owns the rest of the lifecycle (it re-emits
   * `started` with bounds at the same actionIndex — a harmless single-slot
   * refresh — then `completed`). On a resolution timeout the throw would
   * otherwise escape untraced: emit the matching failed completion so the
   * timed-out action lands in the current lifecycle group with its real wait
   * duration, instead of finalizeTimeline dumping the tail onto the previous
   * (e.g. beforeAll) action.
   */
  private async _tracedResolve<T>(
    action: string,
    category: ActionCategory,
    resolve: () => Promise<T>,
  ): Promise<T> {
    const trace = this._traceCapture;
    if (!trace) return resolve();
    const start = Date.now();
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];
    const selector = JSON.stringify(selectorToProto(this._selector));
    trace.collector._emitActionStarted({
      category, action, selector, sourceLocation, stack, log: [],
      hasScreenshotBefore: false, hasHierarchyBefore: false,
    });
    try {
      return await resolve();
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      const { captures } = await trace.collector.captureBeforeAction(
        trace.takeScreenshot, trace.captureHierarchy,
      );
      trace.collector.addActionEvent({
        category, action, selector,
        duration: durationMs, success: false, error: errMsg, errorStack: errStack,
        waitTime: durationMs, sourceLocation, stack,
        hasScreenshotBefore: !!captures.screenshotBefore, hasScreenshotAfter: false,
        hasHierarchyBefore: !!captures.hierarchyBefore, hasHierarchyAfter: false,
        log: [`${action} failed: ${errMsg}`],
      });
      throw err;
    }
  }

  async tap(): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('tap', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('tap', 'tap', () => this._client.tap(sel, remainingMs), 'Tap failed');
  }

  async longPress(durationMs?: number): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('longPress', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('longPress', 'tap', () => this._client.longPress(sel, durationMs, remainingMs), 'Long press failed');
  }

  async type(text: string, options?: { delay?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('type', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    const delay = options?.delay ?? this._options.typingDelay ?? 0;
    return this._tracedAction('type', 'type', () => this._client.typeText(sel, text, remainingMs, delay), 'Type text failed', { inputValue: text });
  }

  async clearAndType(text: string, options?: { delay?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('clearAndType', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    const delay = options?.delay ?? this._options.typingDelay ?? 0;
    return this._tracedAction('clearAndType', 'type', () => this._client.clearAndType(sel, text, remainingMs, delay), 'Clear and type failed', { inputValue: text });
  }

  async clear(): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('clear', 'type', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('clear', 'type', () => this._client.clearText(sel, remainingMs), 'Clear text failed');
  }

  async scroll(direction: string, options?: { distance?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('scroll', 'scroll', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('scroll', 'scroll',
      () => this._client.scroll(sel, direction, { distance: options?.distance, timeoutMs: remainingMs }),
      'Scroll failed');
  }

  // ── Element Actions (PILOT-2) ──

  async doubleTap(options?: { intervalMs?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('doubleTap', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    // 0 on the wire = "use agent default (100ms)". User-supplied values
    // must be positive; ≤0 is treated as "use default".
    const intervalMs = Math.max(0, options?.intervalMs ?? this._options.doubleTapInterval ?? 0);
    return this._tracedAction('doubleTap', 'tap', () => this._client.doubleTap(sel, remainingMs, intervalMs), 'Double tap failed');
  }

  async dragTo(target: ElementHandle): Promise<void> {
    const { sourceSel, targetSel, remainingMs } = await this._tracedResolve('dragTo', 'swipe', async () => {
      const source = await this._strictResolve();
      const targetRes = await target._strictResolve();
      return {
        sourceSel: await this._actionSelector(source.element),
        targetSel: await target._actionSelector(targetRes.element),
        remainingMs: source.remainingMs,
      };
    });
    return this._tracedAction('dragTo', 'swipe', () => this._client.dragAndDrop(sourceSel, targetSel, remainingMs), 'Drag and drop failed');
  }

  async setChecked(checked: boolean): Promise<void> {
    const timeoutMs = this._timeoutMs;
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 250;

    const { sel, remainingMs, alreadySet } = await this._tracedResolve('setChecked', 'tap', async () => {
      const { remainingMs, element } = await this._waitForEnabled();
      const el = element ?? await this._resolveOne();
      return { sel: await this._actionSelector(el), remainingMs, alreadySet: el.checked === checked };
    });

    return this._tracedAction('setChecked', 'tap', async () => {
      // No real RPC for the already-in-state / poll-timeout paths — synthesize
      // a minimal ActionResponse so they still flow through trace recording.
      const synthetic = (success: boolean, errorMessage = ''): ActionResponse => ({
        requestId: '', success, errorType: '', errorMessage, screenshot: Buffer.alloc(0),
      });
      if (alreadySet) return synthetic(true); // Already in desired state

      // Tap once — for toggleable elements (checkboxes, switches) a second
      // tap would revert the state, so we must not re-tap.
      const tapRes = await this._client.tap(sel, remainingMs);
      if (!tapRes.success) return tapRes;

      // Poll for the state change until the full deadline — animations
      // and state propagation can take several frames.
      while (Date.now() < deadline) {
        await sleep(POLL_MS, this._client._getAbortSignal?.());
        try {
          const after = await this._resolveOne();
          if (after.checked === checked) return tapRes; // State changed successfully
        } catch (err) {
          if (!isPollableNotFoundError(err)) throw err;
        }
      }

      return synthetic(
        false,
        `setChecked(${checked}): element ${this._describe()} checked state did not change after tap (still ${!checked})`,
      );
    }, 'setChecked failed');
  }

  async selectOption(option: string | { index: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('selectOption', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('selectOption', 'other', () => this._client.selectOption(sel, option, remainingMs), 'Select option failed');
  }

  async screenshot(): Promise<Buffer> {
    const { remainingMs, element } = await this._strictResolve();
    const sel = await this._actionSelector(element);
    const res = await this._client.takeElementScreenshot(sel, remainingMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Element screenshot failed');
    }
    return res.data;
  }

  async boundingBox(): Promise<BoundingBox | null> {
    const info = this._hasModifiers() ? await this._resolveOne() : await this.find();
    if (!info.bounds) return null;
    return {
      x: info.bounds.left,
      y: info.bounds.top,
      width: info.bounds.right - info.bounds.left,
      height: info.bounds.bottom - info.bounds.top,
    };
  }

  async pinchIn(options?: { scale?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('pinchIn', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    const scale = options?.scale ?? 0.5;
    return this._tracedAction('pinchIn', 'other', () => this._client.pinchZoom(sel, scale, remainingMs), 'Pinch in failed');
  }

  async pinchOut(options?: { scale?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('pinchOut', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    const scale = options?.scale ?? 2;
    return this._tracedAction('pinchOut', 'other', () => this._client.pinchZoom(sel, scale, remainingMs), 'Pinch out failed');
  }

  async focus(): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('focus', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('focus', 'other', () => this._client.focus(sel, remainingMs), 'Focus failed');
  }

  async blur(): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('blur', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('blur', 'other', () => this._client.blur(sel, remainingMs), 'Blur failed');
  }

  async highlight(options?: { durationMs?: number }): Promise<void> {
    const { sel, remainingMs } = await this._tracedResolve('highlight', 'other', async () => {
      const { remainingMs, element } = await this._strictResolve();
      return { sel: await this._actionSelector(element), remainingMs };
    });
    return this._tracedAction('highlight', 'other', () => this._client.highlight(sel, options?.durationMs, remainingMs), 'Highlight failed');
  }

  // ── Info accessors (convenience) ──

  async getText(): Promise<string> {
    const info = await this.find();
    return info.text;
  }

  async isVisible(): Promise<boolean> {
    const info = await this.find();
    return info.visible;
  }

  async isEnabled(): Promise<boolean> {
    const info = await this.find();
    return info.enabled;
  }

  async isChecked(): Promise<boolean> {
    const info = this._hasModifiers() ? await this._resolveOne() : await this.find();
    return info.checked;
  }

  async isEditable(): Promise<boolean> {
    const info = await this.find();
    return info.role === 'textfield' && info.enabled;
  }

  async inputValue(): Promise<string> {
    const info = this._hasModifiers() ? await this._resolveOne() : await this.find();
    return info.text;
  }

  // ── Scrolling ──

  /**
   * Scroll the viewport until this element is visible on screen.
   *
   * Repeatedly swipes in the given direction, checking visibility between
   * each attempt. Useful for reaching elements that are off-screen in a
   * scrollable container (e.g. a long list of navigation cards).
   *
   * @param options.direction - Swipe direction: `"up"` (scroll down), `"down"` (scroll up). Default `"up"`.
   * @param options.maxScrolls - Maximum number of swipe attempts before throwing. Default `5`.
   * @param options.speed - Swipe speed in pixels/second. Default `2000`.
   */
  async scrollIntoView(options?: {
    direction?: string;
    maxScrolls?: number;
    speed?: number;
  }): Promise<void> {
    const direction = options?.direction ?? 'up';
    const maxScrolls = options?.maxScrolls ?? 5;
    const speed = options?.speed ?? 2000;

    this._emitQueryStarted('scrollIntoView');
    const start = Date.now();

    try {
      for (let i = 0; i <= maxScrolls; i++) {
        try {
          const res = await this._client.findElements(this._selector, SCROLL_PROBE_TIMEOUT_MS);
          if (res.errorMessage) {
            // Daemon-level failure — not "no match yet"; don't keep swiping.
            throw new Error(`findElements failed: ${res.errorMessage}`);
          }
          const els = collapseSameTargetDuplicates(res.elements ?? []);
          const nthIndex = this._options.nthIndex;
          let el: ElementInfo | undefined;
          if (nthIndex !== undefined) {
            const idx = nthIndex < 0 ? els.length + nthIndex : nthIndex;
            el = idx >= 0 && idx < els.length ? els[idx] : undefined;
          } else {
            // Strict mode (PILOT-226): scrolling toward an ambiguous selector
            // is an error — which match should end up on screen?
            if (els.length > 1) {
              throw buildStrictModeViolationError(this._describe(), els);
            }
            el = els[0];
          }
          if (el?.visible) {
            // Wait for scroll momentum to fully stop.  On iOS, momentum
            // deceleration continues after a swipe, and the first tap during
            // deceleration is consumed by the ScrollView (stops the scroll)
            // rather than being delivered to the child view.  Poll until the
            // element's position is stable for two consecutive checks.
            if (i > 0) {
              let lastY = el.bounds?.top;
              for (let s = 0; s < 10; s++) {
                await sleep(100, this._client._getAbortSignal?.());
                const probe = await this._client.findElement(this._selector, 500);
                const curY = probe.element?.bounds?.top;
                if (curY !== undefined && curY === lastY) break;
                lastY = curY;
              }
            }
            await this._traceQuery(
              'scrollIntoView',
              `Visible after ${i} scroll(s)`,
              Date.now() - start,
              el.bounds,
            );
            return;
          }
        } catch (err) {
          // findElement throws when the element isn't in the tree at all
          // (e.g. virtualized list hasn't rendered it yet). This is expected
          // during scrolling — swipe again and retry.
          // Re-throw all errors that are NOT element-not-found related.
          // Only "element not found" / "not in hierarchy" type errors should
          // be swallowed to let the scroll loop continue.
          if (!isPollableNotFoundError(err)) {
            // Not an element-not-found error — could be gRPC transport
            // failure (UNAVAILABLE, INTERNAL, PERMISSION_DENIED, etc.)
            // or any other infrastructure error. Propagate immediately.
            throw err;
          }
        }

        if (i < maxScrolls) {
          const swipeRes = await this._client.swipe(direction, { speed, distance: 0.6 });
          if (!swipeRes.success) {
            throw new Error(swipeRes.errorMessage || 'Swipe failed during scrollIntoView');
          }
          await sleep(SCROLL_SETTLE_MS, this._client._getAbortSignal?.());
        }
      }

      throw new Error(
        `scrollIntoView: ${this._describe()} was not visible after ${maxScrolls} scroll(s) in direction "${direction}"`,
      );
    } catch (err) {
      await this._traceQueryFailed('scrollIntoView', err, Date.now() - start);
      throw err;
    }
  }
}
