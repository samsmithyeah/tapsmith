import { describe, it, expect, vi } from 'vitest';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { Device } from '../device.js';
import type { ActionResponse } from '../grpc-client.js';

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

// ─── Device-level coordinate API ───

function successResponse(): ActionResponse {
  return {
    requestId: '1',
    success: true,
    errorType: '',
    errorMessage: '',
    screenshot: Buffer.alloc(0),
  };
}

function makeDeviceMockClient(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  const base = {
    tapXY: vi.fn(async () => successResponse()),
    longPressXY: vi.fn(async () => successResponse()),
    dragXY: vi.fn(async () => successResponse()),
    inputText: vi.fn(async () => successResponse()),
    swipe: vi.fn(async () => successResponse()),
    pressKey: vi.fn(async () => successResponse()),
    takeScreenshot: vi.fn(async () => ({ requestId: '1', success: true, data: Buffer.alloc(0), errorMessage: '' })),
    getUiHierarchy: vi.fn(async () => ({ requestId: '1', hierarchyXml: '<hierarchy />', errorMessage: '' })),
    findElement: vi.fn(async () => ({ requestId: '1', found: false, errorMessage: '' })),
    waitForIdle: vi.fn(async () => successResponse()),
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub for Device constructor
  return base as any;
}

describe('coordinate gestures (device)', () => {
  it('tapXY delegates to client.tapXY with x and y', async () => {
    const tapXY = vi.fn(async () => successResponse());
    const client = makeDeviceMockClient({ tapXY });
    const device = new Device(client);
    await device.tapXY(10, 20);
    expect(tapXY).toHaveBeenCalledWith(10, 20);
  });

  it('longPressXY delegates to client.longPressXY with x, y, and duration', async () => {
    const longPressXY = vi.fn(async () => successResponse());
    const client = makeDeviceMockClient({ longPressXY });
    const device = new Device(client);
    await device.longPressXY(10, 20, { duration: 800 });
    expect(longPressXY).toHaveBeenCalledWith(10, 20, 800);
  });

  it('dragXY delegates to client.dragXY with from/to coords and duration', async () => {
    const dragXY = vi.fn(async () => successResponse());
    const client = makeDeviceMockClient({ dragXY });
    const device = new Device(client);
    await device.dragXY({ x: 1, y: 2 }, { x: 3, y: 4 }, { duration: 250 });
    expect(dragXY).toHaveBeenCalledWith(1, 2, 3, 4, 250);
  });

  it('inputText delegates to client.inputText with text', async () => {
    const inputText = vi.fn(async () => successResponse());
    const client = makeDeviceMockClient({ inputText });
    const device = new Device(client);
    await device.inputText('hi');
    expect(inputText).toHaveBeenCalledWith('hi');
  });
});
