/**
 * API request fixture for Pilot tests.
 *
 * Provides an `APIRequestContext` (modeled after Playwright's) that wraps
 * Node's built-in `fetch`. Each HTTP call emits a trace event and accumulates
 * a `NetworkEntry` so requests appear in the trace viewer / UI mode.
 *
 * @see PILOT-121
 */

import type { NetworkEntry } from './trace/types.js';
import { getActiveTraceCollector, extractSourceLocation } from './trace/trace-collector.js';

// ─── Types ───

export interface APIRequestOptions {
  /** Request body. Objects are JSON-serialized automatically. */
  data?: unknown
  /** Per-request headers (override `extraHTTPHeaders`). */
  headers?: Record<string, string>
  /** Query parameters appended to the URL. */
  params?: Record<string, string> | URLSearchParams
  /** Per-request timeout in milliseconds. */
  timeout?: number
  /** Form-encoded body (sets Content-Type to application/x-www-form-urlencoded). */
  form?: Record<string, string>
}

// ─── PilotAPIResponse ───

/**
 * Response wrapper with an eagerly-buffered body so it can be read multiple
 * times (unlike the native single-read `Response` stream).
 */
export class PilotAPIResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly url: string;
  readonly headers: Headers;

  private _body: Buffer;

  /** @internal */
  constructor(status: number, statusText: string, ok: boolean, url: string, headers: Headers, body: Buffer) {
    this.status = status;
    this.statusText = statusText;
    this.ok = ok;
    this.url = url;
    this.headers = headers;
    this._body = body;
  }

  /** Parse the response body as JSON. */
  async json(): Promise<unknown> {
    return JSON.parse(this._body.toString('utf-8'));
  }

  /** Return the response body as a UTF-8 string. */
  async text(): Promise<string> {
    return this._body.toString('utf-8');
  }

  /** Return the raw response body buffer. */
  async body(): Promise<Buffer> {
    return this._body;
  }

  /** Flatten response headers to a plain object. */
  headersObject(): Record<string, string> {
    const result: Record<string, string> = {};
    this.headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /** Explicit cleanup (no-op for now; reserved for future pooling). */
  dispose(): void {
    // intentionally empty
  }
}

// ─── APIRequestContext ───

export interface APIRequestContextOptions {
  baseURL?: string
  extraHTTPHeaders?: Record<string, string>
}

/**
 * Built-in fixture for making HTTP requests during tests.
 * Wraps `globalThis.fetch` with URL resolution, header merging,
 * body serialization, and trace integration.
 */
export class APIRequestContext {
  private _baseURL: string | undefined;
  private _extraHTTPHeaders: Record<string, string>;
  private _networkEntries: NetworkEntry[] = [];
  private _abortController = new AbortController();

  constructor(options: APIRequestContextOptions = {}) {
    this._baseURL = options.baseURL;
    this._extraHTTPHeaders = options.extraHTTPHeaders ?? {};
  }

  /** Send a GET request. */
  async get(url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    return this._fetch('GET', url, options);
  }

  /** Send a POST request. */
  async post(url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    return this._fetch('POST', url, options);
  }

  /** Send a PUT request. */
  async put(url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    return this._fetch('PUT', url, options);
  }

  /** Send a PATCH request. */
  async patch(url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    return this._fetch('PATCH', url, options);
  }

  /** Send a DELETE request. */
  async delete(url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    return this._fetch('DELETE', url, options);
  }

  /** Send a HEAD request. */
  async head(url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    return this._fetch('HEAD', url, options);
  }

  /** Send a request with an explicit method. */
  async fetch(url: string, options?: APIRequestOptions & { method?: string }): Promise<PilotAPIResponse> {
    return this._fetch(options?.method ?? 'GET', url, options);
  }

  /** Return accumulated network entries for trace merging. */
  getNetworkEntries(): NetworkEntry[] {
    return this._networkEntries;
  }

  /** Abort any in-flight requests and clean up. */
  dispose(): void {
    this._abortController.abort();
  }

  // ─── Internal ───

  private async _fetch(method: string, url: string, options?: APIRequestOptions): Promise<PilotAPIResponse> {
    // Capture source location before any async work
    const sourceLocation = extractSourceLocation(new Error().stack ?? '');

    // Resolve URL
    const resolvedUrl = this._resolveUrl(url, options?.params);

    // Merge headers
    const headers: Record<string, string> = {
      ...this._extraHTTPHeaders,
      ...options?.headers,
    };

    // Build body
    let body: BodyInit | undefined;
    if (options?.form) {
      body = new URLSearchParams(options.form).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (options?.data !== undefined) {
      if (typeof options.data === 'string') {
        body = options.data;
      } else if (Buffer.isBuffer(options.data)) {
        body = new Uint8Array(options.data);
      } else {
        body = JSON.stringify(options.data);
        headers['content-type'] ??= 'application/json';
      }
    }

    // Timeout
    const ac = new AbortController();
    const parentSignal = this._abortController.signal;
    const onParentAbort = () => ac.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      ac.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) {
      timer = setTimeout(() => ac.abort(new Error(`Request timed out after ${options.timeout}ms`)), options.timeout);
    }

    const startTime = Date.now();
    let response: Response;
    let responseBuffer: Buffer;
    try {
      response = await globalThis.fetch(resolvedUrl.toString(), {
        method,
        headers,
        body,
        signal: ac.signal,
      });
      responseBuffer = Buffer.from(await response.arrayBuffer());
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Build response wrapper
    const pilotResponse = new PilotAPIResponse(
      response.status,
      response.statusText,
      response.ok,
      response.url,
      response.headers,
      responseBuffer,
    );

    // ── Trace integration ──
    const collector = getActiveTraceCollector();
    if (collector) {
      const action = `request.${method.toLowerCase()}`;
      const success = response.ok;
      const log = [
        `${method} ${resolvedUrl.toString()}`,
        `${response.status} ${response.statusText} (${duration}ms)`,
      ];

      // Emit action event so it appears in the actions panel
      collector.addActionEvent({
        category: 'api',
        action,
        duration,
        success,
        error: success ? undefined : `${response.status} ${response.statusText}`,
        log,
        hasScreenshotBefore: false,
        hasScreenshotAfter: false,
        hasHierarchyBefore: false,
        hasHierarchyAfter: false,
        sourceLocation,
      });

      // Build request headers record for the network entry
      const requestHeaders: Record<string, string> = { ...headers };
      const responseHeaders = pilotResponse.headersObject();

      // Build and accumulate NetworkEntry
      let requestBodyBuf: Buffer | undefined;
      if (body !== undefined) {
        if (typeof body === 'string') {
          requestBodyBuf = Buffer.from(body);
        } else if (body instanceof Uint8Array) {
          requestBodyBuf = Buffer.from(body);
        } else {
          requestBodyBuf = Buffer.from(String(body));
        }
      }
      const entry: NetworkEntry = {
        index: this._networkEntries.length,
        actionIndex: collector.currentActionIndex - 1,
        startTime,
        endTime,
        method,
        url: resolvedUrl.toString(),
        status: response.status,
        contentType: responseHeaders['content-type'] ?? '',
        requestSize: requestBodyBuf?.length ?? 0,
        responseSize: responseBuffer.length,
        duration,
        requestHeaders,
        responseHeaders,
        requestBody: requestBodyBuf,
        responseBody: responseBuffer,
      };
      this._networkEntries.push(entry);
    }

    return pilotResponse;
  }

  private _resolveUrl(url: string, params?: Record<string, string> | URLSearchParams): URL {
    let resolved: URL;
    if (this._baseURL && !url.startsWith('http://') && !url.startsWith('https://')) {
      // Ensure baseURL ends with / for proper relative resolution
      const base = this._baseURL.endsWith('/') ? this._baseURL : this._baseURL + '/';
      resolved = new URL(url.startsWith('/') ? url.slice(1) : url, base);
    } else {
      resolved = new URL(url);
    }

    if (params) {
      const entries = params instanceof URLSearchParams ? params : new URLSearchParams(params);
      entries.forEach((value, key) => {
        resolved.searchParams.append(key, value);
      });
    }

    return resolved;
  }
}
