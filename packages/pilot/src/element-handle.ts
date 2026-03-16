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

// ─── Public types ───

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** Left operand for and() — the full handle `this` was called on. */
  andSelf?: ElementHandle;
  andHandle?: ElementHandle;
  /** Left operand for or() — the full handle `this` was called on. */
  orSelf?: ElementHandle;
  orHandle?: ElementHandle;
  resolvedElementsPromise?: Promise<ElementInfo[]>;
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
   *
   * Cannot be called on modified handles (e.g. after `.first()`, `.filter()`, `.and()`).
   * Use `.find()` to resolve the parent first if you need to scope within a specific element.
   */
  element(childSelector: Selector): ElementHandle {
    if (this._hasModifiers()) {
      throw new Error(
        'element() cannot be called on a modified handle (e.g. after .first(), .filter(), .and()). ' +
          'Resolve the parent with .find() first, then scope children using the resolved element\'s properties.',
      );
    }
    const scoped = childSelector.within(this._selector);
    return new ElementHandle(this._client, scoped, this._timeoutMs);
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
      const childSelector = filter.has.within(this._selector);
      const childRes = await this._client.findElements(childSelector, this._timeoutMs);
      const childElements = childRes.elements ?? [];
      result = result.filter((parent) =>
        childElements.some((child) => boundsContain(parent.bounds, child.bounds)),
      );
    }

    if (filter.hasNot !== undefined) {
      const childSelector = filter.hasNot.within(this._selector);
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
    if (info.resourceId) return idSelector(info.resourceId);
    if (info.contentDescription) return contentDescSelector(info.contentDescription);
    if (info.text) return textSelector(info.text);
    throw new Error(
      'Cannot target element for action: element has no resourceId, contentDescription, or text. ' +
        'Add accessibility identifiers to your app to use positional/filtered actions.',
    );
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
          `Element not found: ${this._describe()}`,
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

  /**
   * Return an array of ElementHandles, one for each matching element (PILOT-13).
   *
   * The resolved elements are cached in the returned handles, so iterating
   * and performing actions will not re-query `findElements` for each handle.
   */
  async all(): Promise<ElementHandle[]> {
    const resolvedElementsPromise = this._resolveAll();
    const elements = await resolvedElementsPromise;
    return elements.map((_, i) =>
      new ElementHandle(this._client, this._selector, this._timeoutMs, {
        ...this._options,
        nthIndex: i,
        resolvedElementsPromise,
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

  // ── Element Actions (PILOT-2) ──

  async doubleTap(): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.doubleTap(sel, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Double tap failed');
    }
  }

  async dragTo(target: ElementHandle): Promise<void> {
    const sourceSel = await this._actionSelector();
    const targetSel = await target._actionSelector();
    const res = await this._client.dragAndDrop(sourceSel, targetSel, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Drag and drop failed');
    }
  }

  async setChecked(checked: boolean): Promise<void> {
    const el = await this._resolveOne();
    if (el.checked !== checked) {
      const sel = this._selectorForElement(el);
      const res = await this._client.tap(sel, this._timeoutMs);
      if (!res.success) {
        throw new Error(res.errorMessage || 'setChecked tap failed');
      }
      // Verify the state actually changed
      const after = await this._resolveOne();
      if (after.checked !== checked) {
        throw new Error(
          `setChecked(${checked}): element checked state did not change after tap (still ${after.checked})`,
        );
      }
    }
  }

  async selectOption(option: string | { index: number }): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.selectOption(sel, option, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Select option failed');
    }
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
    const res = await this._client.pinchZoom(sel, scale, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Pinch in failed');
    }
  }

  async pinchOut(options?: { scale?: number }): Promise<void> {
    const sel = await this._actionSelector();
    const scale = options?.scale ?? 2.0;
    const res = await this._client.pinchZoom(sel, scale, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Pinch out failed');
    }
  }

  async focus(): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.focus(sel, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Focus failed');
    }
  }

  async blur(): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.blur(sel, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Blur failed');
    }
  }

  async highlight(options?: { durationMs?: number }): Promise<void> {
    const sel = await this._actionSelector();
    const res = await this._client.highlight(sel, options?.durationMs, this._timeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Highlight failed');
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

  async isChecked(): Promise<boolean> {
    const info = this._hasModifiers() ? await this._resolveOne() : await this.find();
    return info.checked;
  }

  async inputValue(): Promise<string> {
    const info = this._hasModifiers() ? await this._resolveOne() : await this.find();
    return info.text;
  }
}
