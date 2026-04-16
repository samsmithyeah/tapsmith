/**
 * Network route interception — Playwright-style `device.route()` API.
 *
 * Provides Route, PilotRequest, and the internal NetworkRouteManager that
 * bridges TypeScript route handlers to the Rust daemon's MITM proxy via a
 * bidirectional gRPC stream.
 */

import * as crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type * as grpc from '@grpc/grpc-js';
import type { PilotGrpcClient } from './grpc-client.js';
import { getActiveTraceCollector, extractSourceLocation } from './trace/trace-collector.js';
import type { SourceLocation } from './trace/types.js';

// ─── Public Types ───

/** An intercepted HTTP request. */
export class PilotRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly postData: Buffer | null;
  readonly isHttps: boolean;

  /** @internal */
  constructor(data: {
    method: string
    url: string
    headers: Array<{ name: string; value: string }>
    body: Buffer | Uint8Array | null
    isHttps: boolean
  }) {
    this.method = data.method;
    this.url = data.url;
    this.headers = {};
    for (const h of data.headers) {
      this.headers[h.name.toLowerCase()] = h.value;
    }
    this.postData = data.body && data.body.length > 0 ? Buffer.from(data.body) : null;
    this.isHttps = data.isHttps;
  }
}

/** Options for `route.continue()`. */
export interface RouteContinueOptions {
  url?: string
  method?: string
  headers?: Record<string, string>
  postData?: string | Buffer
}

/** Options for `route.fulfill()`. */
export interface RouteFulfillOptions {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
  contentType?: string
  /** Convenience: serialize as JSON and set content-type. */
  json?: unknown
  /** Read body from a file path. */
  path?: string
}

/** A route handler receives this object to decide how to handle the request. */
export class Route {
  private _interceptId: string;
  private _request: PilotRequest;
  private _resolved = false;
  private _sendDecision: (decision: RouteDecisionMsg) => void;
  private _awaitFetchedResponse: (() => Promise<FetchedResponseMsg>) | null = null;

  /** @internal */
  constructor(
    interceptId: string,
    request: PilotRequest,
    sendDecision: (decision: RouteDecisionMsg) => void,
    awaitFetchedResponse: () => Promise<FetchedResponseMsg>,
  ) {
    this._interceptId = interceptId;
    this._request = request;
    this._sendDecision = sendDecision;
    this._awaitFetchedResponse = awaitFetchedResponse;
  }

  /** The intercepted request. */
  request(): PilotRequest {
    return this._request;
  }

  /** Abort the request. */
  async abort(errorCode?: string): Promise<void> {
    this._ensureNotResolved();
    // Mark resolved *after* sending so a throw from _sendDecision (e.g. the
    // post-fetch phase guard) leaves _resolved=false — the handler's catch
    // can then fail-open via continueRequest without double-resolving.
    this._sendDecision({
      interceptId: this._interceptId,
      abort: { errorCode: errorCode ?? '' },
    });
    this._resolved = true;
  }

  /** Continue the request with optional overrides. */
  async continue(overrides?: RouteContinueOptions): Promise<void> {
    this._ensureNotResolved();
    this._sendDecision({
      interceptId: this._interceptId,
      continueRequest: {
        url: overrides?.url ?? '',
        method: overrides?.method ?? '',
        headers: overrides?.headers
          ? Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
          : [],
        postData: overrides?.postData
          ? Buffer.from(overrides.postData)
          : Buffer.alloc(0),
      },
    });
    this._resolved = true;
  }

  /** Fulfill the request with a mock response. */
  async fulfill(options?: RouteFulfillOptions): Promise<void> {
    this._ensureNotResolved();

    let body: Buffer = Buffer.alloc(0);
    let contentType = options?.contentType ?? '';

    if (options?.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json));
      if (!contentType) contentType = 'application/json';
    } else if (options?.path) {
      // Read *before* marking the route resolved so a failed read still lets
      // the handler's catch path fail-open via continueRequest.
      body = await readFile(options.path);
    } else if (options?.body !== undefined) {
      body = Buffer.from(options.body);
    }

    this._resolved = true;
    this._sendDecision({
      interceptId: this._interceptId,
      fulfill: {
        status: options?.status ?? 200,
        headers: options?.headers
          ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
          : [],
        body,
        contentType,
      },
    });
  }

  /** Fetch the actual response from upstream, allowing modification. */
  async fetch(overrides?: RouteContinueOptions): Promise<FetchedAPIResponse> {
    this._ensureNotResolved();

    // Send a RouteFetch decision
    this._sendDecision({
      interceptId: this._interceptId,
      fetch: {
        url: overrides?.url ?? '',
        method: overrides?.method ?? '',
        headers: overrides?.headers
          ? Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
          : [],
        postData: overrides?.postData
          ? Buffer.from(overrides.postData)
          : Buffer.alloc(0),
      },
    });

    // Wait for the daemon to send back the real upstream response.
    // If the daemon rejected (upstream-fetch failure → status=0 sentinel,
    // or stream died mid-fetch), lock the route SDK-side before rethrowing
    // so the outer handler's `.catch` fail-open path doesn't send a stale
    // `continueRequest` for an intercept the daemon already forgot (which
    // would trigger a spurious "RouteDecision for unknown intercept_id"
    // warning in the daemon).
    let fetched: FetchedResponseMsg;
    try {
      fetched = await this._awaitFetchedResponse!();
    } catch (err) {
      this._resolved = true;
      throw err;
    }

    const headers: Record<string, string> = {};
    for (const h of fetched.headers ?? []) {
      headers[h.name.toLowerCase()] = h.value;
    }

    // Replace _sendDecision so the next route.fulfill() sends
    // fulfill_after_fetch instead of a regular fulfill. After fetch(), only
    // fulfill() is legal — abort/continue would be a wrong-phase decision
    // that the daemon can't pair with the pending fulfill_after_fetch slot,
    // so reject them loudly instead of silently hanging the intercept.
    const originalSend = this._sendDecision;
    this._resolved = false;
    this._sendDecision = (decision: RouteDecisionMsg) => {
      if (decision.fulfill) {
        originalSend({
          interceptId: this._interceptId,
          fulfillAfterFetch: decision.fulfill,
        });
      } else if (decision.abort || decision.continueRequest || decision.fetch) {
        throw new Error(
          'After route.fetch(), only route.fulfill() is allowed. ' +
          'route.abort()/continue()/fetch() would leave the request in an inconsistent state.',
        );
      } else {
        originalSend(decision);
      }
    };

    return new FetchedAPIResponse(fetched.status, headers, Buffer.from(fetched.body ?? []));
  }

  private _ensureNotResolved(): void {
    if (this._resolved) {
      throw new Error('Route has already been handled');
    }
  }

  /** @internal — used by NetworkRouteManager to detect handlers that return without resolving. */
  _isResolved(): boolean {
    return this._resolved;
  }

  /**
   * @internal — NetworkRouteManager marks the route resolved after failing
   * open, so a late `route.fulfill()` from a background async chain throws
   * loudly (Route has already been handled) instead of silently sending a
   * decision the daemon can't pair with any pending intercept.
   */
  _forceResolve(): void {
    this._resolved = true;
  }
}

/** Response returned by `route.fetch()` — wraps the real upstream response. */
export class FetchedAPIResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  private readonly _body: Buffer;

  constructor(status: number, headers: Record<string, string>, body: Buffer) {
    this.status = status;
    this.headers = headers;
    this._body = body;
  }

  body(): Buffer {
    return this._body;
  }

  text(): string {
    return this._body.toString('utf-8');
  }

  json(): unknown {
    return JSON.parse(this.text());
  }
}

// ─── Internal Types (proto message shapes) ───

interface HeaderEntry {
  name: string
  value: string
}

interface RouteDecisionMsg {
  interceptId: string
  abort?: { errorCode: string }
  continueRequest?: {
    url: string
    method: string
    headers: HeaderEntry[]
    postData: Buffer
  }
  fulfill?: {
    status: number
    headers: HeaderEntry[]
    body: Buffer
    contentType: string
  }
  fetch?: {
    url: string
    method: string
    headers: HeaderEntry[]
    postData: Buffer
  }
  fulfillAfterFetch?: {
    status: number
    headers: HeaderEntry[]
    body: Buffer
    contentType: string
  }
}

interface InterceptedRequestMsg {
  interceptId: string
  routeId: string
  method: string
  url: string
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
  isHttps: boolean
}

interface FetchedResponseMsg {
  interceptId: string
  status: number
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
}

interface RegisteredRouteInfo {
  routeId: string
  urlPattern: string
  /**
   * Original user-supplied pattern. For regex/predicate patterns the daemon
   * is sent a `**` glob (it can't evaluate JS regexes), so every request
   * matches on the wire; we re-check this in the SDK before dispatching.
   */
  originalPattern: string | RegExp | ((url: URL) => boolean)
  handler: (route: Route) => Promise<void> | void
  timesRemaining?: number
  sourceLocation?: SourceLocation
}

// ─── URL Pattern Matching ───

/** Match a URL against a glob/regex/predicate pattern (used SDK-side for event filtering). */
export function matchUrlPattern(
  url: string,
  pattern: string | RegExp | ((url: URL) => boolean),
): boolean {
  if (typeof pattern === 'string') {
    return globMatch(pattern, url);
  } else if (pattern instanceof RegExp) {
    return pattern.test(url);
  } else {
    try {
      return pattern(new URL(url));
    } catch {
      return false;
    }
  }
}

function globMatch(pattern: string, url: string): boolean {
  const re = globToRegex(pattern);
  return re.test(url);
}

function globToRegex(pattern: string): RegExp {
  let re = '^';
  const chars = [...pattern];
  let i = 0;

  while (i < chars.length) {
    if (chars[i] === '*') {
      if (i + 1 < chars.length && chars[i + 1] === '*') {
        re += '.*';
        i += 2;
        // A trailing `/` after `**` is required, not optional —
        // otherwise `**/api` would match `example.comapi`. Mirrors
        // the Rust impl in route_handler.rs::glob_to_regex (keep in sync).
        if (i < chars.length && chars[i] === '/') {
          re += '/';
          i++;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (chars[i] === '?') {
      re += '[^/]';
      i++;
    } else if (chars[i] === '{') {
      const close = chars.indexOf('}', i);
      if (close !== -1) {
        const group = chars.slice(i + 1, close).join('');
        const alts = group.split(',').map(escapeRegex).join('|');
        re += `(${alts})`;
        i = close + 1;
      } else {
        re += escapeRegex(chars[i]);
        i++;
      }
    } else {
      re += escapeRegex(chars[i]);
      i++;
    }
  }

  re += '$';
  return new RegExp(re);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Structural equality for user-supplied URL patterns. Needed by `unroute`
 * because regex/predicate patterns all share the sentinel glob `**` on the
 * daemon side, so comparing by `urlPattern` string would collapse every
 * regex/predicate route into a single bucket.
 *
 * @internal — exported only for unit-test visibility.
 */
export function patternsEqual(
  a: string | RegExp | ((url: URL) => boolean),
  b: string | RegExp | ((url: URL) => boolean),
): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  if (typeof a === 'function' && typeof b === 'function') {
    return a === b;
  }
  return false;
}

/** Convert a URL pattern to the glob string sent to the daemon. */
function patternToGlob(pattern: string | RegExp | ((url: URL) => boolean)): string {
  if (typeof pattern === 'string') {
    return pattern;
  }
  // For RegExp and predicate patterns, we use a catch-all glob on the daemon
  // and do the filtering SDK-side in the handler dispatch.
  return '**';
}

// ─── NetworkRouteManager ───

/**
 * Manages the bidirectional gRPC stream for network route interception.
 * Opened lazily on the first `device.route()` call.
 * @internal
 */
export class NetworkRouteManager {
  private _client: PilotGrpcClient;
  private _stream: grpc.ClientDuplexStream<unknown, unknown> | null = null;
  private _routes: Map<string, RegisteredRouteInfo> = new Map();
  private _pendingFetches: Map<string, {
    resolve: (resp: FetchedResponseMsg) => void
    reject: (err: Error) => void
  }> = new Map();
  private _requestListeners: Set<(req: PilotRequest) => void> = new Set();
  private _responseListeners: Set<(resp: NetworkResponseEventData) => void> = new Set();
  private _disposed = false;

  constructor(client: PilotGrpcClient) {
    this._client = client;
  }

  /** Lazily open the bidi stream. */
  private _ensureStream(): grpc.ClientDuplexStream<unknown, unknown> {
    if (this._stream) return this._stream;

    const stream = this._client.networkRouteStream();
    this._stream = stream;

    stream.on('data', (msg: ServerMessage) => {
      this._onServerMessage(msg);
    });

    stream.on('error', (err: Error) => {
      // Drop the broken stream so subsequent operations don't try to
      // write to it. Next ensureStream() call will reconnect.
      this._stream = null;
      // CANCELLED (1) and UNAVAILABLE (14) are expected during teardown
      // and daemon reconnection — don't spam warnings for them.
      const code = (err as grpc.ServiceError).code;
      if (code !== 1 && code !== 14) {
        console.warn('[pilot] NetworkRoute stream error:', err.message);
      }
      this._rejectPendingFetches(`NetworkRoute stream error: ${err.message}`);
    });

    stream.on('end', () => {
      this._stream = null;
      this._rejectPendingFetches('NetworkRoute stream closed');
    });

    return stream;
  }

  /** Best-effort write to the stream. Silently no-ops if the stream is down. */
  private _safeWrite(msg: unknown): void {
    if (!this._stream) return;
    try {
      this._stream.write(msg);
    } catch {
      // Stream closed between check and write — drop the message.
      this._stream = null;
    }
  }

  /** Register a route handler. */
  async addRoute(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler: (route: Route) => Promise<void> | void,
    options?: { times?: number },
  ): Promise<void> {
    const routeId = crypto.randomUUID();
    const urlPattern = patternToGlob(pattern);

    // Capture source location at registration time — used by trace events
    // when the handler fires so the viewer can highlight the test code.
    const sourceLocation = extractSourceLocation(new Error().stack ?? '');

    this._routes.set(routeId, {
      routeId,
      urlPattern,
      originalPattern: pattern,
      handler,
      timesRemaining: options?.times,
      sourceLocation,
    });

    const stream = this._ensureStream();

    return new Promise<void>((resolve, reject) => {
      // Wire all three listeners so the promise always settles: data for
      // the success/failure reply, error/end so a stream death during
      // registration rejects instead of leaking a listener + hanging the
      // caller. The `cleanup` closure detaches all three whichever wins.
      const cleanup = () => {
        stream.removeListener('data', onResponse);
        stream.removeListener('error', onStreamError);
        stream.removeListener('end', onStreamEnd);
      };
      const onResponse = (msg: ServerMessage) => {
        if (msg.registerRouteResponse?.routeId === routeId) {
          cleanup();
          if (msg.registerRouteResponse.success) {
            resolve();
          } else {
            this._routes.delete(routeId);
            reject(new Error(msg.registerRouteResponse.errorMessage || 'Failed to register route'));
          }
        }
      };
      const onStreamError = (err: Error) => {
        cleanup();
        this._routes.delete(routeId);
        reject(new Error(`NetworkRoute stream error during route registration: ${err.message}`));
      };
      const onStreamEnd = () => {
        cleanup();
        this._routes.delete(routeId);
        reject(new Error('NetworkRoute stream closed during route registration'));
      };
      stream.on('data', onResponse);
      stream.on('error', onStreamError);
      stream.on('end', onStreamEnd);

      stream.write({
        registerRoute: {
          routeId,
          urlPattern,
        },
      });
    });
  }

  /** Remove a route handler. */
  async removeRoute(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler?: (route: Route) => Promise<void> | void,
  ): Promise<void> {
    const toRemove: string[] = [];

    for (const [id, info] of this._routes) {
      if (patternsEqual(info.originalPattern, pattern)) {
        if (!handler || info.handler === handler) {
          toRemove.push(id);
        }
      }
    }

    for (const id of toRemove) {
      this._routes.delete(id);
      this._safeWrite({
        unregisterRoute: { routeId: id },
      });
    }
  }

  /** Remove all routes. */
  async removeAllRoutes(): Promise<void> {
    const ids = [...this._routes.keys()];
    for (const id of ids) {
      this._routes.delete(id);
      this._safeWrite({
        unregisterRoute: { routeId: id },
      });
    }
  }

  /** Subscribe to request events. */
  addRequestListener(handler: (req: PilotRequest) => void): void {
    this._requestListeners.add(handler);
    if (this._requestListeners.size === 1 && this._responseListeners.size === 0) {
      const stream = this._ensureStream();
      stream.write({ subscribeEvents: {} });
    }
  }

  /** Unsubscribe from request events. */
  removeRequestListener(handler: (req: PilotRequest) => void): void {
    this._requestListeners.delete(handler);
    if (this._requestListeners.size === 0 && this._responseListeners.size === 0 && this._stream) {
      this._stream.write({ unsubscribeEvents: {} });
    }
  }

  /** Subscribe to response events. */
  addResponseListener(handler: (resp: NetworkResponseEventData) => void): void {
    this._responseListeners.add(handler);
    if (this._responseListeners.size === 1 && this._requestListeners.size === 0) {
      const stream = this._ensureStream();
      stream.write({ subscribeEvents: {} });
    }
  }

  /** Unsubscribe from response events. */
  removeResponseListener(handler: (resp: NetworkResponseEventData) => void): void {
    this._responseListeners.delete(handler);
    if (this._responseListeners.size === 0 && this._requestListeners.size === 0 && this._stream) {
      this._stream.write({ unsubscribeEvents: {} });
    }
  }

  /** Whether any routes are registered. */
  get hasRoutes(): boolean {
    return this._routes.size > 0;
  }

  /** Close the stream and clean up. */
  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    this._routes.clear();
    this._rejectPendingFetches('NetworkRouteManager disposed');
    this._requestListeners.clear();
    this._responseListeners.clear();

    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }

  /** Handle an incoming server message. */
  private _onServerMessage(msg: ServerMessage): void {
    if (msg.interceptedRequest) {
      this._handleInterceptedRequest(msg.interceptedRequest);
    } else if (msg.fetchedResponse) {
      this._handleFetchedResponse(msg.fetchedResponse);
    } else if (msg.requestEvent) {
      this._handleRequestEvent(msg.requestEvent);
    } else if (msg.responseEvent) {
      this._handleResponseEvent(msg.responseEvent);
    }
    // registerRouteResponse / unregisterRouteResponse handled inline
  }

  /** Dispatch an intercepted request to the matching route handler. */
  private _handleInterceptedRequest(msg: InterceptedRequestMsg): void {
    const routeInfo = this._routes.get(msg.routeId);
    if (!routeInfo) {
      // Route was removed while request was in flight — continue upstream
      this._safeWrite({
        routeDecision: {
          interceptId: msg.interceptId,
          continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
        },
      });
      return;
    }

    // For regex/predicate patterns the daemon matches on a `**` glob, so we
    // re-check in the SDK. If the real pattern doesn't match, don't invoke
    // the handler — just continue the request upstream.
    if (typeof routeInfo.originalPattern !== 'string'
        && !matchUrlPattern(msg.url, routeInfo.originalPattern)) {
      this._safeWrite({
        routeDecision: {
          interceptId: msg.interceptId,
          continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
        },
      });
      return;
    }

    // Check times remaining
    if (routeInfo.timesRemaining !== undefined) {
      routeInfo.timesRemaining--;
      if (routeInfo.timesRemaining <= 0) {
        this._routes.delete(routeInfo.routeId);
        this._safeWrite({
          unregisterRoute: { routeId: routeInfo.routeId },
        });
      }
    }

    const request = new PilotRequest({
      method: msg.method,
      url: msg.url,
      headers: msg.headers,
      body: msg.body,
      isHttps: msg.isHttps,
    });

    // Track which route action the handler takes for trace events
    let routeAction = 'continue';
    const sendDecision = (decision: RouteDecisionMsg) => {
      if (decision.abort) routeAction = 'abort';
      else if (decision.fulfill || decision.fulfillAfterFetch) routeAction = 'fulfill';
      else if (decision.fetch) routeAction = 'fetch';
      else routeAction = 'continue';
      this._safeWrite({ routeDecision: decision });
    };

    const awaitFetchedResponse = (): Promise<FetchedResponseMsg> => {
      return new Promise<FetchedResponseMsg>((resolve, reject) => {
        this._pendingFetches.set(msg.interceptId, { resolve, reject });
      });
    };

    const route = new Route(msg.interceptId, request, sendDecision, awaitFetchedResponse);

    const startTime = Date.now();

    // Run the handler. If it throws, rejects, or returns without calling
    // abort/continue/fulfill/fetch, continue the request (fail-open).
    Promise.resolve()
      .then(() => routeInfo.handler(route))
      .then(() => {
        if (!route._isResolved()) {
          console.warn(
            `[pilot] Route handler for ${msg.method} ${msg.url} returned without calling ` +
            `abort/continue/fulfill/fetch — continuing request upstream. Make sure the handler ` +
            `awaits one of these (or returns the promise).`,
          );
          this._safeWrite({
            routeDecision: {
              interceptId: msg.interceptId,
              continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
            },
          });
          // Lock the route so a late async tail in the handler that calls
          // route.fulfill() throws loudly instead of sending a stale
          // decision the daemon can't route back to any pending intercept.
          route._forceResolve();
          routeAction = 'continue';
        }
        this._emitRouteTraceEvent(msg, routeAction, startTime, true, undefined, routeInfo.sourceLocation);
      })
      .catch((err) => {
        console.warn(`[pilot] Route handler error: ${err}`);
        // Fail-open: continue the request (only if the handler hasn't
        // already resolved the route — don't double-send a decision).
        if (!route._isResolved()) {
          this._safeWrite({
            routeDecision: {
              interceptId: msg.interceptId,
              continueRequest: { url: '', method: '', headers: [], postData: Buffer.alloc(0) },
            },
          });
          route._forceResolve();
        }
        this._emitRouteTraceEvent(msg, 'continue', startTime, false, String(err), routeInfo.sourceLocation);
      });
  }

  /** Emit a trace event for a route handler invocation. */
  private _emitRouteTraceEvent(
    msg: InterceptedRequestMsg,
    action: string,
    startTime: number,
    success: boolean,
    error?: string,
    sourceLocation?: SourceLocation,
  ): void {
    const collector = getActiveTraceCollector();
    if (!collector) return;

    const duration = Date.now() - startTime;
    let shortUrl: string;
    try {
      const url = new URL(msg.url);
      shortUrl = url.pathname + url.search;
    } catch {
      shortUrl = msg.url;
    }

    collector.addActionEvent({
      category: 'network',
      action: `route.${action}`,
      duration,
      success,
      error,
      log: [
        `${msg.method} ${msg.url}`,
        `route.${action}() (${duration}ms)`,
      ],
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
      selector: shortUrl,
      sourceLocation,
    });
  }

  /** Deliver a fetched response to the pending fetch promise. */
  private _handleFetchedResponse(msg: FetchedResponseMsg): void {
    const pending = this._pendingFetches.get(msg.interceptId);
    if (!pending) return;
    this._pendingFetches.delete(msg.interceptId);
    // Daemon signals upstream-fetch failure with status 0 (not a valid HTTP
    // status, matches the proto default). Reject so user code can catch it
    // instead of hanging.
    if (msg.status === 0) {
      pending.reject(new Error('route.fetch() failed: upstream request error'));
      return;
    }
    pending.resolve(msg);
  }

  /** Reject all in-flight route.fetch() promises. */
  private _rejectPendingFetches(reason: string): void {
    if (this._pendingFetches.size === 0) return;
    const err = new Error(reason);
    for (const { reject } of this._pendingFetches.values()) {
      reject(err);
    }
    this._pendingFetches.clear();
  }

  /** Notify request event listeners. */
  private _handleRequestEvent(msg: RequestEventMsg): void {
    const request = new PilotRequest({
      method: msg.method,
      url: msg.url,
      headers: msg.headers,
      body: msg.body,
      isHttps: msg.isHttps,
    });
    for (const listener of this._requestListeners) {
      try {
        listener(request);
      } catch {
        // ignore listener errors
      }
    }
  }

  /** Notify response event listeners. */
  private _handleResponseEvent(msg: ResponseEventMsg): void {
    const data: NetworkResponseEventData = {
      method: msg.method,
      url: msg.url,
      status: msg.status,
      headers: {},
      body: msg.body ? Buffer.from(msg.body) : null,
      routeAction: msg.routeAction || undefined,
    };
    for (const h of msg.headers ?? []) {
      data.headers[h.name.toLowerCase()] = h.value;
    }
    for (const listener of this._responseListeners) {
      try {
        listener(data);
      } catch {
        // ignore listener errors
      }
    }
  }
}

/** Data emitted for response events. */
export interface NetworkResponseEventData {
  method: string
  url: string
  status: number
  headers: Record<string, string>
  body: Buffer | null
  routeAction?: string
}

// ─── Internal server message shape (from proto) ───

interface ServerMessage {
  registerRouteResponse?: { routeId: string; success: boolean; errorMessage: string }
  unregisterRouteResponse?: { routeId: string; success: boolean }
  interceptedRequest?: InterceptedRequestMsg
  fetchedResponse?: FetchedResponseMsg
  requestEvent?: RequestEventMsg
  responseEvent?: ResponseEventMsg
}

interface RequestEventMsg {
  method: string
  url: string
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
  isHttps: boolean
  routeAction: string
}

interface ResponseEventMsg {
  method: string
  url: string
  status: number
  headers: HeaderEntry[]
  body: Buffer | Uint8Array
  routeAction: string
}
