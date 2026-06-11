import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { TestAbortedError, isAbortError, sleep, throwIfAborted } from '../abort.js';

// ─── Abort primitives ───

describe('abort primitives', () => {
  it('isAbortError matches TestAbortedError via brand, not instanceof', () => {
    const err = new TestAbortedError();
    expect(isAbortError(err)).toBe(true);
    expect(err.message).toBe('Stopped by user');
    expect(err.name).toBe('AbortError');
    expect(isAbortError(new Error('Stopped by user'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });

  it('throwIfAborted throws only when the signal has fired', () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    ac.abort();
    expect(() => throwIfAborted(ac.signal)).toThrow(TestAbortedError);
  });

  it('sleep resolves normally without a signal', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it('sleep rejects with a branded AbortError when the signal fires mid-sleep', async () => {
    const ac = new AbortController();
    const p = sleep(60_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('sleep rejects immediately on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(60_000, ac.signal)).rejects.toSatisfy(isAbortError);
  });

  it('sleep removes its abort listener after a natural completion', async () => {
    const ac = new AbortController();
    await sleep(1, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});

// ─── gRPC call cancellation (PILOT-222) ───

type UnaryCallback = (err: Error | null, response?: unknown) => void;
type FakeMethod = (req: unknown, opts: unknown, cb: UnaryCallback) => { cancel: () => void };

function makeClient(fakeMethod: FakeMethod): TapsmithGrpcClient {
  const client = new TapsmithGrpcClient('localhost:1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swap the private proto-loaded client for a fake
  (client as any).client = { fakeMethod };
  return client;
}

function invokeCall(client: TapsmithGrpcClient): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercise the private unary-call wrapper directly
  return (client as any).call('fakeMethod', {});
}

describe('TapsmithGrpcClient abort signal', () => {
  it('cancels the in-flight call and rejects with a branded AbortError', async () => {
    let savedCb: UnaryCallback | undefined;
    const cancel = vi.fn(() => {
      // Mirror @grpc/grpc-js: cancel surfaces as a CANCELLED callback error.
      savedCb?.(Object.assign(new Error('1 CANCELLED: Cancelled on client'), { code: 1 }));
    });
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client);
    ac.abort();

    await expect(p).rejects.toSatisfy(isAbortError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when the signal is already aborted, without dispatching', async () => {
    const fakeMethod = vi.fn();
    const client = makeClient(fakeMethod as unknown as FakeMethod);

    const ac = new AbortController();
    ac.abort();
    client._setAbortSignal(ac.signal);

    await expect(invokeCall(client)).rejects.toSatisfy(isAbortError);
    expect(fakeMethod).not.toHaveBeenCalled();
  });

  it('normalizes any post-abort error to AbortError', async () => {
    let savedCb: UnaryCallback | undefined;
    const client = makeClient((_req, _opts, cb) => {
      savedCb = cb;
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    const p = invokeCall(client);
    ac.abort();
    // The transport reports an unrelated-looking error after cancellation.
    savedCb?.(Object.assign(new Error('14 UNAVAILABLE: connection dropped'), { code: 14 }));

    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('removes the abort listener once the call settles normally', async () => {
    const client = makeClient((_req, _opts, cb) => {
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });

    const ac = new AbortController();
    client._setAbortSignal(ac.signal);
    for (let i = 0; i < 5; i++) {
      await invokeCall(client);
    }
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('does not interfere with calls when no signal is set', async () => {
    const client = makeClient((_req, _opts, cb) => {
      queueMicrotask(() => cb(null, { ok: true }));
      return { cancel: vi.fn() };
    });
    await expect(invokeCall(client)).resolves.toEqual({ ok: true });
  });
});
