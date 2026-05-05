import http from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { WebViewHandle } from '../webview-handle.js';

describe('WebViewHandle', () => {
  let server: http.Server | undefined;
  const sockets = new Set<Duplex>();

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
  });

  it('times out a CDP WebSocket handshake that never completes', async () => {
    let port = 0;
    server = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{
          id: 'page-1',
          title: 'Test page',
          url: 'about:blank',
          type: 'page',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
        }]));
        return;
      }
      res.writeHead(404).end();
    });
    server.on('upgrade', (_req, socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // Keep the socket open without sending a 101 response. This mirrors
      // the CI failure mode where the forwarded DevTools endpoint accepts
      // the TCP connection but never completes the WebSocket handshake.
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server!.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server!.off('error', onError);
        resolve();
      };
      server!.once('error', onError);
      server!.once('listening', onListening);
      server!.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    port = address.port;

    const handle = new WebViewHandle({} as TapsmithGrpcClient, port, 200);
    const started = Date.now();

    await expect(handle._connect()).rejects.toThrow(/WebSocket.*timed out|Opening handshake has timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
