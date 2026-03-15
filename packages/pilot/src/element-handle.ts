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
  id as idSelector,
  text as textSelector,
  contentDesc as contentDescSelector,
} from './selectors.js';
import type { PilotGrpcClient, ElementInfo } from './grpc-client.js';

// ─── Filter options for .filter() ───

export interface FilterOptions {
  /** Keep elements whose text contains this string or matches this RegExp. */
  hasText?: string | RegExp;
  /** Keep elements that have a descendant matching this selector. */
  has?: Selector;
  /** Exclude elements that have a descendant matching this selector. */
  hasNot?: Selector;
  /** Exclude elements whose text contains this string or matches this RegExp. */
  hasNotText?: string | RegExp;
}

// ─── Internal options for modified handles ───

interface ElementHandleOptions {
  nthIndex?: number;
  filters?: FilterOptions[];
  andHandle?: ElementHandle;
  orHandle?: ElementHandle;
}

// ─── Helpers ───

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

export class ElementHandle {
  /** @internal */
  readonly _client: PilotGrpcClient;
  /** @internal */
  readonly _selector: Selector;
  /** @internal */
  readonly _timeoutMs: number;
  /** @internal */
  private readonly _options: ElementHandleOptions;

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

  // ── Scoping ──

  /**
   * Scope a child selector within this element.
   */
  element(childSelector: Selector): ElementHandle {
    const scoped = childSelector.within(this._selector);
    return new ElementHandle(this._client, scoped, this._timeoutMs);
  }

  // ── Positional selection (PILOT-15) ──

  /** Return a new handle targeting the first match. */
  first(): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: 0,
    });
  }

  /** Return a new handle targeting the last match. */
  last(): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: -1,
    });
  }

  /** Return a new handle targeting the match at `index` (0-based). Negative indices count from the end. */
  nth(index: number): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      nthIndex: index,
    });
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

  /** Return a handle matching elements that satisfy both this and the other handle's selector. */
  and(other: ElementHandle): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      andHandle: other,
    });
  }

  /** Return a handle matching elements that satisfy either this or the other handle's selector. */
  or(other: ElementHandle): ElementHandle {
    return new ElementHandle(this._client, this._selector, this._timeoutMs, {
      ...this._options,
      orHandle: other,
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

  /** @internal — Resolve all matching elements, applying and/or, then filters. */
  async _resolveAll(): Promise<ElementInfo[]> {
    let elements: ElementInfo[];

    if (this._options.orHandle) {
      const [a, b] = await Promise.all([
        this._client.findElements(this._selector, this._timeoutMs),
        this._client.findElements(this._options.orHandle._selector, this._timeoutMs),
      ]);
      const seen = new Set<string>();
      elements = [];
      for (const el of [...(a.elements ?? []), ...(b.elements ?? [])]) {
        if (!seen.has(el.elementId)) {
          seen.add(el.elementId);
          elements.push(el);
        }
      }
    } else if (this._options.andHandle) {
      const [a, b] = await Promise.all([
        this._client.findElements(this._selector, this._timeoutMs),
        this._client.findElements(this._options.andHandle._selector, this._timeoutMs),
      ]);
      const bIds = new Set((b.elements ?? []).map((e) => e.elementId));
      elements = (a.elements ?? []).filter((e) => bIds.has(e.elementId));
    } else {
      const res = await this._client.findElements(this._selector, this._timeoutMs);
      elements = res.elements ?? [];
    }

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
      const childSelector = filter.has.within(this._selector);
      const childRes = await this._client.findElements(childSelector, 0);
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) =>
        childElements.some((child) => boundsContain(parent.bounds, child.bounds)),
      );
    }

    if (filter.hasNot !== undefined) {
      const childSelector = filter.hasNot.within(this._selector);
      const childRes = await this._client.findElements(childSelector, 0);
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
    const elements = await this._resolveAll();
    const nthIndex = this._options.nthIndex;

    if (nthIndex !== undefined) {
      const idx = nthIndex < 0 ? elements.length + nthIndex : nthIndex;
      if (idx < 0 || idx >= elements.length) {
        throw new Error(
          `nth(${nthIndex}): expected at least ${Math.abs(nthIndex < 0 ? nthIndex : nthIndex + 1)} element(s), but found ${elements.length}`,
        );
      }
      return elements[idx];
    }

    if (elements.length === 0) {
      throw new Error(
        `Element not found: ${JSON.stringify(selectorToProto(this._selector))}`,
      );
    }
    return elements[0];
  }

  /**
   * @internal — Build the best available selector to target a specific resolved element.
   * Used by action methods on modified handles.
   */
  private _selectorForElement(info: ElementInfo): Selector {
    if (info.resourceId) return idSelector(info.resourceId);
    if (info.contentDescription) return contentDescSelector(info.contentDescription);
    if (info.text) return textSelector(info.text);
    return this._selector;
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
    if (this._hasModifiers()) {
      return this._resolveOne();
    }
    const res = await this._client.findElement(this._selector, this._timeoutMs);
    if (!res.found || !res.element) {
      throw new Error(
        res.errorMessage ||
          `Element not found: ${JSON.stringify(selectorToProto(this._selector))}`,
      );
    }
    return res.element;
  }

  /** Returns true if the element exists in the current UI. */
  async exists(): Promise<boolean> {
    if (this._hasModifiers()) {
      try {
        await this._resolveOne();
        return true;
      } catch {
        return false;
      }
    }
    const res = await this._client.findElement(this._selector, this._timeoutMs);
    return res.found;
  }

  /** Return the number of elements matching the selector (PILOT-14). */
  async count(): Promise<number> {
    const elements = await this._resolveAll();
    return elements.length;
  }

  /** Return an array of ElementHandles, one for each matching element (PILOT-13). */
  async all(): Promise<ElementHandle[]> {
    const elements = await this._resolveAll();
    return elements.map((_, i) =>
      new ElementHandle(this._client, this._selector, this._timeoutMs, {
        ...this._options,
        nthIndex: i,
      }),
    );
  }

  // ── Actions ──

  async tap(): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.tap(sel, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Tap failed');
    }
  }

  async longPress(durationMs?: number): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.longPress(sel, durationMs, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Long press failed');
    }
  }

  async type(text: string): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.typeText(sel, text, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Type text failed');
    }
  }

  async clearAndType(text: string): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.clearAndType(sel, text, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Clear and type failed');
    }
  }

  async clear(): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.clearText(sel, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Clear text failed');
    }
  }

  async scroll(direction: string, options?: { distance?: number }): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.scroll(sel, direction, {
      distance: options?.distance,
      timeoutMs: this._timeoutMs,
    });
    if (!res.success) {
      throw new Error(res.errorMessage || 'Scroll failed');
    }
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
}
