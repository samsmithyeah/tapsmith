/**
 * Device — the primary user-facing API for interacting with a mobile device.
 *
 * All methods accept a Selector and delegate to the Rust daemon via gRPC.
 * Auto-waiting is handled daemon-side; the SDK just passes the configured
 * timeout.
 */

import type { Selector } from './selectors.js';
import { PilotGrpcClient, type ActionResponse, type SwipeOptions, type ScrollOptions, type ScreenshotResponse } from './grpc-client.js';
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

  constructor(client: PilotGrpcClient, config?: Pick<PilotConfig, 'timeout'>) {
    this._client = client;
    this.defaultTimeoutMs = config?.timeout ?? 30_000;
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

  async startAgent(targetPackage: string): Promise<void> {
    const res = await this._client.startAgent(targetPackage);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Start agent failed');
    }
  }

  close(): void {
    this._client.close();
  }
}
