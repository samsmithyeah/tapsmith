import { describe, expect, it, vi } from 'vitest';
import { registerTapsmithReset, registeredHandlers, runResetPipeline } from '../reset.js';
import { hooksEnabledByDefault } from '../enabled.js';

describe('reset pipeline', () => {
  it('clears stores (clear or clearAll) before running handlers, in order', async () => {
    const order: string[] = [];
    const asyncStorage = { clear: vi.fn(async () => { order.push('async'); }) };
    const mmkv = { clearAll: vi.fn(() => { order.push('mmkv'); }) };
    const handler = vi.fn(async (req: { target: string }) => { order.push(`handler:${req.target}`); });

    await runResetPipeline({ target: '/login', nonce: 'n' }, [asyncStorage, mmkv], [handler]);

    expect(order).toEqual(['async', 'mmkv', 'handler:/login']);
  });

  it('propagates the first failure', async () => {
    const boom = { clear: vi.fn(async () => { throw new Error('boom'); }) };
    const handler = vi.fn();
    await expect(runResetPipeline({ target: '/', nonce: '' }, [boom], [handler])).rejects.toThrow('boom');
    expect(handler).not.toHaveBeenCalled();
  });

  it('registerTapsmithReset adds and removes handlers', () => {
    const h = vi.fn();
    const off = registerTapsmithReset(h);
    expect(registeredHandlers()).toContain(h);
    off();
    expect(registeredHandlers()).not.toContain(h);
  });
});

describe('enabled gate', () => {
  it('follows __DEV__ and the build-time flag', () => {
    const g = globalThis as { __DEV__?: boolean; process?: { env?: Record<string, string | undefined> } };
    const savedDev = g.__DEV__;
    const savedEnv = g.process?.env?.EXPO_PUBLIC_TAPSMITH_HOOKS;
    try {
      g.__DEV__ = false;
      if (g.process?.env) delete g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS;
      expect(hooksEnabledByDefault()).toBe(false);
      g.__DEV__ = true;
      expect(hooksEnabledByDefault()).toBe(true);
      g.__DEV__ = false;
      if (g.process?.env) g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS = '1';
      expect(hooksEnabledByDefault()).toBe(true);
    } finally {
      g.__DEV__ = savedDev;
      if (g.process?.env) {
        if (savedEnv === undefined) delete g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS;
        else g.process.env.EXPO_PUBLIC_TAPSMITH_HOOKS = savedEnv;
      }
    }
  });
});
