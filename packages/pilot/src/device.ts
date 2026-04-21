/**
 * Device — the primary user-facing API for interacting with a mobile device.
 *
 * All methods accept a Selector and delegate to the Rust daemon via gRPC.
 * Auto-waiting is handled daemon-side; the SDK just passes the configured
 * timeout.
 */

import {
  type Selector,
  _text,
  _textContains,
  _role,
  _contentDesc,
  _hint,
  _testId,
} from './selectors.js';
import {
  PilotGrpcClient,
  type ActionResponse,
  type ScreenshotResponse,
  type LaunchAppOptions,
  type AppState,
  type Orientation,
  type ColorScheme,
} from './grpc-client.js';
import { ElementHandle, locatorOptionsToSelector, type LocatorOptions } from './element-handle.js';
import type { PilotConfig } from './config.js';
import { Tracing } from './trace/tracing.js';
import { type TraceCollector, getActiveTraceCollector, extractSourceLocation } from './trace/trace-collector.js';
import type { ActionCategory } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';
import {
  NetworkRouteManager,
  type PilotRequest,
  type Route,
  type NetworkResponseEventData,
  matchUrlPattern,
} from './network.js';
import { WebViewHandle } from './webview-handle.js';
import type { Platform } from './config.js';

// ─── Types for device-level actions ───

/** Options for `device.swipe()`. */
export interface SwipeOptions {
  /** Swipe speed in pixels/second. Default `2000`. */
  speed?: number;
  /** Fraction of the screen to swipe across, 0–1. Default `0.6`. */
  distance?: number;
  /** Per-action timeout. Defaults to the device default. */
  timeoutMs?: number;
}

export class Device {
  /** @internal */
  readonly _client: PilotGrpcClient;
  private _defaultTimeoutMs: number;
  private readonly defaultPackageName?: string;
  /** @internal */
  readonly _platform: Platform;
  /** @internal — Simulator UDID for iOS WebView connections. */
  readonly _simulatorUdid?: string;

  /** Programmatic tracing API. */
  readonly tracing: Tracing;

  /** @internal — Network route manager (lazily created). */
  _routeManager: NetworkRouteManager | null = null;

  /** @internal — Active WebView handle, if in WebView context. */
  _activeWebView: WebViewHandle | null = null;

  constructor(client: PilotGrpcClient, config?: Partial<Pick<PilotConfig, 'timeout' | 'package' | 'platform' | 'simulator'>>) {
    this._client = client;
    this._defaultTimeoutMs = config?.timeout ?? 30_000;
    this.defaultPackageName = config?.package;
    this._platform = config?.platform ?? 'android';
    this._simulatorUdid = config?.simulator;
    this.tracing = new Tracing(
      () => this._takeScreenshotBuffer(),
      () => this._captureHierarchy(),
    );
  }

  private _ensureRouteManager(): NetworkRouteManager {
    if (!this._routeManager) {
      this._routeManager = new NetworkRouteManager(this._client);
    }
    return this._routeManager;
  }

  /**
   * @internal — Get the current default timeout. Used by the runner for test.use().
   * Not safe for concurrent use — relies on the runner's one-device-per-worker model.
   */
  _getDefaultTimeout(): number {
    return this._defaultTimeoutMs;
  }

  /** @internal — Override the default timeout. Used by the runner for test.use(). */
  _setDefaultTimeout(timeoutMs: number): void {
    this._defaultTimeoutMs = timeoutMs;
  }

  /** @internal — Get the active trace collector, if any. */
  private get _traceCollector(): TraceCollector | null {
    return this.tracing._currentCollector ?? getActiveTraceCollector();
  }

  /** @internal — Take a screenshot and return the raw buffer. */
  private async _takeScreenshotBuffer(): Promise<Buffer | undefined> {
    try {
      const res = await this._client.takeScreenshot();
      return res.success ? res.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** @internal — Capture the view hierarchy XML, including WebView DOM when active. */
  private async _captureHierarchy(): Promise<string | undefined> {
    try {
      const res = await this._client.getUiHierarchy();
      let xml = res.hierarchyXml || undefined;

      // Append WebView DOM hierarchy if a WebView is active
      if (xml && this._activeWebView) {
        try {
          const webviewDom = await this._activeWebView._dumpDomHierarchy();
          if (webviewDom) {
            // Insert WebView DOM nodes before the closing root tag
            const lastClose = xml.lastIndexOf('</');
            if (lastClose !== -1) {
              xml = xml.slice(0, lastClose) + webviewDom + '\n' + xml.slice(lastClose);
            }
          }
        } catch { /* best-effort */ }
      }

      return xml;
    } catch {
      return undefined;
    }
  }

  /** @internal — Run an action RPC and throw on failure. */
  /**
   * @internal — Wrap an action with trace recording (before/after screenshots + hierarchy).
   */
  private async _tracedAction(
    action: string,
    category: ActionCategory,
    selector: Selector | undefined,
    fn: () => Promise<ActionResponse>,
    fallbackMsg: string,
    extra?: { inputValue?: string },
  ): Promise<void> {
    const collector = this._traceCollector;
    const ctx = collector ? {
      collector,
      takeScreenshot: () => this._takeScreenshotBuffer(),
      captureHierarchy: () => this._captureHierarchy(),
      findElement: (sel: Selector, timeout: number) => this._client.findElement(sel, timeout),
    } : undefined;
    return tracedAction(ctx, action, category, selector, fn, fallbackMsg, extra);
  }

  // ── Locators (Playwright-style getBy* methods) ──

  /**
   * Locate an element by visible text. Substring match by default; pass
   * `{ exact: true }` for an exact match.
   */
  getByText(text: string, options?: { exact?: boolean }): ElementHandle {
    return this._handle(options?.exact ? _text(text) : _textContains(text));
  }

  /** Locate an element by accessibility role, optionally with an accessible name. */
  getByRole(role: string, options?: { name?: string }): ElementHandle {
    return this._handle(_role(role, options?.name));
  }

  /**
   * Locate an element by its accessibility description (Android
   * `contentDescription`, iOS `accessibilityLabel`).
   */
  getByDescription(text: string): ElementHandle {
    return this._handle(_contentDesc(text));
  }

  /** Locate an element by placeholder text (Android hint, iOS placeholder). */
  getByPlaceholder(text: string): ElementHandle {
    return this._handle(_hint(text));
  }

  /** Locate an element by its test ID. */
  getByTestId(testId: string): ElementHandle {
    return this._handle(_testId(testId));
  }

  /**
   * Escape hatch: locate an element by native id, xpath, or class name.
   * Prefer accessible getters (`getByRole`, `getByText`, `getByDescription`)
   * when possible.
   */
  locator(options: LocatorOptions): ElementHandle {
    return this._handle(locatorOptionsToSelector(options));
  }

  /** @internal */
  private _handle(selector: Selector): ElementHandle {
    const traceCapture = this._traceCollector ? {
      collector: this._traceCollector,
      takeScreenshot: () => this._takeScreenshotBuffer(),
      captureHierarchy: () => this._captureHierarchy(),
    } : undefined;
    return new ElementHandle(this._client, selector, this._defaultTimeoutMs, { traceCapture });
  }

  // ── Device-level actions ──

  async swipe(direction: string, options?: SwipeOptions): Promise<void> {
    return this._tracedAction('swipe', 'swipe', undefined,
      () => this._client.swipe(direction, { ...options, timeoutMs: options?.timeoutMs ?? this._defaultTimeoutMs }),
      'Swipe failed');
  }

  async pressKey(key: string): Promise<void> {
    return this._tracedAction('pressKey', 'press-key', undefined,
      () => this._client.pressKey(key), 'Press key failed');
  }

  /** Press the hardware back button. @platform android */
  async pressBack(): Promise<void> {
    return this.pressKey('BACK');
  }

  // ── Utilities ──

  async takeScreenshot(): Promise<ScreenshotResponse> {
    return this._client.takeScreenshot();
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const res = await this._client.waitForIdle(timeoutMs ?? this._defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Wait for idle timed out');
    }
  }

  async installApk(apkPath: string): Promise<void> {
    const res = await this._client.installApk(apkPath);
    if (!res.success) {
      throw new Error(res.errorMessage || 'APK install failed');
    }
  }

  async listDevices() {
    return this._client.listDevices();
  }

  async setDevice(
    serial: string,
    networkTracingEnabled = false,
    networkHosts: string[] = [],
  ): Promise<void> {
    // Refresh the daemon's device registry so newly-launched emulators are visible
    await this._client.listDevices();
    const res = await this._client.setDevice(serial, networkTracingEnabled, networkHosts);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Set device failed');
    }
  }

  async startAgent(
    targetPackage: string,
    agentApkPath?: string,
    agentTestApkPath?: string,
    iosXctestrunPath?: string,
    iosAppPath?: string,
    networkTracingEnabled = false,
  ): Promise<void> {
    const res = await this._client.startAgent(
      targetPackage,
      agentApkPath,
      agentTestApkPath,
      iosXctestrunPath,
      iosAppPath,
      networkTracingEnabled,
    );
    if (!res.success) {
      throw new Error(res.errorMessage || 'Start agent failed');
    }
  }

  // ── Device Management (PILOT-10) ──

  private requirePackageName(packageName?: string): string {
    const resolved = packageName ?? this.defaultPackageName;
    if (!resolved) {
      throw new Error(
        'Package name is required. Pass one explicitly or set `package` in your Pilot config.',
      );
    }
    return resolved;
  }

  async restartApp(options?: { waitForIdle?: boolean }): Promise<void>;
  async restartApp(packageName: string, options?: { waitForIdle?: boolean }): Promise<void>;
  async restartApp(
    packageOrOptions?: string | { waitForIdle?: boolean },
    maybeOptions?: { waitForIdle?: boolean },
  ): Promise<void> {
    const packageName = typeof packageOrOptions === 'string' ? packageOrOptions : undefined;
    const options = typeof packageOrOptions === 'string' ? maybeOptions : packageOrOptions;
    return this._tracedAction('restartApp', 'device', undefined,
      () => this._client.restartApp(this.requirePackageName(packageName), options?.waitForIdle ?? true),
      'Restart app failed');
  }

  async launchApp(packageName: string, options?: LaunchAppOptions): Promise<void> {
    return this._tracedAction('launchApp', 'navigation', undefined,
      () => this._client.launchApp(packageName, options),
      'Launch app failed');
  }

  async openDeepLink(uri: string): Promise<void> {
    return this._tracedAction('openDeepLink', 'navigation', undefined,
      () => this._client.openDeepLink(uri),
      'Open deep link failed');
  }

  async currentPackage(): Promise<string> {
    const res = await this._client.getCurrentPackage();
    return res.packageName;
  }

  /** Return the current foreground activity name (e.g. `.MainActivity`). @platform android */
  async currentActivity(): Promise<string> {
    const res = await this._client.getCurrentActivity();
    return res.activity;
  }

  async terminateApp(packageName: string): Promise<void> {
    return this._tracedAction('terminateApp', 'device', undefined,
      () => this._client.terminateApp(packageName),
      'Terminate app failed');
  }

  async getAppState(packageName: string): Promise<AppState> {
    const res = await this._client.getAppState(packageName);
    return res.state as AppState;
  }

  /** Send the app to the background by pressing the home key. @platform android */
  async sendToBackground(): Promise<void> {
    return this.pressKey('HOME');
  }

  async bringToForeground(packageName: string): Promise<void> {
    return this.launchApp(packageName);
  }

  async saveAppState(packageName: string, path: string): Promise<void> {
    return this._tracedAction('saveAppState', 'device', undefined,
      () => this._client.saveAppState(this.requirePackageName(packageName), path),
      'Save app state failed');
  }

  async restoreAppState(packageName: string, path: string): Promise<void> {
    return this._tracedAction('restoreAppState', 'device', undefined,
      () => this._client.restoreAppState(this.requirePackageName(packageName), path),
      'Restore app state failed');
  }

  /** Clear app data (AsyncStorage, caches, etc.) and stop the app. */
  async clearAppData(packageName: string): Promise<void> {
    return this._tracedAction('clearAppData', 'device', undefined,
      () => this._client.clearAppData(packageName),
      'Clear app data failed');
  }

  /** Programmatically grant a runtime permission. @platform android */
  async grantPermission(packageName: string, permission: string): Promise<void> {
    return this._tracedAction('grantPermission', 'device', undefined,
      () => this._client.grantPermission(packageName, permission),
      'Grant permission failed');
  }

  /** Revoke a previously granted runtime permission. @platform android */
  async revokePermission(packageName: string, permission: string): Promise<void> {
    return this._tracedAction('revokePermission', 'device', undefined,
      () => this._client.revokePermission(packageName, permission),
      'Revoke permission failed');
  }

  async setClipboard(text: string): Promise<void> {
    return this._tracedAction('setClipboard', 'device', undefined,
      () => this._client.setClipboard(text),
      'Set clipboard failed');
  }

  async getClipboard(): Promise<string> {
    const res = await this._client.getClipboard();
    return res.text;
  }

  async setOrientation(orientation: Orientation): Promise<void> {
    return this._tracedAction('setOrientation', 'device', undefined,
      () => this._client.setOrientation(orientation),
      'Set orientation failed');
  }

  async getOrientation(): Promise<Orientation> {
    const res = await this._client.getOrientation();
    return res.orientation as Orientation;
  }

  async isKeyboardShown(): Promise<boolean> {
    const res = await this._client.isKeyboardShown();
    return res.shown;
  }

  async hideKeyboard(): Promise<void> {
    return this._tracedAction('hideKeyboard', 'device', undefined,
      () => this._client.hideKeyboard(),
      'Hide keyboard failed');
  }

  async wake(): Promise<void> {
    return this._tracedAction('wake', 'device', undefined,
      () => this._client.wakeDevice(),
      'Wake device failed');
  }

  async unlock(): Promise<void> {
    return this._tracedAction('unlock', 'device', undefined,
      () => this._client.unlockDevice(),
      'Unlock device failed');
  }

  /** Press the home button. @platform android */
  async pressHome(): Promise<void> {
    return this.pressKey('HOME');
  }

  /** Open the notification shade. @platform android */
  async openNotifications(): Promise<void> {
    return this._tracedAction('openNotifications', 'device', undefined,
      () => this._client.openNotifications(),
      'Open notifications failed');
  }

  /** Open the quick settings panel. @platform android */
  async openQuickSettings(): Promise<void> {
    return this._tracedAction('openQuickSettings', 'device', undefined,
      () => this._client.openQuickSettings(),
      'Open quick settings failed');
  }

  /** Open the recent apps screen. @platform android */
  async pressRecentApps(): Promise<void> {
    return this.pressKey('APP_SWITCH');
  }

  /** Set the device color scheme (dark/light). @platform android */
  async setColorScheme(scheme: ColorScheme): Promise<void> {
    return this._tracedAction('setColorScheme', 'device', undefined,
      () => this._client.setColorScheme(scheme),
      'Set color scheme failed');
  }

  async getColorScheme(): Promise<ColorScheme> {
    const res = await this._client.getColorScheme();
    return res.scheme as ColorScheme;
  }

  /**
   * @internal — Start network capture (used by the runner).
   *
   * Returns the ephemeral proxy port and any non-fatal warning the daemon
   * surfaced (e.g. iOS NE redirector setup failed because the SE isn't
   * approved, CA install was best-effort). The runner logs `errorMessage`
   * as a visible warning so users aren't left wondering why their trace
   * has no network entries.
   */
  async _startNetworkCapture(): Promise<{
    proxyPort: number
    success: boolean
    errorMessage: string
  }> {
    const res = await this._client.startNetworkCapture();
    return {
      proxyPort: res.proxyPort,
      success: res.success,
      errorMessage: res.errorMessage,
    };
  }

  /** @internal — Stop network capture and return entries (used by the runner). */
  async _stopNetworkCapture(): Promise<ReturnType<PilotGrpcClient['stopNetworkCapture']>> {
    return this._client.stopNetworkCapture();
  }

  // ─── Network Route Interception ───

  /**
   * Intercept network requests matching a URL pattern. The handler receives a
   * `Route` object that can `abort()`, `continue()`, `fulfill()`, or `fetch()`
   * the request.
   */
  async route(
    url: string | RegExp | ((url: URL) => boolean),
    handler: (route: Route) => Promise<void> | void,
    options?: { times?: number },
  ): Promise<void> {
    const start = Date.now();
    const source = extractSourceLocation(new Error().stack ?? '');
    await this._ensureRouteManager().addRoute(url, handler, options);
    this._emitNetworkAction('route', formatPattern(url), start, true, undefined, source);
  }

  /**
   * Remove a previously registered route handler.
   * If `handler` is omitted, all handlers for the pattern are removed.
   */
  async unroute(
    url: string | RegExp | ((url: URL) => boolean),
    handler?: (route: Route) => Promise<void> | void,
  ): Promise<void> {
    if (!this._routeManager) return;
    const start = Date.now();
    const source = extractSourceLocation(new Error().stack ?? '');
    await this._routeManager.removeRoute(url, handler);
    this._emitNetworkAction('unroute', formatPattern(url), start, true, undefined, source);
  }

  /** Remove all registered route handlers. */
  async unrouteAll(): Promise<void> {
    if (!this._routeManager) return;
    const start = Date.now();
    const source = extractSourceLocation(new Error().stack ?? '');
    await this._routeManager.removeAllRoutes();
    this._emitNetworkAction('unrouteAll', undefined, start, true, undefined, source);
  }

  /** Wait for a request matching the pattern. */
  waitForRequest(
    urlOrPredicate: string | RegExp | ((request: PilotRequest) => boolean),
    options?: { timeout?: number },
  ): Promise<PilotRequest> {
    const timeout = options?.timeout ?? this._defaultTimeoutMs;
    const manager = this._ensureRouteManager();

    return new Promise<PilotRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        manager.removeRequestListener(listener);
        reject(new Error(`waitForRequest timed out after ${timeout}ms`));
      }, timeout);

      const listener = (req: PilotRequest) => {
        const matches = typeof urlOrPredicate === 'function'
          ? urlOrPredicate(req)
          : matchUrlPattern(req.url, urlOrPredicate);
        if (matches) {
          clearTimeout(timer);
          manager.removeRequestListener(listener);
          resolve(req);
        }
      };
      manager.addRequestListener(listener);
    });
  }

  /** Wait for a response matching the pattern. */
  waitForResponse(
    urlOrPredicate: string | RegExp | ((response: NetworkResponseEventData) => boolean),
    options?: { timeout?: number },
  ): Promise<NetworkResponseEventData> {
    const timeout = options?.timeout ?? this._defaultTimeoutMs;
    const manager = this._ensureRouteManager();

    return new Promise<NetworkResponseEventData>((resolve, reject) => {
      const timer = setTimeout(() => {
        manager.removeResponseListener(listener);
        reject(new Error(`waitForResponse timed out after ${timeout}ms`));
      }, timeout);

      const listener = (resp: NetworkResponseEventData) => {
        const matches = typeof urlOrPredicate === 'function'
          ? urlOrPredicate(resp)
          : matchUrlPattern(resp.url, urlOrPredicate);
        if (matches) {
          clearTimeout(timer);
          manager.removeResponseListener(listener);
          resolve(resp);
        }
      };
      manager.addResponseListener(listener);
    });
  }

  /** Subscribe to network request/response events. */
  on(event: 'request', handler: (request: PilotRequest) => void): void;
  on(event: 'response', handler: (response: NetworkResponseEventData) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation
  on(event: string, handler: (...args: any[]) => void): void {
    const manager = this._ensureRouteManager();
    if (event === 'request') {
      manager.addRequestListener(handler as (req: PilotRequest) => void);
    } else {
      manager.addResponseListener(handler as (resp: NetworkResponseEventData) => void);
    }
  }

  /** Unsubscribe from network events. */
  off(event: 'request', handler: (request: PilotRequest) => void): void;
  off(event: 'response', handler: (response: NetworkResponseEventData) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation
  off(event: string, handler: (...args: any[]) => void): void {
    if (!this._routeManager) return;
    if (event === 'request') {
      this._routeManager.removeRequestListener(handler as (req: PilotRequest) => void);
    } else {
      this._routeManager.removeResponseListener(handler as (resp: NetworkResponseEventData) => void);
    }
  }

  /** @internal — Dispose the route manager (called by the runner during cleanup). */
  async _disposeRouteManager(): Promise<void> {
    if (this._routeManager) {
      await this._routeManager.dispose();
      this._routeManager = null;
    }
  }

  // ─── WebView Testing (PILOT-116) ───

  /**
   * Switch to a WebView context for hybrid app testing.
   *
   * Returns a `WebViewHandle` that supports CSS selectors, `click()`, `fill()`,
   * `textContent()`, `evaluate()`, and `locator()` for web content interaction.
   *
   * @param packageName - Optional package name to target a specific WebView
   *   when multiple are present.
   */
  async webview(packageName?: string): Promise<WebViewHandle> {
    if (this._platform === 'ios') {
      return this._webviewIos(packageName);
    }
    return this._webviewAndroid(packageName);
  }

  private async _webviewAndroid(packageName?: string): Promise<WebViewHandle> {
    const deadline = Date.now() + this._defaultTimeoutMs;

    let lastError = '';
    while (Date.now() < deadline) {
      const list = await this._client.listWebViews();
      if (list.errorMessage) {
        lastError = list.errorMessage;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      let webviews = list.webviews;
      if (packageName) {
        webviews = webviews.filter(w => w.packageName === packageName);
      }

      if (webviews.length === 0) {
        lastError = packageName
          ? `No WebViews found for package "${packageName}"`
          : 'No WebViews found';
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      const target = webviews[0];
      const fwd = await this._client.forwardWebViewPort(target.socketName);
      if (!fwd.success) {
        throw new Error(`Failed to forward WebView port: ${fwd.errorMessage}`);
      }

      const handle = new WebViewHandle(this._client, fwd.localPort, this._defaultTimeoutMs);
      this._applyTraceCtx(handle);
      await handle._connect();

      this._activeWebView = handle;
      return handle;
    }

    throw new Error(
      `Timed out waiting for WebView (${this._defaultTimeoutMs}ms). ${lastError}. ` +
      'Ensure the app has a visible WebView with debugging enabled ' +
      '(WebView.setWebContentsDebuggingEnabled(true)).',
    );
  }

  private async _webviewIos(_packageName?: string): Promise<WebViewHandle> {
    const { WebKitInspectorClient, findSimulatorInspectorSocket } = await import('./webkit-inspector.js');

    // Find the simulator's webinspectord socket
    // The UDID may be the resolved simulator UDID stored by the dispatcher
    const udid = this._simulatorUdid ?? '';
    const socketPath = findSimulatorInspectorSocket(udid);
    if (!socketPath) {
      throw new Error(
        `Could not find WebKit Inspector socket for simulator "${udid}". ` +
        'Ensure the iOS simulator is booted.',
      );
    }

    const inspector = new WebKitInspectorClient();
    await inspector.connect(socketPath);

    const deadline = Date.now() + this._defaultTimeoutMs;
    let lastError = '';

    while (Date.now() < deadline) {
      const targets = await inspector.listTargets();

      // Find the target app's WebView pages — prefer matching by package/name,
      // fall back to the first app with any inspectable pages.
      const matchesPkg = (t: { bundleId: string; name: string }) => {
        if (_packageName) return t.bundleId === _packageName || t.name === _packageName;
        if (this.defaultPackageName) return t.bundleId === this.defaultPackageName;
        return false;
      };
      const appTarget = targets.find(t => t.pages.length > 0 && matchesPkg(t))
        ?? targets.find(t => t.pages.length > 0);

      if (!appTarget || appTarget.pages.length === 0) {
        lastError = 'No inspectable WebView pages found';
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      const page = appTarget.pages[0];
      await inspector.connectToPage(appTarget.appId, page.id);

      const handle = WebViewHandle._createFromInspector(
        this._client, inspector, appTarget.appId, page.id, this._defaultTimeoutMs,
      );
      this._applyTraceCtx(handle);

      this._activeWebView = handle;
      return handle;
    }

    inspector.close();
    throw new Error(
      `Timed out waiting for WebView (${this._defaultTimeoutMs}ms). ${lastError}. ` +
      'Ensure the WebView has webviewDebuggingEnabled={true} (sets isInspectable on iOS 16.4+).',
    );
  }

  private _applyTraceCtx(handle: WebViewHandle): void {
    if (this._traceCollector) {
      handle._traceCtx = {
        collector: this._traceCollector,
        takeScreenshot: () => this._takeScreenshotBuffer(),
        captureHierarchy: () => this._captureHierarchy(),
      };
    }
  }

  /** Switch back to native context, closing any active WebView handle. */
  async native(): Promise<void> {
    if (this._activeWebView) {
      await this._activeWebView.close();
      this._activeWebView = null;
    }
  }

  /** @internal — Dispose the WebView manager (called by the runner during cleanup). */
  async _disposeWebViewManager(): Promise<void> {
    if (this._activeWebView) {
      await this._activeWebView.close();
      this._activeWebView = null;
    }
  }

  /** Emit a trace event for a network management action (route/unroute). */
  private _emitNetworkAction(
    action: string,
    pattern: string | undefined,
    start: number,
    success: boolean,
    error?: string,
    sourceLocation?: import('./trace/types.js').SourceLocation,
  ): void {
    const collector = this._traceCollector;
    if (!collector) return;
    collector.addActionEvent({
      category: 'network',
      action,
      duration: Date.now() - start,
      success,
      error,
      selector: pattern,
      log: pattern ? [`${action}(${pattern})`] : [action],
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
      sourceLocation,
    });
  }

  close(): void {
    this._client.close();
  }
}

function formatPattern(url: string | RegExp | ((url: URL) => boolean)): string {
  if (typeof url === 'string') return url;
  if (url instanceof RegExp) return url.toString();
  return '<predicate>';
}
