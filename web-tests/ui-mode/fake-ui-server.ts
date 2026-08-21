// Stands in for `ui-server.ts` on the wire.
//
// UI mode's SPA has exactly two inputs: one WebSocket, and two download-only
// HTTP routes (`/trace/`, `/video/`). So the whole app can be driven from the
// test process — no device, no daemon, no gRPC — by speaking `ui-protocol.ts`
// over an intercepted socket.
//
// Interception is Playwright's own `page.routeWebSocket()`. Because
// `connectToServer()` is never called, nothing reaches a real socket: the route
// IS the server.

import type { Page, WebSocketRoute } from "@playwright/test"
import { encodeScreenFrame } from "../protocol.js"
import type { ClientMessage, ServerMessage } from "../protocol.js"

export interface ScreenFrame {
  width: number
  height: number
  png: Buffer
  /** Defaults to an auto-incrementing counter — the SPA drops out-of-order frames. */
  seq?: number
  /** 0 in single-worker mode, which is the default the SPA assumes. */
  workerId?: number
}

export class FakeUiServer {
  /** Every message the SPA has sent, in order, across all connections. */
  readonly received: ClientMessage[] = []

  private route: WebSocketRoute | null = null
  private seedMessages: ServerMessage[] = []
  private connectCount = 0
  private frameSeq = 0
  private connectListeners: Array<(n: number) => void> = []

  constructor(private page: Page) {}

  /** Number of sockets the SPA has opened (initial load, reconnects, reloads). */
  get connections() {
    return this.connectCount
  }

  /** True while a socket is open and messages can be delivered. */
  get connected() {
    return this.route !== null
  }

  /**
   * Register the interception. Must run before the page navigates, or the SPA's
   * socket escapes the route.
   */
  async install() {
    await this.page.routeWebSocket(/^wss?:\/\//, (ws) => {
      this.route = ws
      this.connectCount++

      ws.onMessage((raw) => {
        // The SPA only ever sends JSON text frames.
        if (typeof raw !== "string") return
        try {
          this.received.push(JSON.parse(raw) as ClientMessage)
        } catch {
          // Malformed frames aren't something the SPA can produce; ignoring one
          // keeps a harness bug from masquerading as a product failure.
        }
      })

      ws.onClose(() => {
        if (this.route === ws) this.route = null
      })

      // The real server pushes the tree and current run state the moment a
      // client connects, and again on every reconnect. Replaying the seed here
      // reproduces that, so reconnect specs get the same rehydration a user
      // would see.
      for (const msg of this.seedMessages) this.sendVia(ws, msg)

      for (const listener of this.connectListeners) listener(this.connectCount)
    })
  }

  /**
   * Messages replayed on every connection, including reconnects. Mirrors the
   * real server's connect-time push.
   */
  seed(messages: ServerMessage[]) {
    this.seedMessages = messages
  }

  /** Push a message to the SPA. */
  send(...messages: ServerMessage[]) {
    const ws = this.requireRoute()
    for (const msg of messages) this.sendVia(ws, msg)
  }

  /** Push a binary screen-mirror frame, framed by the production encoder. */
  sendFrame(frame: ScreenFrame) {
    const ws = this.requireRoute()
    ws.send(
      encodeScreenFrame(
        frame.seq ?? ++this.frameSeq,
        frame.workerId ?? 0,
        frame.width,
        frame.height,
        frame.png,
      ),
    )
  }

  /** Close the socket from the server side, exercising the SPA's 1s reconnect. */
  drop(options: { code?: number; reason?: string } = {}) {
    this.route?.close(options)
    this.route = null
  }

  /** Run a callback on each new connection — useful for per-connection state. */
  onConnect(listener: (connectionCount: number) => void) {
    this.connectListeners.push(listener)
  }

  /** Messages of one type the SPA has sent, narrowed to that variant. */
  messagesOfType<T extends ClientMessage["type"]>(type: T) {
    return this.received.filter(
      (m): m is Extract<ClientMessage, { type: T }> => m.type === type,
    )
  }

  /**
   * Resolve once the SPA has sent a message of this type, returning the first
   * such message. Polls rather than hooking a promise so it composes with
   * Playwright's own timeout handling.
   */
  async waitForMessage<T extends ClientMessage["type"]>(
    type: T,
    options: { timeout?: number } = {},
  ): Promise<Extract<ClientMessage, { type: T }>> {
    const timeout = options.timeout ?? 5000
    const deadline = Date.now() + timeout
    for (;;) {
      const found = this.messagesOfType(type)[0]
      if (found) return found
      if (Date.now() > deadline) {
        const seen = this.received.map((m) => m.type).join(", ") || "none"
        throw new Error(
          `Timed out after ${timeout}ms waiting for a "${type}" message. Received: ${seen}`,
        )
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /** Forget recorded messages — for asserting on a single interaction. */
  clearReceived() {
    this.received.length = 0
  }

  private sendVia(ws: WebSocketRoute, msg: ServerMessage) {
    ws.send(JSON.stringify(msg))
  }

  private requireRoute(): WebSocketRoute {
    if (!this.route) {
      throw new Error(
        "No WebSocket is open. The SPA connects on mount — await the pane to " +
          "render (or the reconnect) before sending.",
      )
    }
    return this.route
  }
}
