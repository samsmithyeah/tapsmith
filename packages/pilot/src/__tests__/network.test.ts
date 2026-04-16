import { describe, expect, it } from 'vitest';
import {
  PilotRequest, Route, FetchedAPIResponse, matchUrlPattern, patternsEqual,
} from '../network.js';

// ─── matchUrlPattern (glob matching) ───

describe('matchUrlPattern', () => {
  describe('string glob patterns', () => {
    it('matches exact URL', () => {
      expect(matchUrlPattern('https://example.com/api/posts', 'https://example.com/api/posts')).toBe(true);
    });

    it('does not match different URL', () => {
      expect(matchUrlPattern('https://example.com/api/users', 'https://example.com/api/posts')).toBe(false);
    });

    it('single * matches within a path segment', () => {
      expect(matchUrlPattern('https://example.com/api/posts', 'https://example.com/api/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/users', 'https://example.com/api/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/posts/1', 'https://example.com/api/*')).toBe(false);
    });

    it('** matches across path segments', () => {
      expect(matchUrlPattern('https://example.com/api/posts', '**/api/**')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/posts/1', '**/api/**')).toBe(true);
      expect(matchUrlPattern('http://localhost:3000/api/v2/users', '**/api/**')).toBe(true);
      expect(matchUrlPattern('https://example.com/other', '**/api/**')).toBe(false);
    });

    it('** prefix matches any host', () => {
      expect(matchUrlPattern('https://jsonplaceholder.typicode.com/posts', '**/posts*')).toBe(true);
      expect(matchUrlPattern('https://jsonplaceholder.typicode.com/posts?_limit=3', '**/posts*')).toBe(true);
      expect(matchUrlPattern('https://jsonplaceholder.typicode.com/users/1', '**/posts*')).toBe(false);
    });

    it('** requires a / separator (does not match example.comapi for **/api)', () => {
      // Regression: the optional-slash form `.*(?:/)?api` let `**/api` match
      // `example.comapi` (no separator). The separator is now required.
      expect(matchUrlPattern('https://example.com/api', '**/api')).toBe(true);
      expect(matchUrlPattern('https://example.comapi', '**/api')).toBe(false);
      expect(matchUrlPattern('https://example.com/api/posts', '**/api/**')).toBe(true);
      expect(matchUrlPattern('https://example.comapi/posts', '**/api/**')).toBe(false);
    });

    it('{a,b} matches alternatives', () => {
      expect(matchUrlPattern('https://example.com/api/posts', 'https://example.com/{api,v2}/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/v2/posts', 'https://example.com/{api,v2}/*')).toBe(true);
      expect(matchUrlPattern('https://example.com/other/posts', 'https://example.com/{api,v2}/*')).toBe(false);
    });

    it('? matches single character', () => {
      expect(matchUrlPattern('https://example.com/api/v1/posts', 'https://example.com/api/v?/posts')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/v2/posts', 'https://example.com/api/v?/posts')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/v12/posts', 'https://example.com/api/v?/posts')).toBe(false);
    });
  });

  describe('RegExp patterns', () => {
    it('matches with regex', () => {
      expect(matchUrlPattern('https://example.com/api/posts', /\/api\/posts/)).toBe(true);
      expect(matchUrlPattern('https://example.com/api/users', /\/api\/posts/)).toBe(false);
    });
  });

  describe('predicate patterns', () => {
    it('matches with predicate function', () => {
      expect(matchUrlPattern('https://example.com/api/posts', (url) => url.pathname === '/api/posts')).toBe(true);
      expect(matchUrlPattern('https://example.com/api/users', (url) => url.pathname === '/api/posts')).toBe(false);
    });
  });
});

// ─── patternsEqual (removeRoute support) ───

describe('patternsEqual', () => {
  it('compares strings by value', () => {
    expect(patternsEqual('**/api', '**/api')).toBe(true);
    expect(patternsEqual('**/api', '**/users')).toBe(false);
  });

  it('compares RegExps by source AND flags (not reference)', () => {
    expect(patternsEqual(/foo/, /foo/)).toBe(true);
    expect(patternsEqual(/foo/i, /foo/i)).toBe(true);
    expect(patternsEqual(/foo/, /foo/i)).toBe(false);       // different flags
    expect(patternsEqual(/foo/, /bar/)).toBe(false);         // different source
  });

  it('compares predicates by reference', () => {
    const a = (u: URL) => u.pathname === '/a';
    const b = (u: URL) => u.pathname === '/a';              // structurally identical, different ref
    expect(patternsEqual(a, a)).toBe(true);
    expect(patternsEqual(a, b)).toBe(false);
  });

  it('does not match across different pattern types', () => {
    expect(patternsEqual('**/api', /api/)).toBe(false);
    expect(patternsEqual(/api/, (u) => u.pathname === '/api')).toBe(false);
  });
});

// ─── PilotRequest ───

describe('PilotRequest', () => {
  it('constructs with correct properties', () => {
    const req = new PilotRequest({
      method: 'POST',
      url: 'https://example.com/api/posts',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: 'Bearer token' },
      ],
      body: Buffer.from('{"title":"test"}'),
      isHttps: true,
    });

    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://example.com/api/posts');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['authorization']).toBe('Bearer token');
    expect(req.postData?.toString()).toBe('{"title":"test"}');
    expect(req.isHttps).toBe(true);
  });

  it('lowercases header names', () => {
    const req = new PilotRequest({
      method: 'GET',
      url: 'https://example.com',
      headers: [{ name: 'X-Custom-Header', value: 'value' }],
      body: null,
      isHttps: true,
    });
    expect(req.headers['x-custom-header']).toBe('value');
  });

  it('sets postData to null for empty body', () => {
    const req = new PilotRequest({
      method: 'GET',
      url: 'https://example.com',
      headers: [],
      body: Buffer.alloc(0),
      isHttps: false,
    });
    expect(req.postData).toBeNull();
  });
});

// ─── FetchedAPIResponse ───

describe('FetchedAPIResponse', () => {
  it('parses JSON body', () => {
    const resp = new FetchedAPIResponse(
      200,
      { 'content-type': 'application/json' },
      Buffer.from('{"id":1,"name":"Test"}'),
    );
    expect(resp.status).toBe(200);
    expect(resp.json()).toEqual({ id: 1, name: 'Test' });
    expect(resp.text()).toBe('{"id":1,"name":"Test"}');
    expect(resp.body()).toEqual(Buffer.from('{"id":1,"name":"Test"}'));
  });
});

// ─── Route ───

describe('Route', () => {
  function makeRoute() {
    const decisions: unknown[] = [];
    const sendDecision = (d: unknown) => { decisions.push(d); };
    const awaitFetched = () => Promise.resolve({
      interceptId: 'test-id',
      status: 200,
      headers: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from('{"original":true}'),
    });
    const request = new PilotRequest({
      method: 'GET',
      url: 'https://example.com/api/posts',
      headers: [],
      body: null,
      isHttps: true,
    });
    const route = new Route('intercept-1', request, sendDecision, awaitFetched);
    return { route, decisions, request };
  }

  it('abort sends abort decision', async () => {
    const { route, decisions } = makeRoute();
    await route.abort('connectionrefused');
    expect(decisions).toHaveLength(1);
    expect((decisions[0] as Record<string, unknown>).abort).toEqual({ errorCode: 'connectionrefused' });
  });

  it('continue sends continue decision with overrides', async () => {
    const { route, decisions } = makeRoute();
    await route.continue({ url: 'https://other.com/api', method: 'POST' });
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as Record<string, unknown>;
    expect((d.continueRequest as Record<string, unknown>).url).toBe('https://other.com/api');
    expect((d.continueRequest as Record<string, unknown>).method).toBe('POST');
  });

  it('fulfill sends fulfill decision with JSON body', async () => {
    const { route, decisions } = makeRoute();
    await route.fulfill({ json: { id: 1 }, status: 201 });
    expect(decisions).toHaveLength(1);
    const d = decisions[0] as Record<string, unknown>;
    const f = d.fulfill as Record<string, unknown>;
    expect(f.status).toBe(201);
    expect(f.contentType).toBe('application/json');
    expect(Buffer.from(f.body as Buffer).toString()).toBe('{"id":1}');
  });

  it('fulfill sends fulfill decision with string body', async () => {
    const { route, decisions } = makeRoute();
    await route.fulfill({ body: 'hello', contentType: 'text/plain', status: 200 });
    const f = (decisions[0] as Record<string, unknown>).fulfill as Record<string, unknown>;
    expect(Buffer.from(f.body as Buffer).toString()).toBe('hello');
    expect(f.contentType).toBe('text/plain');
  });

  it('throws if resolved twice', async () => {
    const { route } = makeRoute();
    await route.abort();
    await expect(route.abort()).rejects.toThrow('Route has already been handled');
  });

  it('request() returns the intercepted request', () => {
    const { route, request } = makeRoute();
    expect(route.request()).toBe(request);
    expect(route.request().url).toBe('https://example.com/api/posts');
  });

  it('throws if abort() is called after fetch()', async () => {
    const { route } = makeRoute();
    await route.fetch();
    await expect(route.abort()).rejects.toThrow(/After route\.fetch\(\), only route\.fulfill\(\)/);
  });

  it('throws if continue() is called after fetch()', async () => {
    const { route } = makeRoute();
    await route.fetch();
    await expect(route.continue()).rejects.toThrow(/After route\.fetch\(\), only route\.fulfill\(\)/);
  });

  it('force-resolves the route when fetch() rejects (no stale continue fail-open)', async () => {
    // When the daemon rejects the fetched-response promise (upstream-fail
    // sentinel or stream drop), route.fetch() throws and marks the route
    // resolved — so the handler's .catch path sees _isResolved=true and
    // skips the spurious continueRequest send.
    const decisions: unknown[] = [];
    const sendDecision = (d: unknown) => { decisions.push(d); };
    const awaitFetched = () => Promise.reject(new Error('upstream failed'));
    const request = new PilotRequest({
      method: 'GET',
      url: 'https://example.com/api',
      headers: [],
      body: null,
      isHttps: true,
    });
    const route = new Route('intercept-err', request, sendDecision, awaitFetched);

    await expect(route.fetch()).rejects.toThrow('upstream failed');
    expect(route._isResolved()).toBe(true);
  });

  it('fetch sends fetch then fulfillAfterFetch on subsequent fulfill', async () => {
    const { route, decisions } = makeRoute();
    const resp = await route.fetch();
    expect(resp.status).toBe(200);
    expect(resp.json()).toEqual({ original: true });

    // First decision is the fetch
    expect(decisions).toHaveLength(1);
    expect((decisions[0] as Record<string, unknown>).fetch).toBeDefined();

    // Now fulfill with modified data — should send fulfillAfterFetch
    await route.fulfill({ json: { modified: true } });
    expect(decisions).toHaveLength(2);
    expect((decisions[1] as Record<string, unknown>).fulfillAfterFetch).toBeDefined();
    const body = (decisions[1] as Record<string, Record<string, unknown>>).fulfillAfterFetch.body as Buffer;
    expect(Buffer.from(body).toString()).toBe('{"modified":true}');
  });
});
