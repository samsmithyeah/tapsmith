import { describe, it, expect, vi } from 'vitest';
import { TapsmithGrpcClient } from '../grpc-client.js';

// ─── Helpers ───

/**
 * Creates a TapsmithGrpcClient instance that bypasses the constructor
 * (which requires a live gRPC connection) and replaces the private `call`
 * method with a recording spy.
 */
function makeClientWithCallSpy() {
  const instance = Object.create(TapsmithGrpcClient.prototype) as TapsmithGrpcClient;
  const callSpy = vi.fn().mockResolvedValue({ requestId: 'mock', success: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
  ;(instance as any).call = callSpy;
  return { instance, callSpy };
}

// ─── Tests ───

describe('touch stream (grpc-client)', () => {
  it('touchDown → touchDown rpc with x/y/tMs', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchDown(10, 20);
    expect(callSpy).toHaveBeenCalledWith(
      'touchDown',
      expect.objectContaining({ x: 10, y: 20, tMs: 0, requestId: expect.any(String) }),
    );
  });

  it('touchDown → uses provided tMs', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchDown(10, 20, 100);
    expect(callSpy).toHaveBeenCalledWith(
      'touchDown',
      expect.objectContaining({ x: 10, y: 20, tMs: 100 }),
    );
  });

  it('touchMove → touchMove rpc with tMs', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchMove(1, 2, 50);
    expect(callSpy).toHaveBeenCalledWith(
      'touchMove',
      expect.objectContaining({ x: 1, y: 2, tMs: 50, requestId: expect.any(String) }),
    );
  });

  it('touchMove → defaults tMs to 0', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchMove(1, 2);
    expect(callSpy).toHaveBeenCalledWith(
      'touchMove',
      expect.objectContaining({ x: 1, y: 2, tMs: 0 }),
    );
  });

  it('touchUp → touchUp rpc', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchUp(3, 4, 120);
    expect(callSpy).toHaveBeenCalledWith(
      'touchUp',
      expect.objectContaining({ x: 3, y: 4, tMs: 120, requestId: expect.any(String) }),
    );
  });

  it('touchUp → defaults tMs to 0', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchUp(3, 4);
    expect(callSpy).toHaveBeenCalledWith(
      'touchUp',
      expect.objectContaining({ x: 3, y: 4, tMs: 0 }),
    );
  });

  it('touchCancel → touchCancel rpc', async () => {
    const { instance, callSpy } = makeClientWithCallSpy();
    await instance.touchCancel();
    expect(callSpy).toHaveBeenCalledWith(
      'touchCancel',
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });
});
