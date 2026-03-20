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
  private readonly defaultTimeoutMs: number;
  private readonly defaultPackageName?: string;

  constructor(client: PilotGrpcClient, config?: Partial<Pick<PilotConfig, 'timeout' | 'package'>>) {
    this._client = client;
    this.defaultTimeoutMs = config?.timeout ?? 30_000;
    this.defaultPackageName = config?.package;
  }

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

  // ── Element handle ──

  /**
   * Returns an ElementHandle for the given selector. The element is not
   * resolved immediately — it is looked up lazily when an action or assertion
   * is performed.
   */
  element(selector: Selector): ElementHandle {
    return new ElementHandle(this._client, selector, this.defaultTimeoutMs);
  }

  // ── Actions ──

  async tap(selector: Selector): Promise<void> {
    return this._action(() => this._client.tap(selector, this.defaultTimeoutMs), 'Tap failed');
  }

  async longPress(selector: Selector, durationMs?: number): Promise<void> {
    return this._action(() => this._client.longPress(selector, durationMs, this.defaultTimeoutMs), 'Long press failed');
  }

  async type(selector: Selector, text: string): Promise<void> {
    return this._action(() => this._client.typeText(selector, text, this.defaultTimeoutMs), 'Type text failed');
  }

  async clearAndType(selector: Selector, text: string): Promise<void> {
    return this._action(() => this._client.clearAndType(selector, text, this.defaultTimeoutMs), 'Clear and type failed');
  }

  async swipe(direction: string, options?: SwipeOptions): Promise<void> {
    return this._action(
      () => this._client.swipe(direction, { ...options, timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs }),
      'Swipe failed',
    );
  }

  async scroll(selector: Selector, direction: string, options?: ScrollOptions): Promise<void> {
    return this._action(
      () => this._client.scroll(selector, direction, { ...options, timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs }),
      'Scroll failed',
    );
  }

  async pressKey(key: string): Promise<void> {
    return this._action(() => this._client.pressKey(key), 'Press key failed');
  }

  async pressBack(): Promise<void> {
    return this.pressKey('BACK');
  }

  async doubleTap(selector: Selector): Promise<void> {
    return this._action(() => this._client.doubleTap(selector, this.defaultTimeoutMs), 'Double tap failed');
  }

  async drag(options: DragOptions): Promise<void> {
    return this._action(() => this._client.dragAndDrop(options.from, options.to, this.defaultTimeoutMs), 'Drag and drop failed');
  }

  async pinchIn(selector: Selector, options?: PinchOptions): Promise<void> {
    const scale = options?.scale ?? 0.5;
    return this._action(() => this._client.pinchZoom(selector, scale, this.defaultTimeoutMs), 'Pinch in failed');
  }

  async pinchOut(selector: Selector, options?: PinchOptions): Promise<void> {
    const scale = options?.scale ?? 2.0;
    return this._action(() => this._client.pinchZoom(selector, scale, this.defaultTimeoutMs), 'Pinch out failed');
  }

  async focus(selector: Selector): Promise<void> {
    return this._action(() => this._client.focus(selector, this.defaultTimeoutMs), 'Focus failed');
  }

  async blur(selector: Selector): Promise<void> {
    return this._action(() => this._client.blur(selector, this.defaultTimeoutMs), 'Blur failed');
  }

  async selectOption(selector: Selector, option: string | { index: number }): Promise<void> {
    return this._action(() => this._client.selectOption(selector, option, this.defaultTimeoutMs), 'Select option failed');
  }

  async highlight(selector: Selector, options?: { durationMs?: number }): Promise<void> {
    return this._action(() => this._client.highlight(selector, options?.durationMs, this.defaultTimeoutMs), 'Highlight failed');
  }

  // ── Utilities ──

  async takeScreenshot(): Promise<ScreenshotResponse> {
    return this._client.takeScreenshot();
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const res = await this._client.waitForIdle(timeoutMs ?? this.defaultTimeoutMs);
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
  ): Promise<void> {
    const res = await this._client.startAgent(targetPackage, agentApkPath, agentTestApkPath);
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
    return this._action(
      () => this._client.restartApp(this.requirePackageName(packageName), options?.waitForIdle ?? true),
      'Restart app failed',
    );
  }

  async launchApp(packageName: string, options?: LaunchAppOptions): Promise<void> {
    return this._action(
      () => this._client.launchApp(packageName, options),
      'Launch app failed',
    );
  }

  async openDeepLink(uri: string): Promise<void> {
    return this._action(
      () => this._client.openDeepLink(uri),
      'Open deep link failed',
    );
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
    return this._action(
      () => this._client.terminateApp(packageName),
      'Terminate app failed',
    );
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

  async clearAppData(packageName: string): Promise<void> {
    return this._action(
      () => this._client.clearAppData(packageName),
      'Clear app data failed',
    );
  }

  async grantPermission(packageName: string, permission: string): Promise<void> {
    return this._action(
      () => this._client.grantPermission(packageName, permission),
      'Grant permission failed',
    );
  }

  async revokePermission(packageName: string, permission: string): Promise<void> {
    return this._action(
      () => this._client.revokePermission(packageName, permission),
      'Revoke permission failed',
    );
  }

  async setClipboard(text: string): Promise<void> {
    return this._action(
      () => this._client.setClipboard(text),
      'Set clipboard failed',
    );
  }

  async getClipboard(): Promise<string> {
    const res = await this._client.getClipboard();
    return res.text;
  }

  async setOrientation(orientation: Orientation): Promise<void> {
    return this._action(
      () => this._client.setOrientation(orientation),
      'Set orientation failed',
    );
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
    return this._action(
      () => this._client.hideKeyboard(),
      'Hide keyboard failed',
    );
  }

  async wake(): Promise<void> {
    return this._action(
      () => this._client.wakeDevice(),
      'Wake device failed',
    );
  }

  async unlock(): Promise<void> {
    return this._action(
      () => this._client.unlockDevice(),
      'Unlock device failed',
    );
  }

  async pressHome(): Promise<void> {
    return this.pressKey('HOME');
  }

  async openNotifications(): Promise<void> {
    return this._action(
      () => this._client.openNotifications(),
      'Open notifications failed',
    );
  }

  async openQuickSettings(): Promise<void> {
    return this._action(
      () => this._client.openQuickSettings(),
      'Open quick settings failed',
    );
  }

  async pressRecentApps(): Promise<void> {
    return this.pressKey('APP_SWITCH');
  }

  async setColorScheme(scheme: ColorScheme): Promise<void> {
    return this._action(
      () => this._client.setColorScheme(scheme),
      'Set color scheme failed',
    );
  }

  async getColorScheme(): Promise<ColorScheme> {
    const res = await this._client.getColorScheme();
    return res.scheme as ColorScheme;
  }

  close(): void {
    this._client.close();
  }
}
