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

  private call<T>(method: string, request: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic RPC dispatch on proto-loaded client
      (this.client as any)[method](request, (err: grpc.ServiceError | null, response: T) => {
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
    });
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
    });
  }

  async startAgent(targetPackage: string): Promise<ActionResponse> {
    return this.call<ActionResponse>('startAgent', {
      requestId: requestId(),
      targetPackage,
    });
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
