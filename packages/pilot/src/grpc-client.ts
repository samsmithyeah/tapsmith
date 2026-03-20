/**
 * gRPC client that connects to the Pilot Rust daemon.
 *
 * Wraps all PilotService RPCs as typed async methods. The proto file is loaded
 * dynamically via @grpc/proto-loader so no code-gen step is required.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { type Selector, selectorToProto } from './selectors.js';

// ─── Types mirroring proto messages ───

export interface ElementInfo {
  elementId: string;
  className: string;
  text: string;
  contentDescription: string;
  resourceId: string;
  enabled: boolean;
  visible: boolean;
  clickable: boolean;
  focusable: boolean;
  scrollable: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number };
  hint: string;
  checked: boolean;
  selected: boolean;
  focused: boolean;
  role: string;
  viewportRatio: number;
}

export interface ActionResponse {
  requestId: string;
  success: boolean;
  errorType: string;
  errorMessage: string;
  screenshot: Buffer;
}

export interface FindElementResponse {
  requestId: string;
  found: boolean;
  element?: ElementInfo;
  errorMessage: string;
}

export interface FindElementsResponse {
  requestId: string;
  elements: ElementInfo[];
  errorMessage: string;
}

export interface ScreenshotResponse {
  requestId: string;
  success: boolean;
  data: Buffer;
  errorMessage: string;
}

export interface UiHierarchyResponse {
  requestId: string;
  hierarchyXml: string;
  errorMessage: string;
}

export interface DeviceInfoProto {
  serial: string;
  model: string;
  state: string;
  isEmulator: boolean;
}

export interface ListDevicesResponse {
  requestId: string;
  devices: DeviceInfoProto[];
}

export interface PingResponse {
  version: string;
  agentConnected: boolean;
}

// ─── Device Management (PILOT-10) ───

export interface GetCurrentPackageResponse {
  requestId: string;
  packageName: string;
}

export interface GetCurrentActivityResponse {
  requestId: string;
  activity: string;
}

export interface GetAppStateResponse {
  requestId: string;
  state: string;
}

export interface GetClipboardResponse {
  requestId: string;
  text: string;
}

export interface GetOrientationResponse {
  requestId: string;
  orientation: string;
}

export interface IsKeyboardShownResponse {
  requestId: string;
  shown: boolean;
}

export interface GetColorSchemeResponse {
  requestId: string;
  scheme: string;
}

// ─── Trace Support (PILOT-85) ───

export interface GetLogcatResponse {
  requestId: string;
  logcat: string;
  errorMessage: string;
}

export type AppState = 'not_installed' | 'stopped' | 'background' | 'foreground';
export type Orientation = 'portrait' | 'landscape';
export type ColorScheme = 'dark' | 'light';

export interface LaunchAppOptions {
  activity?: string;
  clearData?: boolean;
  waitForIdle?: boolean;
}

// ─── Swipe / scroll options exposed to the SDK ───

export interface SwipeOptions {
  selector?: Selector;
  speed?: number;
  distance?: number;
  timeoutMs?: number;
}

export interface ScrollOptions {
  scrollUntilVisible?: Selector;
  distance?: number;
  timeoutMs?: number;
}

// ─── Client ───

const PROTO_PATH = path.resolve(__dirname, '../../../proto/pilot.proto');
const DEFAULT_ADDRESS = 'localhost:50051';

function requestId(): string {
  return crypto.randomUUID();
}

export class PilotGrpcClient {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private client: grpc.Client & Record<string, Function>;
  private address: string;

  constructor(address: string = DEFAULT_ADDRESS) {
    this.address = address;
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proto-loader returns untyped package definitions
    const PilotService = (proto.pilot as any).PilotService as grpc.ServiceClientConstructor;
    this.client = new PilotService(
      this.address,
      grpc.credentials.createInsecure(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    ) as grpc.Client & Record<string, Function>;
  }

  // ── Helpers ──

  private call<T>(method: string, request: Record<string, unknown>, deadlineMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const deadline = new Date(Date.now() + (deadlineMs ?? 60_000));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic RPC dispatch on proto-loaded client
      (this.client as any)[method](request, { deadline }, (err: grpc.ServiceError | null, response: T) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });
  }

  private selectorProto(selector: Selector): Record<string, unknown> {
    return selectorToProto(selector);
  }

  // ── RPCs ──

  async findElement(selector: Selector, timeoutMs?: number): Promise<FindElementResponse> {
    return this.call<FindElementResponse>('findElement', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async findElements(selector: Selector, timeoutMs?: number): Promise<FindElementsResponse> {
    return this.call<FindElementsResponse>('findElements', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async tap(selector: Selector, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('tap', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async longPress(selector: Selector, durationMs?: number, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('longPress', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      durationMs: durationMs ?? 0,
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async typeText(selector: Selector, text: string, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('typeText', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      text,
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async clearText(selector: Selector, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('clearText', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async clearAndType(selector: Selector, text: string, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('clearAndType', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      text,
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async swipe(direction: string, options?: SwipeOptions): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      direction,
      speed: options?.speed ?? 2000,
      distance: options?.distance ?? 0.6,
    };
    if (options?.selector) request.startElement = this.selectorProto(options.selector);
    if (options?.timeoutMs != null) request.timeoutMs = options.timeoutMs;
    return this.call<ActionResponse>('swipe', request);
  }

  async scroll(
    container: Selector,
    direction: string,
    options?: ScrollOptions,
  ): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      container: this.selectorProto(container),
      direction,
    };
    if (options?.scrollUntilVisible) {
      request.scrollUntilVisible = this.selectorProto(options.scrollUntilVisible);
    }
    if (options?.distance != null) request.distance = options.distance;
    if (options?.timeoutMs != null) request.timeoutMs = options.timeoutMs;
    return this.call<ActionResponse>('scroll', request);
  }

  async pressKey(key: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('pressKey', {
      requestId: requestId(),
      key,
    });
  }

  async takeScreenshot(): Promise<ScreenshotResponse> {
    return this.call<ScreenshotResponse>('takeScreenshot', {
      requestId: requestId(),
    });
  }

  async getUiHierarchy(): Promise<UiHierarchyResponse> {
    return this.call<UiHierarchyResponse>('getUiHierarchy', {
      requestId: requestId(),
    });
  }

  async waitForIdle(timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('waitForIdle', {
      requestId: requestId(),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async installApk(apkPath: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('installApk', {
      requestId: requestId(),
      apkPath,
    }, 120_000);
  }

  async listDevices(): Promise<ListDevicesResponse> {
    return this.call<ListDevicesResponse>('listDevices', {
      requestId: requestId(),
    });
  }

  async setDevice(serial: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('setDevice', {
      requestId: requestId(),
      serial,
    }, 120_000);
  }

  async startAgent(
    targetPackage: string,
    agentApkPath?: string,
    agentTestApkPath?: string,
  ): Promise<ActionResponse> {
    return this.call<ActionResponse>('startAgent', {
      requestId: requestId(),
      targetPackage,
      agentApkPath: agentApkPath ?? '',
      agentTestApkPath: agentTestApkPath ?? '',
    }, 120_000);
  }

  async ping(): Promise<PingResponse> {
    return this.call<PingResponse>('ping', {});
  }

  // ── Element Actions (PILOT-2) ──

  async doubleTap(selector: Selector, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('doubleTap', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async dragAndDrop(source: Selector, target: Selector, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('dragAndDrop', {
      requestId: requestId(),
      sourceSelector: this.selectorProto(source),
      targetSelector: this.selectorProto(target),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async selectOption(
    selector: Selector,
    option: string | { index: number },
    timeoutMs?: number,
  ): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    };
    if (typeof option === 'string') {
      request.option = option;
    } else {
      request.index = option.index;
    }
    return this.call<ActionResponse>('selectOption', request);
  }

  async pinchZoom(selector: Selector, scale: number, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('pinchZoom', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      scale,
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async focus(selector: Selector, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('focus', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async blur(selector: Selector, timeoutMs?: number): Promise<ActionResponse> {
    return this.call<ActionResponse>('blur', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  async highlight(selector: Selector, durationMs?: number, timeoutMs?: number): Promise<ActionResponse> {
    const request: Record<string, unknown> = {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    };
    if (durationMs != null) request.durationMs = durationMs;
    return this.call<ActionResponse>('highlight', request);
  }

  async takeElementScreenshot(selector: Selector, timeoutMs?: number): Promise<ScreenshotResponse> {
    return this.call<ScreenshotResponse>('takeElementScreenshot', {
      requestId: requestId(),
      selector: this.selectorProto(selector),
      timeoutMs: timeoutMs ?? 0,
    });
  }

  // ── Device Management (PILOT-10) ──

  async restartApp(packageName: string, waitForIdle = true): Promise<ActionResponse> {
    return this.call<ActionResponse>('restartApp', {
      requestId: requestId(),
      packageName,
      waitForIdle,
    }, 120_000);
  }

  async launchApp(packageName: string, options?: LaunchAppOptions): Promise<ActionResponse> {
    return this.call<ActionResponse>('launchApp', {
      requestId: requestId(),
      packageName,
      activity: options?.activity ?? '',
      clearData: options?.clearData ?? false,
      waitForIdle: options?.waitForIdle ?? true,
    }, 120_000);
  }

  async openDeepLink(uri: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('openDeepLink', {
      requestId: requestId(),
      uri,
    });
  }

  async getCurrentPackage(): Promise<GetCurrentPackageResponse> {
    return this.call<GetCurrentPackageResponse>('getCurrentPackage', {
      requestId: requestId(),
    });
  }

  async getCurrentActivity(): Promise<GetCurrentActivityResponse> {
    return this.call<GetCurrentActivityResponse>('getCurrentActivity', {
      requestId: requestId(),
    });
  }

  async terminateApp(packageName: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('terminateApp', {
      requestId: requestId(),
      packageName,
    });
  }

  async getAppState(packageName: string): Promise<GetAppStateResponse> {
    return this.call<GetAppStateResponse>('getAppState', {
      requestId: requestId(),
      packageName,
    });
  }

  async clearAppData(packageName: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('clearAppData', {
      requestId: requestId(),
      packageName,
    });
  }

  async grantPermission(packageName: string, permission: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('grantPermission', {
      requestId: requestId(),
      packageName,
      permission,
    });
  }

  async revokePermission(packageName: string, permission: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('revokePermission', {
      requestId: requestId(),
      packageName,
      permission,
    });
  }

  async setClipboard(text: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('setClipboard', {
      requestId: requestId(),
      text,
    });
  }

  async getClipboard(): Promise<GetClipboardResponse> {
    return this.call<GetClipboardResponse>('getClipboard', {
      requestId: requestId(),
    });
  }

  async setOrientation(orientation: Orientation): Promise<ActionResponse> {
    return this.call<ActionResponse>('setOrientation', {
      requestId: requestId(),
      orientation,
    });
  }

  async getOrientation(): Promise<GetOrientationResponse> {
    return this.call<GetOrientationResponse>('getOrientation', {
      requestId: requestId(),
    });
  }

  async isKeyboardShown(): Promise<IsKeyboardShownResponse> {
    return this.call<IsKeyboardShownResponse>('isKeyboardShown', {
      requestId: requestId(),
    });
  }

  async hideKeyboard(): Promise<ActionResponse> {
    return this.call<ActionResponse>('hideKeyboard', {
      requestId: requestId(),
    });
  }

  async openNotifications(): Promise<ActionResponse> {
    return this.call<ActionResponse>('openNotifications', {
      requestId: requestId(),
    });
  }

  async openQuickSettings(): Promise<ActionResponse> {
    return this.call<ActionResponse>('openQuickSettings', {
      requestId: requestId(),
    });
  }

  async setColorScheme(scheme: ColorScheme): Promise<ActionResponse> {
    return this.call<ActionResponse>('setColorScheme', {
      requestId: requestId(),
      scheme,
    });
  }

  async getColorScheme(): Promise<GetColorSchemeResponse> {
    return this.call<GetColorSchemeResponse>('getColorScheme', {
      requestId: requestId(),
    });
  }

  async wakeDevice(): Promise<ActionResponse> {
    return this.call<ActionResponse>('wakeDevice', {
      requestId: requestId(),
    });
  }

  async unlockDevice(): Promise<ActionResponse> {
    return this.call<ActionResponse>('unlockDevice', {
      requestId: requestId(),
    });
  }

  // ── Trace Support (PILOT-85) ──

  async getLogcat(packageName: string, sinceMs?: number, untilMs?: number): Promise<GetLogcatResponse> {
    return this.call<GetLogcatResponse>('getLogcat', {
      requestId: requestId(),
      packageName,
      sinceMs: sinceMs ?? 0,
      untilMs: untilMs ?? 0,
    });
  }

  // ── Lifecycle ──

  close(): void {
    this.client.close();
  }

  /**
   * Wait until the daemon is reachable (up to `timeoutMs`).
   * Resolves `true` if connected, `false` on timeout.
   */
  async waitForReady(timeoutMs: number = 5000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- waitForReady is on grpc.Client but not in the TS type surface
      (this.client as any).waitForReady(deadline, (err: Error | null) => {
        resolve(!err);
      });
    });
  }
}
