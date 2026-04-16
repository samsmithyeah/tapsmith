import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { APIRequestContext, PilotAPIResponse } from '../api-request.js';
import { setActiveTraceCollector } from '../trace/trace-collector.js';

// ─── Local test server ───

let server: http.Server;
let baseURL: string;

function createTestServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;

    // Collect request body
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();

      if (path === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body || null,
        }));
      } else if (path === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 1, name: 'Test' }));
      } else if (path === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Hello World');
      } else if (path === '/status/201') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
      } else if (path === '/status/404') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } else if (path === '/status/500') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal Server Error');
      } else if (path === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('done');
        }, 2000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
}

beforeAll(async () => {
  server = createTestServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── Tests ───

describe('APIRequestContext', () => {
  describe('HTTP methods', () => {
    it('sends GET request', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/echo');
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      const body = await res.json() as { method: string };
      expect(body.method).toBe('GET');
    });

    it('sends POST request', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.post('/echo', { data: { key: 'value' } });
      const body = await res.json() as { method: string; body: string };
      expect(body.method).toBe('POST');
      expect(JSON.parse(body.body)).toEqual({ key: 'value' });
    });

    it('sends PUT request', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.put('/echo');
      const body = await res.json() as { method: string };
      expect(body.method).toBe('PUT');
    });

    it('sends PATCH request', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.patch('/echo');
      const body = await res.json() as { method: string };
      expect(body.method).toBe('PATCH');
    });

    it('sends DELETE request', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.delete('/echo');
      const body = await res.json() as { method: string };
      expect(body.method).toBe('DELETE');
    });

    it('sends HEAD request', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.head('/echo');
      expect(res.status).toBe(200);
      // HEAD responses have no body
      expect((await res.body()).length).toBe(0);
    });

    it('supports fetch() with explicit method', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.fetch('/echo', { method: 'PATCH' });
      const body = await res.json() as { method: string };
      expect(body.method).toBe('PATCH');
    });
  });

  describe('URL resolution', () => {
    it('resolves relative paths against baseURL', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/json');
      expect(res.ok).toBe(true);
    });

    it('resolves paths without leading slash', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('json');
      expect(res.ok).toBe(true);
    });

    it('uses absolute URLs as-is, ignoring baseURL', async () => {
      const ctx = new APIRequestContext({ baseURL: 'http://should-not-use.invalid' });
      const res = await ctx.get(`${baseURL}/json`);
      expect(res.ok).toBe(true);
    });

    it('handles baseURL without trailing slash', async () => {
      const ctx = new APIRequestContext({ baseURL: baseURL });
      const res = await ctx.get('/json');
      expect(res.ok).toBe(true);
    });

    it('handles baseURL with trailing slash', async () => {
      const ctx = new APIRequestContext({ baseURL: baseURL + '/' });
      const res = await ctx.get('/json');
      expect(res.ok).toBe(true);
    });

    it('appends query params', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/echo', { params: { foo: 'bar', baz: '42' } });
      const body = await res.json() as { url: string };
      expect(body.url).toContain('foo=bar');
      expect(body.url).toContain('baz=42');
    });

    it('appends URLSearchParams', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const params = new URLSearchParams([['key', 'val']]);
      const res = await ctx.get('/echo', { params });
      const body = await res.json() as { url: string };
      expect(body.url).toContain('key=val');
    });
  });

  describe('body serialization', () => {
    it('JSON-serializes object data and sets Content-Type', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.post('/echo', { data: { name: 'test' } });
      const body = await res.json() as { headers: Record<string, string>; body: string };
      expect(body.headers['content-type']).toBe('application/json');
      expect(JSON.parse(body.body)).toEqual({ name: 'test' });
    });

    it('sends string data as-is', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.post('/echo', { data: 'raw text' });
      const body = await res.json() as { body: string };
      expect(body.body).toBe('raw text');
    });

    it('sends form-encoded body', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.post('/echo', { form: { username: 'admin', password: 'secret' } });
      const body = await res.json() as { headers: Record<string, string>; body: string };
      expect(body.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(body.body).toContain('username=admin');
      expect(body.body).toContain('password=secret');
    });
  });

  describe('header merging', () => {
    it('sends extraHTTPHeaders', async () => {
      const ctx = new APIRequestContext({
        baseURL,
        extraHTTPHeaders: { 'x-custom': 'global' },
      });
      const res = await ctx.get('/echo');
      const body = await res.json() as { headers: Record<string, string> };
      expect(body.headers['x-custom']).toBe('global');
    });

    it('per-request headers override extraHTTPHeaders', async () => {
      const ctx = new APIRequestContext({
        baseURL,
        extraHTTPHeaders: { 'x-custom': 'global' },
      });
      const res = await ctx.get('/echo', { headers: { 'x-custom': 'local' } });
      const body = await res.json() as { headers: Record<string, string> };
      expect(body.headers['x-custom']).toBe('local');
    });
  });

  describe('response', () => {
    it('returns status and statusText', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/status/201');
      expect(res.status).toBe(201);
      expect(res.ok).toBe(true);
    });

    it('parses JSON response', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/json');
      const data = await res.json() as { id: number; name: string };
      expect(data).toEqual({ id: 1, name: 'Test' });
    });

    it('returns text response', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/text');
      expect(await res.text()).toBe('Hello World');
    });

    it('returns raw buffer', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/text');
      const buf = await res.body();
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString()).toBe('Hello World');
    });

    it('body can be read multiple times', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/json');
      const json1 = await res.json();
      const json2 = await res.json();
      const text = await res.text();
      expect(json1).toEqual(json2);
      expect(text).toBe(JSON.stringify({ id: 1, name: 'Test' }));
    });

    it('does not throw on 4xx', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/status/404');
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });

    it('does not throw on 5xx', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/status/500');
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
    });

    it('headersObject returns flat record', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const res = await ctx.get('/json');
      const headers = res.headersObject();
      expect(typeof headers['content-type']).toBe('string');
      expect(headers['content-type']).toContain('application/json');
    });
  });

  describe('timeout', () => {
    it('aborts request on timeout', async () => {
      const ctx = new APIRequestContext({ baseURL });
      await expect(ctx.get('/slow', { timeout: 50 })).rejects.toThrow();
    });
  });

  describe('dispose', () => {
    it('aborts in-flight requests', async () => {
      const ctx = new APIRequestContext({ baseURL });
      const promise = ctx.get('/slow');
      ctx.dispose();
      await expect(promise).rejects.toThrow();
    });
  });

  describe('trace integration', () => {
    let mockCollector: {
      addActionEvent: ReturnType<typeof vi.fn>
      currentActionIndex: number
    };

    beforeEach(() => {
      mockCollector = {
        addActionEvent: vi.fn(() => {
          mockCollector.currentActionIndex++;
        }),
        currentActionIndex: 0,
      };
    });

    afterAll(() => {
      setActiveTraceCollector(null);
    });

    it('emits action event when tracing is active', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock collector for test
      setActiveTraceCollector(mockCollector as any);
      const ctx = new APIRequestContext({ baseURL });
      await ctx.get('/json');

      expect(mockCollector.addActionEvent).toHaveBeenCalledOnce();
      const event = mockCollector.addActionEvent.mock.calls[0][0];
      expect(event.category).toBe('api');
      expect(event.action).toBe('request.get');
      expect(event.success).toBe(true);
      expect(event.hasScreenshotBefore).toBe(false);
      expect(event.hasScreenshotAfter).toBe(false);
      expect(event.log).toHaveLength(2);
      expect(event.log[0]).toContain('GET');

      setActiveTraceCollector(null);
    });

    it('records non-ok response as unsuccessful in trace', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock collector for test
      setActiveTraceCollector(mockCollector as any);
      const ctx = new APIRequestContext({ baseURL });
      await ctx.get('/status/500');

      const event = mockCollector.addActionEvent.mock.calls[0][0];
      expect(event.success).toBe(false);
      expect(event.error).toContain('500');

      setActiveTraceCollector(null);
    });

    it('accumulates network entries', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock collector for test
      setActiveTraceCollector(mockCollector as any);
      const ctx = new APIRequestContext({ baseURL });
      await ctx.get('/json');
      await ctx.post('/echo', { data: { test: true } });

      const entries = ctx.getNetworkEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].method).toBe('GET');
      expect(entries[0].index).toBe(0);
      expect(entries[1].method).toBe('POST');
      expect(entries[1].index).toBe(1);
      expect(entries[1].requestBody).toBeDefined();

      setActiveTraceCollector(null);
    });

    it('does not emit trace events when no collector is active', async () => {
      setActiveTraceCollector(null);
      const ctx = new APIRequestContext({ baseURL });
      await ctx.get('/json');
      expect(ctx.getNetworkEntries()).toHaveLength(0);
    });
  });
});

describe('PilotAPIResponse', () => {
  it('constructs with correct properties', () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    const res = new PilotAPIResponse(200, 'OK', true, 'http://example.com', headers, Buffer.from('hello'));
    expect(res.status).toBe(200);
    expect(res.statusText).toBe('OK');
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://example.com');
  });

  it('dispose is callable', () => {
    const res = new PilotAPIResponse(200, 'OK', true, '', new Headers(), Buffer.alloc(0));
    expect(() => res.dispose()).not.toThrow();
  });
});
