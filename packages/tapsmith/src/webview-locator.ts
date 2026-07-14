import type { WebViewHandle } from './webview-handle.js';

/**
 * Lazy reference to an element within a WebView.
 *
 * Created via `webview.locator(css)`, `webview.getByText(text)`,
 * `webview.getByRole(role)`, etc. Compatible with `expect()` assertions.
 *
 * `_selector` is used for display/tracing. `_finderAllJs` is a JS expression
 * evaluated via CDP that returns an Array of ALL matching elements in
 * document order (defaults to `querySelectorAll(selector)` when not
 * explicitly set); `_finderJs` derives the single target element from it.
 *
 * Strict mode (PILOT-227): like native locators, an action, single-element
 * query, or positive assertion on a locator that resolves to more than one
 * element throws a StrictModeViolationError. Narrow with `.first()`,
 * `.last()`, or `.nth(n)` to target one match positionally.
 */
/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const WEBVIEW_LOCATOR_BRAND = Symbol.for('tapsmith.WebViewLocator');

export class WebViewLocator {
  /** @internal */
  readonly [WEBVIEW_LOCATOR_BRAND] = true;
  /** @internal */
  readonly _handle: WebViewHandle;
  /** @internal */
  readonly _selector: string;
  /** @internal */
  readonly _timeoutMs: number;
  /** @internal — JS expression returning an Array of all matched elements (document order). */
  readonly _finderAllJs: string;
  /** @internal — Positional index from first()/last()/nth(); negative counts
   * from the end. `undefined` means the locator is strict (single-match). */
  readonly _nthIndex: number | undefined;

  /** @internal */
  constructor(
    handle: WebViewHandle,
    selector: string,
    timeoutMs: number,
    finderAllJs?: string,
    nthIndex?: number,
  ) {
    this._handle = handle;
    this._selector = selector;
    this._timeoutMs = timeoutMs;
    this._finderAllJs = finderAllJs ?? `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
    this._nthIndex = nthIndex;
  }

  /** @internal — JS expression that returns the single target element (or null). */
  get _finderJs(): string {
    const n = this._nthIndex ?? 0;
    if (n >= 0) {
      return `((${this._finderAllJs})[${n}] ?? null)`;
    }
    // Negative index counts from the end (last() = nth(-1)).
    return `((els) => els[els.length - ${-n}] ?? null)(${this._finderAllJs})`;
  }

  // ─── Positional narrowing (strict mode exempt) ───

  /** Narrow to the first match. Exempt from strict mode. */
  first(): WebViewLocator {
    return this.nth(0);
  }

  /** Narrow to the last match. Exempt from strict mode. */
  last(): WebViewLocator {
    return this.nth(-1);
  }

  /**
   * Narrow to the nth match (0-based; negative counts from the end).
   * Exempt from strict mode.
   */
  nth(index: number): WebViewLocator {
    if (!Number.isInteger(index)) {
      throw new Error(`nth(${index}): index must be an integer`);
    }
    return new WebViewLocator(
      this._handle,
      `${this._selector} >> nth=${index}`,
      this._timeoutMs,
      this._finderAllJs,
      index,
    );
  }

  // ─── Multi-element queries (strict mode exempt) ───

  /** Return the number of elements currently matching (no auto-wait). */
  async count(): Promise<number> {
    return this._handle._countLocator(this);
  }

  /** Return one positionally-narrowed locator per current match (no auto-wait). */
  async all(): Promise<WebViewLocator[]> {
    const n = await this.count();
    if (this._nthIndex !== undefined) {
      return n > 0 ? [this] : [];
    }
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  // ─── Actions and single-element queries (strict) ───

  async click(): Promise<void> {
    await this._handle._clickLocator(this);
  }

  async fill(value: string): Promise<void> {
    await this._handle._fillLocator(this, value);
  }

  async textContent(): Promise<string> {
    return this._handle._textContentLocator(this);
  }

  async innerHTML(): Promise<string> {
    return this._handle._innerHTMLLocator(this);
  }

  async inputValue(): Promise<string> {
    return this._handle._inputValueLocator(this);
  }

  async getAttribute(name: string): Promise<string | null> {
    return this._handle._getAttributeLocator(this, name);
  }

  async isVisible(): Promise<boolean> {
    return this._handle._isVisibleLocator(this);
  }
}
