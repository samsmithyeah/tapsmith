import { describe, it, expect } from 'vitest';
import { encodeScreenFrame, encodeVideoFrame, decodeBinaryFrame } from '../ui-mode/ui-protocol.js';

function toArrayBuffer(b: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

describe('binary frame protocol', () => {
  it('round-trips a video frame with flags + workerId', () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]);
    const buf = encodeVideoFrame(2, true, true, Buffer.from(payload));
    const decoded = decodeBinaryFrame(toArrayBuffer(buf));
    expect(decoded.kind).toBe('video');
    if (decoded.kind !== 'video') throw new Error('wrong kind');
    expect(decoded.workerId).toBe(2);
    expect(decoded.keyframe).toBe(true);
    expect(decoded.config).toBe(true);
    expect(new Uint8Array(decoded.payload)).toEqual(payload);
  });

  it('classifies and decodes a screenshot (kind 0) frame', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const buf = encodeScreenFrame(7, 1, 100, 200, png);
    const decoded = decodeBinaryFrame(toArrayBuffer(buf));
    expect(decoded.kind).toBe('screenshot');
    if (decoded.kind !== 'screenshot') throw new Error('wrong kind');
    expect(decoded.seq).toBe(7);
    expect(decoded.workerId).toBe(1);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(200);
    expect(new Uint8Array(toArrayBuffer(buf).slice(decoded.pngOffset))).toEqual(new Uint8Array(png));
  });
});
