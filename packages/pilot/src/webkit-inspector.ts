/**
 * WebKit Remote Inspector Protocol client for iOS simulator WebViews.
 *
 * Connects to the simulator's webinspectord Unix domain socket and speaks
 * the binary-plist RPC protocol to discover inspectable pages and forward
 * WebKit Inspector messages (which are JSON, similar to CDP).
 *
 * Protocol: 4-byte big-endian length prefix + binary plist message.
 * Messages use __selector / __argument keys for RPC dispatch.
 */

import * as net from 'node:net';
import { execSync } from 'node:child_process';
import bplistParser from 'bplist-parser';
import bplistCreator from 'bplist-creator';

interface WebKitApp {
  pid: string
  name: string
  bundleId: string
  isActive: boolean
  pages: Map<number, WebKitPage>
}

interface WebKitPage {
  id: number
  title: string
  url: string
  type: string
}

interface PendingMessage {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export class WebKitInspectorClient {
  private _socket: net.Socket | null = null;
  private _connectionId: string;
  private _apps = new Map<string, WebKitApp>();
  private _buffer = Buffer.alloc(0);
  private _ready = false;
  private _readyResolve: (() => void) | null = null;
  private _messageHandlers: Array<(selector: string, argument: Record<string, unknown>) => void> = [];
  private _pendingEval = new Map<string, PendingMessage>();
  private _senderKey: string | null = null;
  private _targetId: string | null = null;
  private _outerMsgId = 0;
  private _connectedPageId: number | null = null;

  constructor() {
    this._connectionId = `pilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.on('connect', () => {
        this._socket = socket;
        this._setupDataHandler();
        this._sendReport().then(resolve).catch(reject);
      });
      socket.on('error', reject);
    });
  }

  private _setupDataHandler(): void {
    this._socket!.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._processBuffer();
    });
  }

  private _processBuffer(): void {
    while (this._buffer.length >= 4) {
      const msgLen = this._buffer.readUInt32BE(0);
      if (this._buffer.length < 4 + msgLen) break;

      const plistData = this._buffer.subarray(4, 4 + msgLen);
      this._buffer = this._buffer.subarray(4 + msgLen);

      try {
        const parsed = bplistParser.parseBuffer(plistData);
        const msg = parsed[0] as Record<string, unknown>;
        this._handleMessage(msg);
      } catch {
        // Skip unparseable messages
      }
    }
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const selector = msg.__selector as string;
    const argument = (msg.__argument ?? {}) as Record<string, unknown>;

    if (selector === '_rpc_reportCurrentState:') {
      // Initial state report
      return;
    }

    if (selector === '_rpc_reportConnectedApplicationList:') {
      this._parseApplicationList(argument);
      if (this._readyResolve) {
        this._readyResolve();
        this._readyResolve = null;
      }
      return;
    }

    if (selector === '_rpc_applicationConnected:') {
      this._addApp(argument);
      return;
    }

    if (selector === '_rpc_applicationDisconnected:') {
      const appId = argument.WIRApplicationIdentifierKey as string;
      this._apps.delete(appId);
      return;
    }

    if (selector === '_rpc_applicationUpdated:') {
      this._updateApp(argument);
      return;
    }

    if (selector === '_rpc_applicationSentListing:') {
      const appId = argument.WIRApplicationIdentifierKey as string;
      const listing = argument.WIRListingKey as Record<string, Record<string, unknown>> | undefined;
      const app = this._apps.get(appId);
      if (app && listing) {
        app.pages.clear();
        for (const [, pageData] of Object.entries(listing)) {
          const page: WebKitPage = {
            id: pageData.WIRPageIdentifierKey as number,
            title: (pageData.WIRTitleKey as string) ?? '',
            url: (pageData.WIRURLKey as string) ?? '',
            type: (pageData.WIRTypeKey as string) ?? '',
          };
          app.pages.set(page.id, page);
        }
      }
      return;
    }

    if (selector === '_rpc_applicationSentData:') {
      const dataStr = argument.WIRMessageDataKey as Buffer | string;
      const messageStr = typeof dataStr === 'string'
        ? dataStr
        : dataStr?.toString('utf-8');
      if (messageStr) {
        try {
          const parsed = JSON.parse(messageStr) as Record<string, unknown>;

          // Handle Target.targetCreated — store the page target ID
          if (parsed.method === 'Target.targetCreated') {
            const info = (parsed.params as Record<string, unknown>)?.targetInfo as Record<string, unknown>;
            if (info?.type === 'page') {
              this._targetId = info.targetId as string;
            }
            return;
          }

          // Handle Target.dispatchMessageFromTarget — unwrap inner response
          if (parsed.method === 'Target.dispatchMessageFromTarget') {
            const params = parsed.params as Record<string, unknown>;
            const innerStr = params?.message as string;
            if (innerStr) {
              try {
                const inner = JSON.parse(innerStr) as Record<string, unknown>;
                const innerId = inner.id as number | undefined;
                if (innerId !== undefined) {
                  const key = `${argument.WIRApplicationIdentifierKey}:${innerId}`;
                  const pending = this._pendingEval.get(key);
                  if (pending) {
                    this._pendingEval.delete(key);
                    pending.resolve(inner);
                  }
                }
              } catch { /* not JSON */ }
            }
            return;
          }

          // Direct responses (e.g., to Target.sendMessageToTarget itself)
          const id = parsed.id as number | undefined;
          if (id !== undefined) {
            // These are responses to our outer Target.sendMessageToTarget calls — ignore
          }
        } catch { /* not JSON */ }
      }
      return;
    }

    for (const handler of this._messageHandlers) {
      handler(selector, argument);
    }
  }

  private _parseApplicationList(argument: Record<string, unknown>): void {
    const dict = argument.WIRApplicationDictionaryKey as Record<string, Record<string, unknown>>;
    if (!dict) return;
    for (const [appId, appData] of Object.entries(dict)) {
      this._apps.set(appId, {
        pid: appId,
        name: (appData.WIRApplicationNameKey as string) ?? '',
        bundleId: (appData.WIRApplicationBundleIdentifierKey as string) ?? '',
        isActive: (appData.WIRIsApplicationActiveKey as number) > 0,
        pages: new Map(),
      });
    }
  }

  private _addApp(data: Record<string, unknown>): void {
    const appId = data.WIRApplicationIdentifierKey as string;
    this._apps.set(appId, {
      pid: appId,
      name: (data.WIRApplicationNameKey as string) ?? '',
      bundleId: (data.WIRApplicationBundleIdentifierKey as string) ?? '',
      isActive: (data.WIRIsApplicationActiveKey as number) > 0,
      pages: new Map(),
    });
  }

  private _updateApp(data: Record<string, unknown>): void {
    const appId = data.WIRApplicationIdentifierKey as string;
    const app = this._apps.get(appId);
    if (app) {
      app.name = (data.WIRApplicationNameKey as string) ?? app.name;
      app.bundleId = (data.WIRApplicationBundleIdentifierKey as string) ?? app.bundleId;
      app.isActive = (data.WIRIsApplicationActiveKey as number) > 0;
    }
  }

  private async _sendReport(): Promise<void> {
    return new Promise((resolve) => {
      this._readyResolve = resolve;
      this._sendMessage({
        __selector: '_rpc_reportIdentifier:',
        __argument: {
          WIRConnectionIdentifierKey: this._connectionId,
        },
      });

      // Also request the application list
      setTimeout(() => {
        this._sendMessage({
          __selector: '_rpc_getConnectedApplications:',
          __argument: {
            WIRConnectionIdentifierKey: this._connectionId,
          },
        });
      }, 100);

      // Timeout if we don't get a response
      setTimeout(() => {
        if (this._readyResolve) {
          this._readyResolve();
          this._readyResolve = null;
        }
      }, 3000);
    });
  }

  private _sendMessage(msg: Record<string, unknown>): void {
    if (!this._socket) throw new Error('Not connected');
    const plistData = bplistCreator(msg);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(plistData.length, 0);
    this._socket.write(Buffer.concat([header, plistData]));
  }

  /** Wait for page listings to arrive, then return all apps with pages. */
  async listTargets(): Promise<Array<{ appId: string; bundleId: string; name: string; pages: WebKitPage[] }>> {
    // Wait a bit for listing messages to arrive
    await new Promise(r => setTimeout(r, 1000));

    const results: Array<{ appId: string; bundleId: string; name: string; pages: WebKitPage[] }> = [];
    for (const [appId, app] of this._apps) {
      if (app.pages.size > 0 || app.bundleId.startsWith('dev.pilot') || !app.bundleId.startsWith('com.apple')) {
        results.push({
          appId,
          bundleId: app.bundleId,
          name: app.name,
          pages: Array.from(app.pages.values()),
        });
      }
    }
    return results;
  }

  /** Set up forwarding to a specific page for inspector messages. */
  async connectToPage(appId: string, pageId: number): Promise<void> {
    this._senderKey = appId;
    this._connectedPageId = pageId;

    // Indicate we want to inspect a WebView
    this._sendMessage({
      __selector: '_rpc_forwardIndicateWebView:',
      __argument: {
        WIRApplicationIdentifierKey: appId,
        WIRIndicateEnabledKey: true,
        WIRConnectionIdentifierKey: this._connectionId,
        WIRPageIdentifierKey: pageId,
      },
    });

    await new Promise(r => setTimeout(r, 200));

    // Set up the forwarding socket
    this._sendMessage({
      __selector: '_rpc_forwardSocketSetup:',
      __argument: {
        WIRConnectionIdentifierKey: this._connectionId,
        WIRApplicationIdentifierKey: appId,
        WIRPageIdentifierKey: pageId,
        WIRSenderKey: this._connectionId,
        WIRAutomaticallyPause: false,
      },
    });

    // Wait for Target.targetCreated to arrive with the page targetId
    const deadline = Date.now() + 5000;
    while (!this._targetId && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this._targetId) {
      throw new Error('Timed out waiting for WebView target — no Target.targetCreated received');
    }
  }

  /** Send a WebKit Inspector command to the connected page and wait for response. */
  async sendInspectorMessage(appId: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this._targetId) {
      throw new Error('No WebView target available — Target.targetCreated not received');
    }

    const innerId = message.id as number;
    const pageId = this._connectedPageId ?? 1;
    const key = `${appId}:${innerId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingEval.delete(key);
        reject(new Error(`WebKit Inspector message timed out (id=${innerId})`));
      }, 30000);

      this._pendingEval.set(key, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as Record<string, unknown>);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      // Wrap the command in Target.sendMessageToTarget
      const outerCmd = {
        id: ++this._outerMsgId,
        method: 'Target.sendMessageToTarget',
        params: {
          targetId: this._targetId,
          message: JSON.stringify(message),
        },
      };

      this._sendMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {
          WIRConnectionIdentifierKey: this._connectionId,
          WIRApplicationIdentifierKey: appId,
          WIRPageIdentifierKey: pageId,
          WIRSenderKey: this._connectionId,
          WIRSocketDataKey: Buffer.from(JSON.stringify(outerCmd)),
        },
      });
    });
  }

  close(): void {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    for (const [, p] of this._pendingEval) {
      p.reject(new Error('Connection closed'));
    }
    this._pendingEval.clear();
  }
}

/** Find the webinspectord Unix socket for a given iOS simulator UDID (or name). */
export function findSimulatorInspectorSocket(udidOrName: string): string | null {
  try {
    const psOutput = execSync('ps aux', { encoding: 'utf-8' });

    // Collect all launchd_sim PIDs and their UDIDs
    const sims: Array<{ pid: string; udid: string }> = [];
    for (const line of psOutput.split('\n')) {
      if (!line.includes('launchd_sim')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      // Extract UDID from the path: .../CoreSimulator/Devices/<UDID>/data/...
      const udidMatch = line.match(/CoreSimulator\/Devices\/([A-F0-9-]{36})\//);
      if (pid && udidMatch) {
        sims.push({ pid, udid: udidMatch[1] });
      }
    }

    if (sims.length === 0) return null;

    // Match by UDID if provided, otherwise use the first one
    let targetPid: string;
    if (udidOrName && udidOrName.match(/^[A-F0-9-]{36}$/i)) {
      const match = sims.find(s => s.udid === udidOrName);
      if (!match) return null;
      targetPid = match.pid;
    } else {
      // Use the first (or only) booted simulator
      targetPid = sims[0].pid;
    }

    // Find the webinspectord socket owned by this specific launchd_sim PID.
    // lsof -U shows ALL Unix sockets — match the PID column to filter correctly.
    const lsofOutput = execSync('lsof -U 2>/dev/null', { encoding: 'utf-8' });
    for (const line of lsofOutput.split('\n')) {
      if (!line.includes('webinspectord_sim.socket')) continue;
      const cols = line.trim().split(/\s+/);
      if (cols[1] === targetPid) {
        const match = line.match(/\s(\/\S+webinspectord_sim\.socket)/);
        if (match) return match[1];
      }
    }

    return null;
  } catch {
    return null;
  }
}
