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
  _label,
} from './selectors.js';
import * as grpc from '@grpc/grpc-js';
import {
  TapsmithGrpcClient,
  type ActionResponse,
  type ScreenshotResponse,
  type LaunchAppOptions,
  type AppState,
  type Orientation,
  type ColorScheme,
  type DeviceLogEntry,
} from './grpc-client.js';
import { ElementHandle, locatorOptionsToSelector, type LocatorOptions } from './element-handle.js';
import type { TapsmithConfig } from './config.js';
import { Tracing } from './trace/tracing.js';
import { type TraceCollector, getActiveTraceCollector, extractSourceLocation } from './trace/trace-collector.js';
import type { ActionCategory, ConsoleLevel } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';
import {
  NetworkRouteManager,
  type TapsmithRequest,
  type Route,
  type NetworkResponseEventData,
  matchUrlPattern,
} from './network.js';
import { WebViewHandle } from './webview-handle.js';
import type { Platform } from './config.js';

const WEBVIEW_RPC_TIMEOUT_MS = 5_000;
const WEBVIEW_RETRY_INTERVAL_MS = 500;
const WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;
const WEBVIEW_CONNECT_LOG_LIMIT = 80;

type WebViewInfo = Awaited<ReturnType<TapsmithGrpcClient['listWebViews']>>['webviews'][number];

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

async function sleepUpTo(ms: number, deadline: number): Promise<void> {
  const timeout = Math.min(ms, remainingMs(deadline));
  if (timeout <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, timeout));
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) {
    throw new Error(`${label} timed out`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendWebViewConnectLog(log: string[] | undefined, message: string): void {
  if (!log) return;
  if (log.length < WEBVIEW_CONNECT_LOG_LIMIT) {
    log.push(message);
  } else if (log.length === WEBVIEW_CONNECT_LOG_LIMIT) {
    log.push('Further WebView connection logs omitted');
  }
}

function webViewMatchesPackage(webview: WebViewInfo, packageName: string): boolean {
  return webview.packageName === packageName || webview.packageName.startsWith(`${packageName}:`);
}

function describeWebView(webview: WebViewInfo): string {
  const packageName = webview.packageName || 'unknown package';
  const pid = webview.pid ? `pid ${webview.pid}` : 'unknown pid';
  return `${webview.socketName} (${pid}, ${packageName})`;
}

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
  readonly _client: TapsmithGrpcClient;
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

  /** @internal — Cached WebView handle kept alive across native()/webview() switches. */
  private _cachedWebView: WebViewHandle | null = null;
  private _webviewGeneration = 0;

  /** @internal — Active device log stream. */
  private _logStream: grpc.ClientReadableStream<DeviceLogEntry> | null = null;
  private _logStreamCollector: TraceCollector | null = null;

  private _typingDelayMs: number;

  constructor(client: TapsmithGrpcClient, config?: Partial<Pick<TapsmithConfig, 'timeout' | 'package' | 'platform' | 'simulator' | 'typingDelay'>>) {
    this._client = client;
    this._defaultTimeoutMs = config?.timeout ?? 30_000;
    this._typingDelayMs = config?.typingDelay ?? 0;
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

  /** Locate an element by accessibility role, optionally filtering by name or state. */
  getByRole(role: string, options?: { name?: string; checked?: boolean; disabled?: boolean; selected?: boolean; expanded?: boolean }): ElementHandle {
    return this._handle(_role(role, options));
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
   * Locate an input element by its associated label text. Finds form controls
   * (text fields, checkboxes, switches, etc.) whose accessible name is derived
   * from a nearby label.
   *
   * - Android: follows `labelFor`/`labeledBy` relationships, or matches inputs
   *   whose `contentDescription` equals the label text.
   * - iOS: matches input elements whose `accessibilityLabel` equals the text.
   */
  getByLabel(text: string): ElementHandle {
    return this._handle(_label(text));
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
    return new ElementHandle(this._client, selector, this._defaultTimeoutMs, { traceCapture, typingDelay: this._typingDelayMs });
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
        'Package name is required. Pass one explicitly or set `package` in your Tapsmith config.',
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
    await this._disposeWebViewManager();
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
    if (res.success) {
      this._ensureRouteManager().ensureEventsSubscribed();
    }
    return {
      proxyPort: res.proxyPort,
      success: res.success,
      errorMessage: res.errorMessage,
    };
  }

  /** @internal — Stop network capture and return entries (used by the runner). */
  async _stopNetworkCapture(): Promise<ReturnType<TapsmithGrpcClient['stopNetworkCapture']>> {
    return this._client.stopNetworkCapture();
  }

  /** @internal — Start video recording on the device (used by the runner, PILOT-114). */
  async _startVideoRecording(options?: { size?: { width: number; height: number } }): Promise<{
    success: boolean
    errorMessage: string
  }> {
    const res = await this._client.startVideoRecording(options);
    return { success: res.success, errorMessage: res.errorMessage };
  }

  /** @internal — Stop video recording and return path to the MP4 (used by the runner, PILOT-114). */
  async _stopVideoRecording(): Promise<{
    success: boolean
    videoPath: string
    errorMessage: string
    durationMs: number
  }> {
    const res = await this._client.stopVideoRecording();
    return {
      success: res.success,
      videoPath: res.videoPath,
      errorMessage: res.errorMessage,
      durationMs: res.durationMs,
    };
  }

  // ─── Device Log Streaming (PILOT-193) ───

  /** @internal — Start streaming device logs into the active trace collector. */
  _startDeviceLogStream(collector: TraceCollector): void {
    if (!this.defaultPackageName) return;
    if (this._logStream) {
      if (this._logStreamCollector === collector) return;
      this._stopDeviceLogStream();
    }

    const stream = this._client.deviceLogStream(this.defaultPackageName);
    this._logStream = stream;
    this._logStreamCollector = collector;

    const clearStream = () => {
      if (this._logStream === stream) {
        this._logStream = null;
        this._logStreamCollector = null;
      }
    };

    stream.on('data', (entry: DeviceLogEntry) => {
      if (this._logStream !== stream) return;
      const level = mapDeviceLogLevel(entry.level);
      const message = entry.tag
        ? `[${entry.tag}] ${entry.message}`
        : entry.message;
      collector.addLogcatEntry(level, message);
    });

    stream.on('error', (err: Error) => {
      const code = (err as grpc.ServiceError).code;
      if (code !== grpc.status.CANCELLED) {
        console.warn('[tapsmith] Device log stream error:', err.message);
      }
      clearStream();
    });

    stream.on('end', () => {
      clearStream();
    });
  }

  /** @internal — Stop streaming device logs. */
  _stopDeviceLogStream(): void {
    const stream = this._logStream;
    this._logStream = null;
    this._logStreamCollector = null;
    stream?.cancel();
  }

  // ─── Network Route Interception ───

  /**
   * Intercept network requests matching a URL pattern. The handler receives a
   * `Route` object that can `abort()`, `continue()`, `fulfill()`, or `fetch()`
   * the request.
   *
   * Requires network tracing to be enabled (`trace` mode is not `'off'` and
   * `network` is `true`, which is the default). Without it, the MITM proxy
   * is not active and route handlers will never fire.
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

  /**
   * Wait for a request matching the pattern.
   *
   * Requires network tracing to be enabled (same prerequisite as `route()`).
   */
  waitForRequest(
    urlOrPredicate: string | RegExp | ((request: TapsmithRequest) => boolean),
    options?: { timeout?: number },
  ): Promise<TapsmithRequest> {
    const timeout = options?.timeout ?? this._defaultTimeoutMs;
    const manager = this._ensureRouteManager();

    return new Promise<TapsmithRequest>((resolve, reject) => {
      const timer = setTimeout(() => {
        manager.removeRequestListener(listener);
        reject(new Error(`waitForRequest timed out after ${timeout}ms`));
      }, timeout);

      const listener = (req: TapsmithRequest) => {
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

  /**
   * Wait for a response matching the pattern.
   *
   * Requires network tracing to be enabled (same prerequisite as `route()`).
   */
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
  on(event: 'request', handler: (request: TapsmithRequest) => void): void;
  on(event: 'response', handler: (response: NetworkResponseEventData) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation
  on(event: string, handler: (...args: any[]) => void): void {
    const manager = this._ensureRouteManager();
    if (event === 'request') {
      manager.addRequestListener(handler as (req: TapsmithRequest) => void);
    } else {
      manager.addResponseListener(handler as (resp: NetworkResponseEventData) => void);
    }
  }

  /** Unsubscribe from network events. */
  off(event: 'request', handler: (request: TapsmithRequest) => void): void;
  off(event: 'response', handler: (response: NetworkResponseEventData) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overload implementation
  off(event: string, handler: (...args: any[]) => void): void {
    if (!this._routeManager) return;
    if (event === 'request') {
      this._routeManager.removeRequestListener(handler as (req: TapsmithRequest) => void);
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
    return this._tracedWebViewConnect(packageName);
  }

  private async _tracedWebViewConnect(packageName?: string): Promise<WebViewHandle> {
    const collector = this._traceCollector;
    if (!collector) {
      return this._connectWebView(packageName);
    }

    const sourceLocation = extractSourceLocation(new Error().stack ?? '');
    const targetPackageName = packageName ?? this.defaultPackageName;
    const selector = targetPackageName ? `package=${targetPackageName}` : undefined;
    const { captures: beforeCaptures } = await collector.captureBeforeAction(
      () => this._takeScreenshotBuffer(),
      () => this._captureHierarchy(),
    );
    const connectLog = [`device.webview(${packageName ? JSON.stringify(packageName) : ''})`];
    if (!packageName && targetPackageName) {
      appendWebViewConnectLog(connectLog, `Using configured app package "${targetPackageName}" as the WebView target`);
    }

    collector._emitActionStarted({
      category: 'webview',
      action: 'connect',
      selector,
      sourceLocation,
      log: connectLog,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
    });

    const start = Date.now();
    let failedByTimeout = false;
    let timeoutError: string | undefined;
    collector.setPendingOperation((errorMessage: string) => {
      failedByTimeout = true;
      timeoutError = errorMessage;
      collector.addActionEvent({
        category: 'webview',
        action: 'connect',
        selector,
        duration: Date.now() - start,
        success: false,
        error: errorMessage,
        log: [`device.webview() timed out: ${errorMessage}`, ...connectLog.slice(1)],
        hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
        hasScreenshotAfter: false,
        hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
        hasHierarchyAfter: false,
        sourceLocation,
      });
    });

    let handle: WebViewHandle | undefined;
    try {
      handle = await this._connectWebView(packageName, connectLog);
    } catch (err) {
      collector.clearPendingOperation();
      if (!failedByTimeout) {
        const message = err instanceof Error ? err.message : String(err);
        collector.addActionEvent({
          category: 'webview',
          action: 'connect',
          selector,
          duration: Date.now() - start,
          success: false,
          error: message,
          log: [`device.webview() failed: ${message}`, ...connectLog.slice(1)],
          hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
          hasScreenshotAfter: false,
          hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
          hasHierarchyAfter: false,
          sourceLocation,
        });
      }
      throw err;
    }

    collector.clearPendingOperation();
    if (failedByTimeout) {
      throw new Error(timeoutError ?? 'device.webview() timed out');
    }

    collector.addActionEvent({
      category: 'webview',
      action: 'connect',
      selector,
      duration: Date.now() - start,
      success: true,
      log: ['device.webview() connected', ...connectLog.slice(1)],
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
      sourceLocation,
    });

    return handle;
  }

  private async _connectWebView(packageName?: string, log?: string[]): Promise<WebViewHandle> {
    if (this._cachedWebView?._isAlive()) {
      appendWebViewConnectLog(log, 'Reusing cached WebView connection');
      this._activeWebView = this._cachedWebView;
      this._applyTraceCtx(this._cachedWebView);
      return this._cachedWebView;
    }
    this._cachedWebView = null;
    const generation = this._webviewGeneration;

    if (this._platform === 'ios') {
      return this._webviewIos(packageName, generation, log);
    }
    return this._webviewAndroid(packageName, generation, log);
  }

  private async _webviewAndroid(packageName: string | undefined, generation: number, log?: string[]): Promise<WebViewHandle> {
    const deadline = Date.now() + this._defaultTimeoutMs;
    const targetPackageName = packageName ?? this.defaultPackageName;

    let lastError = '';
    while (remainingMs(deadline) > 0) {
      let list: Awaited<ReturnType<TapsmithGrpcClient['listWebViews']>>;
      try {
        list = await withDeadline(
          this._client.listWebViews(Math.min(WEBVIEW_RPC_TIMEOUT_MS, remainingMs(deadline))),
          deadline,
          'Listing WebViews',
        );
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        appendWebViewConnectLog(log, `List WebViews failed: ${lastError}`);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }
      if (list.errorMessage) {
        lastError = list.errorMessage;
        appendWebViewConnectLog(log, `List WebViews returned error: ${lastError}`);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }

      const discovered = list.webviews;
      appendWebViewConnectLog(
        log,
        discovered.length > 0
          ? `Discovered WebViews: ${discovered.map(describeWebView).join(', ')}`
          : 'Discovered no WebViews',
      );

      let candidates = discovered;
      if (targetPackageName) {
        candidates = discovered.filter(w => webViewMatchesPackage(w, targetPackageName));
      }

      if (candidates.length === 0) {
        lastError = targetPackageName
          ? `No WebViews found for package "${targetPackageName}"`
          : 'No WebViews found';
        appendWebViewConnectLog(log, lastError);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }

      for (const target of candidates) {
        appendWebViewConnectLog(log, `Trying ${describeWebView(target)}`);
        let fwd: Awaited<ReturnType<TapsmithGrpcClient['forwardWebViewPort']>>;
        try {
          fwd = await withDeadline(
            this._client.forwardWebViewPort(target.socketName, Math.min(WEBVIEW_RPC_TIMEOUT_MS, remainingMs(deadline))),
            deadline,
            'Forwarding WebView debug port',
          );
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          appendWebViewConnectLog(log, `Forwarding ${target.socketName} failed: ${lastError}`);
          continue;
        }
        if (!fwd.success) {
          lastError = `Failed to forward WebView port: ${fwd.errorMessage}`;
          appendWebViewConnectLog(log, `${lastError} (${target.socketName})`);
          continue;
        }

        const attemptDeadline = Date.now() + Math.min(WEBVIEW_CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs(deadline));
        const handle = new WebViewHandle(this._client, fwd.localPort, Math.max(1, remainingMs(attemptDeadline)));
        this._applyTraceCtx(handle);
        try {
          await withDeadline(handle._connect(), attemptDeadline, 'Connecting to WebView CDP endpoint');
          if (generation !== this._webviewGeneration) {
            await handle.close();
            throw new Error('WebView connection was disposed before it completed');
          }

          appendWebViewConnectLog(log, `Connected to ${describeWebView(target)} on local port ${fwd.localPort}`);
          this._activeWebView = handle;
          this._cachedWebView = handle;
          return handle;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          appendWebViewConnectLog(log, `Connecting to ${target.socketName} failed: ${lastError}`);
          await handle.close();
          continue;
        }
      }

      await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
    }

    throw new Error(
      `Timed out waiting for WebView (${this._defaultTimeoutMs}ms). ${lastError}. ` +
      'Ensure the app has a visible WebView with debugging enabled ' +
      '(WebView.setWebContentsDebuggingEnabled(true)).',
    );
  }

  private async _webviewIos(_packageName: string | undefined, generation: number, log?: string[]): Promise<WebViewHandle> {
    const { WebKitInspectorClient, findSimulatorInspectorSocket } = await import('./webkit-inspector.js');

    // Find the simulator's webinspectord socket
    // The UDID may be the resolved simulator UDID stored by the dispatcher
    const udid = this._simulatorUdid ?? '';
    const socketPath = findSimulatorInspectorSocket(udid);
    if (!socketPath) {
      appendWebViewConnectLog(log, `No WebKit Inspector socket found for simulator "${udid}"`);
      throw new Error(
        `Could not find WebKit Inspector socket for simulator "${udid}". ` +
        'Ensure the iOS simulator is booted.',
      );
    }
    appendWebViewConnectLog(log, `Using WebKit Inspector socket ${socketPath}`);

    const inspector = new WebKitInspectorClient();
    await inspector.connect(socketPath);

    const deadline = Date.now() + this._defaultTimeoutMs;
    let lastError = '';

    while (remainingMs(deadline) > 0) {
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
        appendWebViewConnectLog(log, lastError);
        await sleepUpTo(WEBVIEW_RETRY_INTERVAL_MS, deadline);
        continue;
      }

      const page = appTarget.pages[0];
      appendWebViewConnectLog(log, `Connecting to iOS WebView page "${page.title || page.url || page.id}"`);
      await inspector.connectToPage(appTarget.appId, page.id);

      const handle = WebViewHandle._createFromInspector(
        this._client, inspector, appTarget.appId, page.id, this._defaultTimeoutMs,
      );
      this._applyTraceCtx(handle);
      if (generation !== this._webviewGeneration) {
        await handle.close();
        throw new Error('WebView connection was disposed before it completed');
      }

      this._activeWebView = handle;
      this._cachedWebView = handle;
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

  /** Switch back to native context. The WebView connection stays alive for reuse. */
  async native(): Promise<void> {
    this._activeWebView = null;
  }

  /** @internal — Dispose the WebView manager (called by the runner during cleanup). */
  async _disposeWebViewManager(): Promise<void> {
    this._webviewGeneration++;
    this._activeWebView = null;
    if (this._cachedWebView) {
      await this._cachedWebView.close();
      this._cachedWebView = null;
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

function mapDeviceLogLevel(level: string): ConsoleLevel {
  switch (level) {
    case 'debug': return 'debug';
    case 'info': return 'info';
    case 'warn': return 'warn';
    case 'error': return 'error';
    default: return 'log';
  }
}

function formatPattern(url: string | RegExp | ((url: URL) => boolean)): string {
  if (typeof url === 'string') return url;
  if (url instanceof RegExp) return url.toString();
  return '<predicate>';
}
