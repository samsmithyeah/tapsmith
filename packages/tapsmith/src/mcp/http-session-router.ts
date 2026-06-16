import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { attachMcpClientEventReporting, createMcpServer } from './index.js';
import type { McpEventEmitter, McpClientInfo } from './events.js';
import type { TestDispatcher } from './test-dispatcher.js';

const DEFAULT_KEEPALIVE_INTERVAL_MS = 20_000;
const DEFAULT_SESSION_GRACE_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const SOCKET_KEEPALIVE_DELAY_MS = 15_000;

export interface McpSessionRouterOptions {
  /** Server name reported to clients. */
  name?: string
  /** Shared event emitter — every session reports tool calls into this. */
  events: McpEventEmitter
  /** Shared dispatcher driving the one underlying device/test session. */
  dispatcher?: TestDispatcher
  /** Called whenever the set of connected clients changes. */
  onClientsChanged?: (clients: McpClientInfo[]) => void
  /** SSE keep-alive interval (ms). Set to 0 to disable. */
  keepAliveIntervalMs?: number
  /**
   * Grace period (ms) before reaping a session whose standby SSE stream closed
   * cleanly and was not resumed. Set to 0 to reap immediately on close.
   */
  sessionGraceMs?: number
  /**
   * Reap a session that has had no inbound request and no writable standby
   * stream for this long (ms). Backstop for clients that vanish without an
   * explicit DELETE or a clean stream close (e.g. Claude Code's /mcp reconnect,
   * which abandons the old session). Set to 0 to disable the idle sweep.
   */
  idleTimeoutMs?: number
  /** How often the idle/liveness sweep runs (ms). */
  sweepIntervalMs?: number
}

interface McpSession {
  transport: StreamableHTTPServerTransport
  server: ReturnType<typeof createMcpServer>
  /** Timestamp of the last inbound request on this session. */
  lastActivityAt: number
  /** The open standby GET SSE response, if the client currently holds one. */
  standbyRes?: http.ServerResponse
}

/**
 * Routes Streamable-HTTP MCP requests across multiple concurrent sessions
 * (PILOT-221). A single transport instance is one MCP session in the SDK, so a
 * single shared transport can never accept a second `initialize` — breaking
 * reconnects and multi-client. This router follows the SDK's documented
 * multi-session pattern: a fresh transport + McpServer per `initialize`, keyed
 * by the `Mcp-Session-Id` header. Every per-session McpServer is built from the
 * same shared `dispatcher`/`events`, so multiple agents drive the one device
 * session and report into one activity feed.
 *
 * Liveness/cleanup uses multiple signals because no single one is reliable
 * (clients may not keep a standby stream, may not send DELETE, and may abandon
 * sessions half-open on reconnect): explicit DELETE → immediate; a clean
 * standby-stream close → reap after a short grace; a failed keep-alive write →
 * reap (dead standby); and an idle sweep as the final backstop.
 */
export class McpSessionRouter {
  private readonly sessions = new Map<string, McpSession>();
  private readonly clients = new Map<string, McpClientInfo>();
  private readonly reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly keepAliveIntervalMs: number;
  private readonly sessionGraceMs: number;
  private readonly idleTimeoutMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: McpSessionRouterOptions) {
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.sessionGraceMs = options.sessionGraceMs ?? DEFAULT_SESSION_GRACE_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (this.idleTimeoutMs > 0 && sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Currently connected clients (one entry per live session that finished init). */
  get clientList(): McpClientInfo[] {
    return [...this.clients.values()];
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Live session count (includes sessions that haven't finished init yet). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Handle a request to the `/mcp` endpoint (POST / GET / DELETE). */
  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;

    if (existing) {
      // Any traffic on a session means its owner is alive — refresh liveness.
      existing.lastActivityAt = Date.now();
      this.cancelReap(sessionId!);
      if (req.method === 'POST') {
        await existing.transport.handleRequest(req, res, await readJsonBody(req));
      } else {
        // GET opens the standby SSE stream; track it, keep it alive, and reap if
        // it closes (a reconnect re-opens it and refreshes liveness above).
        if (req.method === 'GET') this.registerStandbyStream(sessionId!, existing, res);
        await existing.transport.handleRequest(req, res);
      }
      return;
    }

    // No (or unknown) session id — only a fresh `initialize` POST may start one.
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!sessionId && isInitializeRequest(body)) {
        await this.createSession(req, res, body);
        return;
      }
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    }));
  }

  /** Tear down every live session. */
  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.reapTimers.values()) clearTimeout(timer);
    this.reapTimers.clear();
    for (const { transport, server } of this.sessions.values()) {
      try { transport.close(); } catch { /* already closed */ }
      try { server.close(); } catch { /* already closed */ }
    }
    this.sessions.clear();
    this.clients.clear();
  }

  private async createSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const server = createMcpServer({
      name: this.options.name ?? 'tapsmith',
      events: this.options.events,
      dispatcher: this.options.dispatcher,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { transport, server, lastActivityAt: Date.now() });
      },
      onsessionclosed: (sessionId) => { this.cleanupSession(sessionId); },
    });
    transport.onclose = () => { if (transport.sessionId) this.cleanupSession(transport.sessionId); };
    // Track this session's client identity (keyed by sessionId) so callers can
    // show every connected agent — a single shared emitter can't tell them apart.
    attachMcpClientEventReporting(server, this.options.events, undefined, (info) => {
      const sessionId = transport.sessionId;
      if (!sessionId) return;
      if (info) this.clients.set(sessionId, info);
      else this.clients.delete(sessionId);
      this.options.onClientsChanged?.(this.clientList);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  private registerStandbyStream(sessionId: string, session: McpSession, res: http.ServerResponse): void {
    session.standbyRes = res;
    // OS-level keepalive helps detect a peer that vanished without a FIN, so the
    // socket eventually errors and fires 'close' instead of hanging half-open.
    res.socket?.setKeepAlive(true, SOCKET_KEEPALIVE_DELAY_MS);
    this.attachKeepAlive(sessionId, res);
    res.on('close', () => {
      if (session.standbyRes === res) session.standbyRes = undefined;
      this.scheduleReap(sessionId);
    });
  }

  private cleanupSession(sessionId: string): void {
    this.cancelReap(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.clients.delete(sessionId);
    try { session.server.close(); } catch { /* already closed */ }
    this.options.onClientsChanged?.(this.clientList);
  }

  /** Force a session closed now (its transport.onclose runs cleanupSession). */
  private reapSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try { session.transport.close(); } catch { /* already closed */ }
    // Belt and braces in case the transport didn't fire onclose.
    this.cleanupSession(sessionId);
  }

  /**
   * Reap a session whose standby SSE stream closed cleanly, after the grace
   * period (a resume re-opens the stream and cancels this).
   */
  private scheduleReap(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    if (this.sessionGraceMs <= 0) { this.reapSession(sessionId); return; }
    this.cancelReap(sessionId);
    const timer = setTimeout(() => {
      this.reapTimers.delete(sessionId);
      this.reapSession(sessionId);
    }, this.sessionGraceMs);
    timer.unref?.();
    this.reapTimers.set(sessionId, timer);
  }

  private cancelReap(sessionId: string): void {
    const timer = this.reapTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reapTimers.delete(sessionId);
    }
  }

  /**
   * Periodic backstop: reap sessions that are idle with no writable standby
   * stream. Catches clients that abandoned a session without DELETE or a clean
   * stream close (the standby socket is half-open / already destroyed).
   */
  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      const standbyDead = !!session.standbyRes && (session.standbyRes.writableEnded || session.standbyRes.destroyed);
      const hasLiveStandby = !!session.standbyRes && !standbyDead;
      if (hasLiveStandby) continue; // genuinely connected — leave it alone
      if (standbyDead || now - session.lastActivityAt > this.idleTimeoutMs) {
        this.reapSession(sessionId);
      }
    }
  }

  private attachKeepAlive(sessionId: string, res: http.ServerResponse): void {
    if (this.keepAliveIntervalMs <= 0) return;
    const interval = setInterval(() => {
      if (res.writableEnded || res.destroyed) { clearInterval(interval); return; }
      // SSE comment lines (`:` prefix) are ignored by EventSource parsers; Node
      // `res.write` calls are discrete, so a comment lands between the
      // transport's events and never splits one. A throw means the standby
      // stream is dead — reap the session.
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(interval);
        this.reapSession(sessionId);
      }
    }, this.keepAliveIntervalMs);
    const stop = (): void => clearInterval(interval);
    res.on('close', stop);
    res.on('finish', stop);
  }
}

/**
 * Buffer and JSON-parse a request body. The StreamableHTTP transport can read
 * the raw stream itself, but to route by session and detect `initialize` we
 * have to consume the body first, then hand the parsed value to handleRequest.
 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) { resolve(undefined); return; }
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
