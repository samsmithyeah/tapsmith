/**
 * Device — the primary user-facing API for interacting with a mobile device.
 *
 * All methods accept a Selector and delegate to the Rust daemon via gRPC.
 * Auto-waiting is handled daemon-side; the SDK just passes the configured
 * timeout.
 */

import type { Selector } from './selectors.js';
import {
  PilotGrpcClient,
  type ActionResponse,
  type SwipeOptions,
  type ScrollOptions,
  type ScreenshotResponse,
  type LaunchAppOptions,
  type AppState,
  type Orientation,
  type ColorScheme,
} from './grpc-client.js';
import { ElementHandle } from './element-handle.js';
import type { PilotConfig } from './config.js';
import { Tracing } from './trace/tracing.js';
import { type TraceCollector, getActiveTraceCollector } from './trace/trace-collector.js';
import type { ActionCategory } from './trace/types.js';
import { tracedAction } from './trace/traced-action.js';

// ─── Types for element actions (PILOT-2) ───

export interface DragOptions {
  from: Selector;
  to: Selector;
}

export interface PinchOptions {
  scale?: number;
}

export class Device {
  /** @internal */
  readonly _client: PilotGrpcClient;
  private _defaultTimeoutMs: number;
  private readonly defaultPackageName?: string;

  /** Programmatic tracing API. */
  readonly tracing: Tracing;

  constructor(client: PilotGrpcClient, config?: Partial<Pick<PilotConfig, 'timeout' | 'package'>>) {
    this._client = client;
    this._defaultTimeoutMs = config?.timeout ?? 30_000;
    this.defaultPackageName = config?.package;
    this.tracing = new Tracing(
      () => this._takeScreenshotBuffer(),
      () => this._captureHierarchy(),
    );
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

  /** @internal — Capture the view hierarchy XML. */
  private async _captureHierarchy(): Promise<string | undefined> {
    try {
      const res = await this._client.getUiHierarchy();
      return res.hierarchyXml || undefined;
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

  // ── Element handle ──

  /**
   * Returns an ElementHandle for the given selector. The element is not
   * resolved immediately — it is looked up lazily when an action or assertion
   * is performed.
   */
  element(selector: Selector): ElementHandle {
    const traceCapture = this._traceCollector ? {
      collector: this._traceCollector,
      takeScreenshot: () => this._takeScreenshotBuffer(),
      captureHierarchy: () => this._captureHierarchy(),
    } : undefined;
    return new ElementHandle(this._client, selector, this._defaultTimeoutMs, { traceCapture });
  }

  // ── Actions ──

  async tap(selector: Selector): Promise<void> {
    return this._tracedAction('tap', 'tap', selector,
      () => this._client.tap(selector, this._defaultTimeoutMs), 'Tap failed');
  }

  async longPress(selector: Selector, durationMs?: number): Promise<void> {
    return this._tracedAction('longPress', 'tap', selector,
      () => this._client.longPress(selector, durationMs, this._defaultTimeoutMs), 'Long press failed');
  }

  async type(selector: Selector, text: string): Promise<void> {
    return this._tracedAction('type', 'type', selector,
      () => this._client.typeText(selector, text, this._defaultTimeoutMs), 'Type text failed',
      { inputValue: text });
  }

  async clearAndType(selector: Selector, text: string): Promise<void> {
    return this._tracedAction('clearAndType', 'type', selector,
      () => this._client.clearAndType(selector, text, this._defaultTimeoutMs), 'Clear and type failed',
      { inputValue: text });
  }

  async swipe(direction: string, options?: SwipeOptions): Promise<void> {
    return this._tracedAction('swipe', 'swipe', options?.selector,
      () => this._client.swipe(direction, { ...options, timeoutMs: options?.timeoutMs ?? this._defaultTimeoutMs }),
      'Swipe failed');
  }

  async scroll(selector: Selector, direction: string, options?: ScrollOptions): Promise<void> {
    return this._tracedAction('scroll', 'scroll', selector,
      () => this._client.scroll(selector, direction, { ...options, timeoutMs: options?.timeoutMs ?? this._defaultTimeoutMs }),
      'Scroll failed');
  }

  async pressKey(key: string): Promise<void> {
    return this._tracedAction('pressKey', 'press-key', undefined,
      () => this._client.pressKey(key), 'Press key failed');
  }

  async pressBack(): Promise<void> {
    return this.pressKey('BACK');
  }

  async doubleTap(selector: Selector): Promise<void> {
    return this._tracedAction('doubleTap', 'tap', selector,
      () => this._client.doubleTap(selector, this._defaultTimeoutMs), 'Double tap failed');
  }

  async drag(options: DragOptions): Promise<void> {
    return this._tracedAction('drag', 'tap', options.from,
      () => this._client.dragAndDrop(options.from, options.to, this._defaultTimeoutMs), 'Drag and drop failed');
  }

  async pinchIn(selector: Selector, options?: PinchOptions): Promise<void> {
    const scale = options?.scale ?? 0.5;
    return this._tracedAction('pinchIn', 'tap', selector,
      () => this._client.pinchZoom(selector, scale, this._defaultTimeoutMs), 'Pinch in failed');
  }

  async pinchOut(selector: Selector, options?: PinchOptions): Promise<void> {
    const scale = options?.scale ?? 2.0;
    return this._tracedAction('pinchOut', 'tap', selector,
      () => this._client.pinchZoom(selector, scale, this._defaultTimeoutMs), 'Pinch out failed');
  }

  async focus(selector: Selector): Promise<void> {
    return this._tracedAction('focus', 'tap', selector,
      () => this._client.focus(selector, this._defaultTimeoutMs), 'Focus failed');
  }

  async blur(selector: Selector): Promise<void> {
    return this._tracedAction('blur', 'tap', selector,
      () => this._client.blur(selector, this._defaultTimeoutMs), 'Blur failed');
  }

  async selectOption(selector: Selector, option: string | { index: number }): Promise<void> {
    return this._tracedAction('selectOption', 'tap', selector,
      () => this._client.selectOption(selector, option, this._defaultTimeoutMs), 'Select option failed');
  }

  async highlight(selector: Selector, options?: { durationMs?: number }): Promise<void> {
    return this._tracedAction('highlight', 'other', selector,
      () => this._client.highlight(selector, options?.durationMs, this._defaultTimeoutMs), 'Highlight failed');
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

  async setDevice(serial: string): Promise<void> {
    const res = await this._client.setDevice(serial);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Set device failed');
    }
  }

  async startAgent(
    targetPackage: string,
    agentApkPath?: string,
    agentTestApkPath?: string,
    iosXctestrunPath?: string,
  ): Promise<void> {
    const res = await this._client.startAgent(targetPackage, agentApkPath, agentTestApkPath, iosXctestrunPath);
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

  async clearAppData(packageName: string): Promise<void> {
    return this._tracedAction('clearAppData', 'device', undefined,
      () => this._client.clearAppData(packageName),
      'Clear app data failed');
  }

  async grantPermission(packageName: string, permission: string): Promise<void> {
    return this._tracedAction('grantPermission', 'device', undefined,
      () => this._client.grantPermission(packageName, permission),
      'Grant permission failed');
  }

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

  async pressHome(): Promise<void> {
    return this.pressKey('HOME');
  }

  async openNotifications(): Promise<void> {
    return this._tracedAction('openNotifications', 'device', undefined,
      () => this._client.openNotifications(),
      'Open notifications failed');
  }

  async openQuickSettings(): Promise<void> {
    return this._tracedAction('openQuickSettings', 'device', undefined,
      () => this._client.openQuickSettings(),
      'Open quick settings failed');
  }

  async pressRecentApps(): Promise<void> {
    return this.pressKey('APP_SWITCH');
  }

  async setColorScheme(scheme: ColorScheme): Promise<void> {
    return this._tracedAction('setColorScheme', 'device', undefined,
      () => this._client.setColorScheme(scheme),
      'Set color scheme failed');
  }

  async getColorScheme(): Promise<ColorScheme> {
    const res = await this._client.getColorScheme();
    return res.scheme as ColorScheme;
  }

  /** @internal — Start network capture (used by the runner). */
  async _startNetworkCapture(): Promise<void> {
    await this._client.startNetworkCapture();
  }

  /** @internal — Stop network capture and return entries (used by the runner). */
  async _stopNetworkCapture(): Promise<ReturnType<PilotGrpcClient['stopNetworkCapture']>> {
    return this._client.stopNetworkCapture();
  }

  close(): void {
    this._client.close();
  }
}
