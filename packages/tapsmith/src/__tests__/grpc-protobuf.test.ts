import { describe, expect, it } from 'vitest';
import {
  decodeBodyForDisplay,
  decodeGrpcFrames,
  decodeProtobuf,
  formatProtobuf,
  isProtobufContentType,
} from '../trace/grpc-protobuf.js';

// ─── Wire-format builders ───
// Fixtures are built rather than captured. Real Firestore bodies carry account
// data (emails, display names, document contents), which has no business in the
// repo; synthesised bytes also let each test state exactly which wire-format
// case it covers.

function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v > 0n ? byte | 0x80 : byte);
  } while (v > 0n);
  return out;
}

/** Tag byte(s) for a field: `(fieldNumber << 3) | wireType`. */
function tag(fieldNumber: number, wireType: number): number[] {
  return varint((fieldNumber << 3) | wireType);
}

function protoVarintField(fieldNumber: number, value: number | bigint): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)];
}

function protoLengthDelimited(fieldNumber: number, payload: number[]): number[] {
  return [...tag(fieldNumber, 2), ...varint(payload.length), ...payload];
}

function protoString(fieldNumber: number, text: string): number[] {
  return protoLengthDelimited(fieldNumber, Array.from(new TextEncoder().encode(text)));
}

function protoFixed32(fieldNumber: number, value: number): number[] {
  return [
    ...tag(fieldNumber, 5),
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function protoFixed64(fieldNumber: number, bytes: number[]): number[] {
  return [...tag(fieldNumber, 1), ...bytes];
}

/** Wrap message bytes in gRPC's `[flag][4-byte BE length][message]` framing. */
function grpcFrame(message: number[], compressed = false): number[] {
  const len = message.length;
  return [
    compressed ? 1 : 0,
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...message,
  ];
}

const bytes = (...arrays: number[][]) => new Uint8Array(arrays.flat());

describe('decodeGrpcFrames', () => {
  it('splits a multi-message body and consumes it exactly', () => {
    const body = bytes(
      grpcFrame(protoVarintField(1, 7)),
      grpcFrame(protoString(2, 'hello')),
    );

    const framing = decodeGrpcFrames(body);

    expect(framing).not.toBeNull();
    expect(framing!.frames).toHaveLength(2);
    expect(framing!.trailingBytes).toBe(0);
    expect(framing!.frames[0].compressed).toBe(false);
    expect(framing!.frames[1].message.length).toBe(protoString(2, 'hello').length);
  });

  it('reports a truncated tail instead of failing', () => {
    // Capture caps stored bodies and records streams at teardown, so a body
    // ending mid-frame is the normal case, not corruption.
    const complete = grpcFrame(protoString(1, 'first'));
    const cutOff = grpcFrame(protoString(1, 'second-message-body')).slice(0, 9);
    const framing = decodeGrpcFrames(bytes(complete, cutOff));

    expect(framing!.frames).toHaveLength(1);
    expect(framing!.trailingBytes).toBe(cutOff.length);
    // The prefix survived, so we can say how much the tail claimed to be.
    expect(framing!.truncatedFrameLength).toBe(protoString(1, 'second-message-body').length);
  });

  it('flags a compressed frame without pretending to decode it', () => {
    const framing = decodeGrpcFrames(bytes(grpcFrame([0xde, 0xad, 0xbe, 0xef], true)));

    expect(framing!.frames[0].compressed).toBe(true);
    expect(Array.from(framing!.frames[0].message)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('returns null for bodies that are not gRPC framing', () => {
    expect(decodeGrpcFrames(new TextEncoder().encode('{"ok":true}'))).toBeNull();
    expect(decodeGrpcFrames(new Uint8Array())).toBeNull();
    // A plausible length but a reserved compression flag is not gRPC.
    expect(decodeGrpcFrames(bytes([9, 0, 0, 0, 1, 0x42]))).toBeNull();
  });

  it('does not trust an absurd declared length', () => {
    // 0x7fffffff would otherwise be read as a 2 GiB frame.
    expect(decodeGrpcFrames(bytes([0, 0x7f, 0xff, 0xff, 0xff, 1, 2, 3]))).toBeNull();
  });
});

describe('decodeProtobuf', () => {
  it('decodes each wire type', () => {
    const fields = decodeProtobuf(
      bytes(
        protoVarintField(1, 150),
        protoString(2, 'tapsmith'),
        protoFixed32(3, 0x01020304),
        protoFixed64(4, [1, 0, 0, 0, 0, 0, 0, 0]),
      ),
    );

    expect(fields).not.toBeNull();
    expect(fields).toHaveLength(4);
    expect(fields![0].value).toEqual({ kind: 'varint', value: 150n });
    expect(fields![1].value).toEqual({ kind: 'string', value: 'tapsmith' });
    expect(fields![2].value).toEqual({ kind: 'fixed32', value: 0x01020304 });
    expect(fields![3].value).toEqual({ kind: 'fixed64', value: 1n });
  });

  it('keeps 64-bit varints exact', () => {
    // Beyond Number.MAX_SAFE_INTEGER — a plain number would lose the low bits,
    // which matters for Firestore's microsecond timestamps.
    const big = 9007199254740993n;
    const fields = decodeProtobuf(bytes(protoVarintField(1, big)));
    expect(fields![0].value).toEqual({ kind: 'varint', value: big });
  });

  it('recurses into nested messages', () => {
    const inner = protoString(1, 'documents/users/abc');
    const fields = decodeProtobuf(bytes(protoLengthDelimited(2, inner)));

    const outer = fields![0].value;
    expect(outer.kind).toBe('message');
    if (outer.kind !== 'message') throw new Error('expected nested message');
    expect(outer.fields[0].value).toEqual({ kind: 'string', value: 'documents/users/abc' });
  });

  it('renders non-UTF8 length-delimited values as bytes', () => {
    // 0xff is never valid UTF-8, and these bytes do not parse as a message.
    const fields = decodeProtobuf(bytes(protoLengthDelimited(1, [0xff, 0xfe, 0xff, 0xfe])));
    expect(fields![0].value.kind).toBe('bytes');
  });

  it('rejects inputs that are not well-formed messages', () => {
    // Field number 0 is illegal.
    expect(decodeProtobuf(bytes([0x00, 0x01]))).toBeNull();
    // Wire type 6 does not exist.
    expect(decodeProtobuf(bytes([0x0e, 0x01]))).toBeNull();
    // Declared length runs past the end, so the parse cannot be exact.
    expect(decodeProtobuf(bytes([...tag(1, 2), ...varint(50)], [0x41]))).toBeNull();
    expect(decodeProtobuf(new Uint8Array())).toBeNull();
  });

  it('does not mistake ordinary text for a message', () => {
    // The heuristic that matters most: plain JSON must not be reported as
    // protobuf, or every JSON body would render as garbage fields.
    expect(decodeProtobuf(new TextEncoder().encode('{"title":"Buy milk"}'))).toBeNull();
  });
});

describe('formatProtobuf', () => {
  it('renders field numbers, strings and nested blocks', () => {
    const fields = decodeProtobuf(
      bytes(
        protoString(1, 'projects/demo/databases/(default)'),
        protoLengthDelimited(2, protoVarintField(4, 42)),
      ),
    );

    const text = formatProtobuf(fields!);

    expect(text).toContain('1: "projects/demo/databases/(default)"');
    expect(text).toContain('2 {');
    expect(text).toContain('  4: 42');
    expect(text).toContain('}');
  });
});

describe('decodeBodyForDisplay', () => {
  it('decodes a Firestore-shaped gRPC body into readable fields', () => {
    // Mirrors the shape of a real Listen request: a database path plus a
    // nested target, without carrying any real account data.
    const listenRequest = bytes(
      protoString(1, 'projects/demo/databases/(default)'),
      protoLengthDelimited(2, [
        ...protoLengthDelimited(
          2,
          protoString(1, 'projects/demo/databases/(default)/documents/users/u1'),
        ),
        ...protoVarintField(5, 3),
      ]),
    );

    const result = decodeBodyForDisplay(bytes(grpcFrame(Array.from(listenRequest))));

    expect(result).not.toBeNull();
    expect(result!.label).toBe('gRPC · 1 message');
    expect(result!.text).toContain('projects/demo/databases/(default)/documents/users/u1');
    expect(result!.text).toContain('message (');
  });

  it('numbers each message when a body carries several', () => {
    const result = decodeBodyForDisplay(
      bytes(grpcFrame(protoVarintField(1, 1)), grpcFrame(protoVarintField(1, 2))),
    );

    expect(result!.label).toBe('gRPC · 2 messages');
    expect(result!.text).toContain('message 1 of 2');
    expect(result!.text).toContain('message 2 of 2');
  });

  it('explains a truncated body rather than dropping the tail silently', () => {
    const cutOff = grpcFrame(protoString(1, 'a-longer-message')).slice(0, 8);
    const result = decodeBodyForDisplay(bytes(grpcFrame(protoVarintField(1, 1)), cutOff));

    expect(result!.text).toContain('truncated');
    expect(result!.text).toContain('trailing bytes');
  });

  it('decodes a bare protobuf body with no gRPC framing', () => {
    const result = decodeBodyForDisplay(bytes(protoString(1, 'no-framing-here')));

    expect(result!.label).toBe('protobuf');
    expect(result!.text).toContain('1: "no-framing-here"');
  });

  it('returns null for text bodies so callers fall back to plain rendering', () => {
    expect(decodeBodyForDisplay(new TextEncoder().encode('{"ok":true}'))).toBeNull();
    expect(decodeBodyForDisplay(new TextEncoder().encode('<html></html>'))).toBeNull();
    expect(decodeBodyForDisplay(new Uint8Array())).toBeNull();
  });
});

describe('isProtobufContentType', () => {
  it('matches gRPC and protobuf spellings, with parameters', () => {
    for (const ct of [
      'application/grpc',
      'application/grpc+proto',
      'application/grpc; charset=utf-8',
      'application/protobuf',
      'application/x-protobuf',
      'application/vnd.google.protobuf',
      'application/vnd.custom+protobuf',
    ]) {
      expect(isProtobufContentType(ct), ct).toBe(true);
    }
  });

  it('does not match text payloads', () => {
    for (const ct of ['application/json', 'text/plain', 'application/octet-stream', '']) {
      expect(isProtobufContentType(ct), ct).toBe(false);
    }
  });
});
