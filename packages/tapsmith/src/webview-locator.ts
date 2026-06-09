import type { WebViewHandle } from './webview-handle.js';

/**
 * Lazy reference to an element within a WebView.
 *
 * Created via `webview.locator(css)`, `webview.getByText(text)`,
 * `webview.getByRole(role)`, etc. Compatible with `expect()` assertions.
 *
 * `_selector` is used for display/tracing. `_finderJs` is the actual JS
 * expression evaluated via CDP to find the element (defaults to
 * `document.querySelector(selector)` when not explicitly set).
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
  /** @internal — JS expression that returns the matched element (or null). */
  readonly _finderJs: string;

  /** @internal */
  constructor(handle: WebViewHandle, selector: string, timeoutMs: number, finderJs?: string) {
    this._handle = handle;
    this._selector = selector;
    this._timeoutMs = timeoutMs;
    this._finderJs = finderJs ?? `document.querySelector(${JSON.stringify(selector)})`;
  }

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
