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

describe('coordinate gesture methods on TapsmithGrpcClient', () => {
  describe('tapXY', () => {
    it('calls tapCoordinates with x and y', async () => {
      const { instance, callSpy } = makeClientWithCallSpy();
      await instance.tapXY(12, 34);
      expect(callSpy).toHaveBeenCalledWith(
        'tapCoordinates',
        expect.objectContaining({ x: 12, y: 34, requestId: expect.any(String) }),
      );
    });
  });

  describe('longPressXY', () => {
    it('calls longPressCoordinates with x, y, and durationMs', async () => {
      const { instance, callSpy } = makeClientWithCallSpy();
      await instance.longPressXY(5, 6, 800);
      expect(callSpy).toHaveBeenCalledWith(
        'longPressCoordinates',
        expect.objectContaining({ x: 5, y: 6, durationMs: 800, requestId: expect.any(String) }),
      );
    });

    it('defaults durationMs to 0 when not provided', async () => {
      const { instance, callSpy } = makeClientWithCallSpy();
      await instance.longPressXY(5, 6);
      expect(callSpy).toHaveBeenCalledWith(
        'longPressCoordinates',
        expect.objectContaining({ x: 5, y: 6, durationMs: 0 }),
      );
    });
  });

  describe('dragXY', () => {
    it('calls dragCoordinates with fromX, fromY, toX, toY, and durationMs', async () => {
      const { instance, callSpy } = makeClientWithCallSpy();
      await instance.dragXY(1, 2, 3, 4, 250);
      expect(callSpy).toHaveBeenCalledWith(
        'dragCoordinates',
        expect.objectContaining({
          fromX: 1,
          fromY: 2,
          toX: 3,
          toY: 4,
          durationMs: 250,
          requestId: expect.any(String),
        }),
      );
    });

    it('defaults durationMs to 0 when not provided', async () => {
      const { instance, callSpy } = makeClientWithCallSpy();
      await instance.dragXY(1, 2, 3, 4);
      expect(callSpy).toHaveBeenCalledWith(
        'dragCoordinates',
        expect.objectContaining({ fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 0 }),
      );
    });
  });

  describe('inputText', () => {
    it('calls inputText with the given text', async () => {
      const { instance, callSpy } = makeClientWithCallSpy();
      await instance.inputText('hi');
      expect(callSpy).toHaveBeenCalledWith(
        'inputText',
        expect.objectContaining({ text: 'hi', requestId: expect.any(String) }),
      );
    });
  });
});
