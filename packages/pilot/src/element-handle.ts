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
} from './selectors.js';
import type { PilotGrpcClient, ElementInfo, ActionResponse } from './grpc-client.js';
import { type TraceCapture, extractSourceLocation } from './trace/trace-collector.js';
import type { ActionCategory } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';

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
  resolvedElementsPromise?: Promise<ElementInfo[]>;
  /** Trace capture context, propagated from the Device. */
  traceCapture?: TraceCapture;
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

function boundsContain(
  parent?: { left: number; top: number; right: number; bottom: number },
  child?: { left: number; top: number; right: number; bottom: number },
): boolean {
  if (!parent || !child) return false;
  return (
    child.left >= parent.left &&
    child.top >= parent.top &&
    child.right <= parent.right &&
    child.bottom <= parent.bottom
  );
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
function isPollableNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.startsWith('Element not found:') || msg.startsWith('nth(');
}

export class ElementHandle {
  /** @internal */
  readonly _client: PilotGrpcClient;
  /** @internal */
  readonly _selector: Selector;
  /** @internal */
  readonly _timeoutMs: number;
  /** @internal */
  private readonly _options: ElementHandleOptions;

  /** @internal — Trace capture context from the Device, if tracing is active. */
  get _traceCapture(): TraceCapture | undefined {
    return this._options.traceCapture;
  }

  constructor(
    client: PilotGrpcClient,
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

  /** Locate a descendant by accessibility role, optionally with an accessible name. */
  getByRole(role: string, options?: { name?: string }): ElementHandle {
    return this._scoped(_role(role, options?.name));
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
      throw new Error(
        'getBy*/locator() cannot be called on a modified handle (e.g. after .first(), .filter(), .and()). ' +
          'Resolve the parent with .find() first, then scope from a fresh device-level locator.',
      );
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
      this._options.orHandle !== undefined
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
    let elements = res.elements ?? [];

    if (this._options.filters) {
      for (const f of this._options.filters) {
        elements = await this._applyFilter(elements, f);
      }
    }

    return elements;
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
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) =>
        childElements.some((child) => boundsContain(parent.bounds, child.bounds)),
      );
    }

    if (filter.hasNot !== undefined) {
      const childSelector = withParent(filter.hasNot._selector, this._selector);
      const childRes = await this._client.findElements(childSelector, this._timeoutMs);
      const childElements = childRes.elements ?? [];
      result = result.filter(
        (parent) =>
          !childElements.some((child) => boundsContain(parent.bounds, child.bounds)),
      );
    }

    return result;
  }

  /** @internal — Resolve to a single target element, respecting nth index. */
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
    return elements[0];
  }

  /** @internal — Build a human-readable description of this handle for error messages. */
  private _describe(): string {
    const sel = JSON.stringify(selectorToProto(this._selector));
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
    let desc = sel;
    if (this._options.filters?.length) desc += `.filter(…×${this._options.filters.length})`;
    return desc;
  }

  /**
   * @internal — Build a selector to target a specific resolved element.
   * Throws if the element has no unique identifying properties.
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
   * @internal — Poll until the target element is enabled, matching Playwright's
   * behavior of auto-waiting before actionable operations (tap, longPress).
   *
   * Returns an action timeout (milliseconds) for the caller to use when
   * invoking the underlying action. The goal is to share the original user
   * timeout across "wait for enabled" + "execute action" instead of doubling
   * it, BUT with a `MIN_ACTION_BUDGET_MS` floor: if the element becomes
   * enabled right at the deadline, we still hand the action at least 1 s so
   * it has time to run. In that edge case the total wall-clock exceeds the
   * original user timeout by up to `MIN_ACTION_BUDGET_MS`, which is preferred
   * to reporting success on the wait and then instantly failing the action.
   *
   * When `this._timeoutMs === 0` the method skips polling entirely and
   * returns 0, preserving the pre-auto-wait behavior for callers that
   * explicitly opt out of the wait.
   *
   * Throws if the element is not found or still disabled after the timeout.
   */
  private async _waitForEnabled(): Promise<number> {
    const timeoutMs = this._timeoutMs;
    // timeoutMs === 0 means "no polling": behave like the pre-auto-wait code
    // and hand the full zero budget straight to the action.
    if (timeoutMs === 0) return 0;
    const MIN_ACTION_BUDGET_MS = 1000;
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 250;
    let everFound = false;
    while (true) {
      try {
        const findBudget = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
        const el = this._hasModifiers()
          ? await this._resolveOne()
          : (await this._client.findElement(this._selector, findBudget)).element;
        if (el) {
          everFound = true;
          if (el.enabled) {
            const remaining = Math.max(0, deadline - Date.now());
            return Math.min(timeoutMs, Math.max(remaining, MIN_ACTION_BUDGET_MS));
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
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  /**
   * @internal — Get the selector to use for an action. For modified handles,
   * resolves the specific element first and returns a targeting selector.
   */
  private async _actionSelector(): Promise<Selector> {
    if (!this._hasModifiers()) return this._selector;
    const el = await this._resolveOne();
    return this._selectorForElement(el);
  }

  // ── Queries ──

  /** Resolve this handle to an ElementInfo. Throws if not found within timeout. */
  async find(): Promise<ElementInfo> {
    const start = Date.now();
    let result: ElementInfo;
    if (this._hasModifiers()) {
      result = await this._resolveOne();
    } else {
      const res = await this._client.findElement(this._selector, this._timeoutMs);
      if (!res.found || !res.element) {
        throw new Error(
          res.errorMessage ||
            `Element not found: ${this._describe()}`,
        );
      }
      result = res.element;
    }
    await this._traceQuery('find', `Found: ${result.text || result.className}`, Date.now() - start, result.bounds);
    return result;
  }

  /** Returns true if the element exists in the current UI. */
  async exists(): Promise<boolean> {
    const start = Date.now();
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
  }

  /** Return the number of elements matching the selector (PILOT-14). */
  async count(): Promise<number> {
    const start = Date.now();
    const elements = await this._resolveAll();
    await this._traceQuery('count', `Count: ${elements.length}`, Date.now() - start);
    return elements.length;
  }

  /**
   * Return an array of ElementHandles, one for each matching element (PILOT-13).
   *
   * The resolved elements are cached in the returned handles, so iterating
   * and performing actions will not re-query `findElements` for each handle.
   */
  async all(): Promise<ElementHandle[]> {
    const start = Date.now();
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
  }

  // ── Actions ──

  /** @internal — Run an action RPC and throw on failure. */
  private async _action(
    fn: () => Promise<ActionResponse>,
    fallbackMsg: string,
  ): Promise<void> {
    const res = await fn();
    if (!res.success) {
      throw new Error(res.errorMessage || fallbackMsg);
    }
  }

  /**
   * @internal — Emit a trace event for a read-only query with a single
   * screenshot capture (the "after" shot showing current device state).
   */
  private async _traceQuery(action: string, result: string, durationMs: number, bounds?: ElementInfo['bounds']): Promise<void> {
    const trace = this._traceCapture;
    if (!trace) return;
    const sourceLocation = extractSourceLocation(new Error().stack ?? '');
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
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      log: [result],
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
    } : undefined;
    return tracedAction(ctx, action, category, this._selector, fn, fallbackMsg, extra);
  }

  async tap(): Promise<void> {
    const remaining = await this._waitForEnabled();
    const sel = await this._actionSelector();
    return this._tracedAction('tap', 'tap', () => this._client.tap(sel, remaining), 'Tap failed');
  }

  async longPress(durationMs?: number): Promise<void> {
    const remaining = await this._waitForEnabled();
    const sel = await this._actionSelector();
    return this._tracedAction('longPress', 'tap', () => this._client.longPress(sel, durationMs, remaining), 'Long press failed');
  }

  async type(text: string): Promise<void> {
    const sel = await this._actionSelector();
    return this._tracedAction('type', 'type', () => this._client.typeText(sel, text, this._timeoutMs), 'Type text failed', { inputValue: text });
  }

  async clearAndType(text: string): Promise<void> {
    const sel = await this._actionSelector();
    return this._tracedAction('clearAndType', 'type', () => this._client.clearAndType(sel, text, this._timeoutMs), 'Clear and type failed', { inputValue: text });
  }

  async clear(): Promise<void> {
    const sel = await this._actionSelector();
    return this._tracedAction('clear', 'type', () => this._client.clearText(sel, this._timeoutMs), 'Clear text failed');
  }

  async scroll(direction: string, options?: { distance?: number }): Promise<void> {
    const sel = await this._actionSelector();
    return this._tracedAction('scroll', 'scroll',
      () => this._client.scroll(sel, direction, { distance: options?.distance, timeoutMs: this._timeoutMs }),
      'Scroll failed');
  }

  // ── Element Actions (PILOT-2) ──

  async doubleTap(): Promise<void> {
    const sel = await this._actionSelector();
    return this._tracedAction('doubleTap', 'tap', () => this._client.doubleTap(sel, this._timeoutMs), 'Double tap failed');
  }

  async dragTo(target: ElementHandle): Promise<void> {
    const sourceSel = await this._actionSelector();
    const targetSel = await target._actionSelector();
    return this._action(() => this._client.dragAndDrop(sourceSel, targetSel, this._timeoutMs), 'Drag and drop failed');
  }

  async setChecked(checked: boolean): Promise<void> {
    const el = await this._resolveOne();
    if (el.checked !== checked) {
      const sel = this._selectorForElement(el);
      await this._action(() => this._client.tap(sel, this._timeoutMs), 'setChecked tap failed');
      // Verify the state actually changed
      const after = await this._resolveOne();
      if (after.checked !== checked) {
        throw new Error(
          `setChecked(${checked}): element ${this._describe()} checked state did not change after tap (still ${after.checked})`,
        );
      }
    }
  }

  async selectOption(option: string | { index: number }): Promise<void> {
    const sel = await this._actionSelector();
    return this._action(() => this._client.selectOption(sel, option, this._timeoutMs), 'Select option failed');
  }

  async screenshot(): Promise<Buffer> {
    const sel = await this._actionSelector();
    const res = await this._client.takeElementScreenshot(sel, this._timeoutMs);
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
    const sel = await this._actionSelector();
    const scale = options?.scale ?? 0.5;
    return this._action(() => this._client.pinchZoom(sel, scale, this._timeoutMs), 'Pinch in failed');
  }

  async pinchOut(options?: { scale?: number }): Promise<void> {
    const sel = await this._actionSelector();
    const scale = options?.scale ?? 2.0;
    return this._action(() => this._client.pinchZoom(sel, scale, this._timeoutMs), 'Pinch out failed');
  }

  async focus(): Promise<void> {
    const sel = await this._actionSelector();
    return this._action(() => this._client.focus(sel, this._timeoutMs), 'Focus failed');
  }

  async blur(): Promise<void> {
    const sel = await this._actionSelector();
    return this._action(() => this._client.blur(sel, this._timeoutMs), 'Blur failed');
  }

  async highlight(options?: { durationMs?: number }): Promise<void> {
    const sel = await this._actionSelector();
    return this._action(() => this._client.highlight(sel, options?.durationMs, this._timeoutMs), 'Highlight failed');
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

    for (let i = 0; i <= maxScrolls; i++) {
      try {
        const res = await this._client.findElement(this._selector, SCROLL_PROBE_TIMEOUT_MS);
        if (res.found && res.element?.visible) {
          // Wait for scroll momentum to fully stop.  On iOS, momentum
          // deceleration continues after a swipe, and the first tap during
          // deceleration is consumed by the ScrollView (stops the scroll)
          // rather than being delivered to the child view.  Poll until the
          // element's position is stable for two consecutive checks.
          if (i > 0) {
            let lastY = res.element.bounds?.top;
            for (let s = 0; s < 10; s++) {
              await new Promise((r) => setTimeout(r, 100));
              const probe = await this._client.findElement(this._selector, 500);
              const curY = probe.element?.bounds?.top;
              if (curY !== undefined && curY === lastY) break;
              lastY = curY;
            }
          }
          await this._traceQuery(
            'scrollIntoView',
            `Visible after ${i} scroll(s)`,
            0,
            res.element.bounds,
          );
          return;
        }
      } catch (err) {
        // findElement throws when the element isn't in the tree at all
        // (e.g. virtualized list hasn't rendered it yet). This is expected
        // during scrolling — swipe again and retry.
        if (err instanceof Error && err.message.includes('UNAVAILABLE')) {
          // gRPC transport error — daemon/agent is down, don't swallow
          throw err;
        }
      }

      if (i < maxScrolls) {
        const swipeRes = await this._client.swipe(direction, { speed, distance: 0.6 });
        if (!swipeRes.success) {
          throw new Error(swipeRes.errorMessage || 'Swipe failed during scrollIntoView');
        }
        await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
      }
    }

    throw new Error(
      `scrollIntoView: ${this._describe()} was not visible after ${maxScrolls} scroll(s) in direction "${direction}"`,
    );
  }
}
