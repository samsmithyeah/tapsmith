/**
 * WebSocket connection hook for UI mode.
 *
 * Manages the WebSocket connection to the UI server, handles reconnection,
 * and dispatches incoming messages to the appropriate state handlers.
 */

import { useEffect, useRef, useCallback } from 'preact/hooks';
import type { ServerMessage, ClientMessage } from '../ui-protocol.js';

export interface UseWebSocketOptions {
  onMessage: (msg: ServerMessage) => void
  onBinaryMessage: (data: ArrayBuffer) => void
  onConnectionChange: (connected: boolean) => void
}

export function useWebSocket(options: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let ws: WebSocket;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}`);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        optionsRef.current.onConnectionChange(true);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          optionsRef.current.onBinaryMessage(event.data);
        } else {
          try {
            const msg: ServerMessage = JSON.parse(event.data);
            optionsRef.current.onMessage(msg);
          } catch {
            // Ignore malformed messages
          }
        }
      };

      ws.onclose = () => {
        optionsRef.current.onConnectionChange(false);
        wsRef.current = null;
        // Reconnect after a short delay
        reconnectTimer = setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { send };
}
