/**
 * Device — the primary user-facing API for interacting with a mobile device.
 *
 * All methods accept a Selector and delegate to the Rust daemon via gRPC.
 * Auto-waiting is handled daemon-side; the SDK just passes the configured
 * timeout.
 */

import type { Selector } from './selectors.js';
import { PilotGrpcClient, type SwipeOptions, type ScrollOptions, type ScreenshotResponse } from './grpc-client.js';
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
    const res = await this._client.tap(selector, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Tap failed');
    }
  }

  async longPress(selector: Selector, durationMs?: number): Promise<void> {
    const res = await this._client.longPress(selector, durationMs, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Long press failed');
    }
  }

  async type(selector: Selector, text: string): Promise<void> {
    const res = await this._client.typeText(selector, text, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Type text failed');
    }
  }

  async clearAndType(selector: Selector, text: string): Promise<void> {
    const res = await this._client.clearAndType(selector, text, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Clear and type failed');
    }
  }

  async swipe(direction: string, options?: SwipeOptions): Promise<void> {
    const res = await this._client.swipe(direction, {
      ...options,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
    });
    if (!res.success) {
      throw new Error(res.errorMessage || 'Swipe failed');
    }
  }

  async scroll(selector: Selector, direction: string, options?: ScrollOptions): Promise<void> {
    const res = await this._client.scroll(selector, direction, {
      ...options,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
    });
    if (!res.success) {
      throw new Error(res.errorMessage || 'Scroll failed');
    }
  }

  async pressKey(key: string): Promise<void> {
    const res = await this._client.pressKey(key);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Press key failed');
    }
  }

  async pressBack(): Promise<void> {
    return this.pressKey('BACK');
  }

  async doubleTap(selector: Selector): Promise<void> {
    const res = await this._client.doubleTap(selector, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Double tap failed');
    }
  }

  async drag(options: DragOptions): Promise<void> {
    const res = await this._client.dragAndDrop(options.from, options.to, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Drag and drop failed');
    }
  }

  async pinchIn(selector: Selector, options?: PinchOptions): Promise<void> {
    const scale = options?.scale ?? 0.5;
    const res = await this._client.pinchZoom(selector, scale, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Pinch in failed');
    }
  }

  async pinchOut(selector: Selector, options?: PinchOptions): Promise<void> {
    const scale = options?.scale ?? 2.0;
    const res = await this._client.pinchZoom(selector, scale, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Pinch out failed');
    }
  }

  async focus(selector: Selector): Promise<void> {
    const res = await this._client.focus(selector, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Focus failed');
    }
  }

  async blur(selector: Selector): Promise<void> {
    const res = await this._client.blur(selector, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Blur failed');
    }
  }

  async selectOption(selector: Selector, option: string | { index: number }): Promise<void> {
    const res = await this._client.selectOption(selector, option, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Select option failed');
    }
  }

  async highlight(selector: Selector, options?: { durationMs?: number }): Promise<void> {
    const res = await this._client.highlight(selector, options?.durationMs, this.defaultTimeoutMs);
    if (!res.success) {
      throw new Error(res.errorMessage || 'Highlight failed');
    }
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
