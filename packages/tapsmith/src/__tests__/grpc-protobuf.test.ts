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
    // A single-field nested message folds onto one line as a dotted path.
    expect(text).toContain('2.4: 42');
  });

  it('renders a wide multi-field message as an indented block', () => {
    const fields = decodeProtobuf(
      bytes(
        protoLengthDelimited(3, [
          ...protoString(1, 'projects/demo/databases/(default)/documents/users/u1'),
          ...protoString(2, 'projects/demo/databases/(default)/documents/stories/s1'),
        ]),
      ),
    );

    const text = formatProtobuf(fields!);

    // Past the inline width, so it keeps its braces and indents its fields.
    expect(text).toContain('3 {');
    expect(text).toContain('  1: "projects/demo/databases/(default)/documents/users/u1"');
    expect(text).toContain('  2: "projects/demo/databases/(default)/documents/stories/s1"');
    expect(text).toContain('}');
  });

  it('inlines a small multi-field message', () => {
    const fields = decodeProtobuf(
      bytes(protoLengthDelimited(2, [...protoVarintField(1, 1), ...protoVarintField(2, 4)])),
    );
    expect(formatProtobuf(fields!).trim()).toBe('2 { 1: 1, 2: 4 }');
  });
});

// ─── Ambiguity between text and nested messages ───

describe('length-delimited disambiguation', () => {
  it('reads a short string that also parses as a message as the string', () => {
    // Regression: "email" is a valid message on the wire — 0x65 is a legal tag
    // for field 12, wire type 5, which consumes "mail" as a fixed32 and lands
    // exactly on the end. It used to render as `12: 0x6c69616d (fixed32)`.
    const fields = decodeProtobuf(bytes(protoString(1, 'email')));
    expect(fields![0].value).toEqual({ kind: 'string', value: 'email' });
  });

  it('still reads a genuine small message as a message', () => {
    // The counter-case to the rule above: `{4: 42}` encodes to 0x20 0x2a, both
    // printable, so a blanket prefer-text rule would flatten it to `" *"`.
    const fields = decodeProtobuf(bytes(protoLengthDelimited(1, protoVarintField(4, 42))));
    const value = fields![0].value;
    expect(value.kind).toBe('message');
    if (value.kind !== 'message') throw new Error('expected a message');
    expect(value.fields[0].value).toEqual({ kind: 'varint', value: 42n });
  });

  it('annotates an unschema-d seconds/nanos pair as a timestamp', () => {
    const fields = decodeProtobuf(
      bytes(
        protoLengthDelimited(1, [
          ...protoVarintField(1, 1_781_090_975),
          ...protoVarintField(2, 776_000_000),
        ]),
      ),
    );
    expect(fields![0].value).toEqual({
      kind: 'timestamp',
      iso: '2026-06-10T11:29:35.776Z',
    });
  });

  it('does not mistake small integer pairs for timestamps', () => {
    const fields = decodeProtobuf(
      bytes(protoLengthDelimited(1, [...protoVarintField(1, 3), ...protoVarintField(2, 4)])),
    );
    expect(fields![0].value.kind).toBe('message');
  });
});

// ─── Schema-driven decoding (grpc-schema.ts) ───

describe('schema-aware decoding', () => {
  const LISTEN_URL =
    'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen';

  /** ListenResponse.target_change with type, packed target_ids and a resume token. */
  const targetChange = () =>
    bytes(
      grpcFrame(
        protoLengthDelimited(2, [
          ...protoVarintField(1, 1),
          // target_ids is a packed repeated int32, so length-delimited on the wire.
          ...protoLengthDelimited(2, [2]),
          ...protoLengthDelimited(4, [0x0a, 0x09, 0x08, 0xff]),
        ]),
      ),
    );

  it('names fields, resolves enums and unpacks repeated scalars', () => {
    const result = decodeBodyForDisplay(targetChange(), {
      url: LISTEN_URL,
      direction: 'response',
    });

    expect(result!.label).toContain('ListenResponse');
    expect(result!.text).toContain('target_change');
    expect(result!.text).toContain('target_change_type: ADD (1)');
    // Without the schema this rendered as `<1 bytes: 02>`.
    expect(result!.text).toContain('target_ids: [2]');
  });

  it('keeps opaque bytes opaque', () => {
    // A resume token is random bytes that often parse as a plausible message;
    // the schema marks it `bytes` so no structure is invented.
    const result = decodeBodyForDisplay(targetChange(), {
      url: LISTEN_URL,
      direction: 'response',
    });
    expect(result!.text).toContain('resume_token: <4 bytes: 0a 09 08 ff>');
  });

  it('renders map entries as key/value lines and bools as true/false', () => {
    const document = protoLengthDelimited(3, [
      ...protoLengthDelimited(1, [
        ...protoString(1, 'projects/demo/databases/(default)/documents/users/u1'),
        // fields: { "verified": { boolean_value: true } }
        ...protoLengthDelimited(2, [
          ...protoString(1, 'verified'),
          ...protoLengthDelimited(2, protoVarintField(1, 1)),
        ]),
      ]),
    ]);
    const result = decodeBodyForDisplay(bytes(grpcFrame(document)), {
      url: LISTEN_URL,
      direction: 'response',
    });

    expect(result!.text).toContain('document_change');
    expect(result!.text).toContain('fields:');
    expect(result!.text).toContain('verified: { boolean_value: true }');
  });

  it('falls back to numeric output for an unknown service', () => {
    const result = decodeBodyForDisplay(targetChange(), {
      url: 'https://example.test/some.other.Service/Method',
      direction: 'response',
    });
    expect(result!.label).not.toContain('ListenResponse');
    expect(result!.text).not.toContain('target_change_type');
  });

  it('names the bloom filter inside an existence filter', () => {
    // ExistenceFilter.unchanged_names is a BloomFilter; without its schema the
    // bitmap and hash_count showed as bare numbers.
    const existenceFilter = protoLengthDelimited(5, [
      ...protoVarintField(1, 4),
      ...protoVarintField(2, 7),
      ...protoLengthDelimited(3, [
        ...protoLengthDelimited(1, [
          ...protoLengthDelimited(1, [0xde, 0xad]),
          ...protoVarintField(2, 3),
        ]),
        ...protoVarintField(2, 15),
      ]),
    ]);
    const result = decodeBodyForDisplay(bytes(grpcFrame(existenceFilter)), {
      url: LISTEN_URL,
      direction: 'response',
    });

    expect(result!.text).toContain('unchanged_names');
    expect(result!.text).toContain('bitmap: <2 bytes: de ad>');
    expect(result!.text).toContain('padding: 3');
    expect(result!.text).toContain('hash_count: 15');
  });

  it('marks a repeated field so a single element is not read as a scalar', () => {
    // `documents` is repeated; folding it into a dotted path without a marker
    // makes a one-element list look like a scalar chain.
    const listenRequest = bytes(
      grpcFrame(
        protoLengthDelimited(2, protoLengthDelimited(3, protoString(2, 'documents/users/u1'))),
      ),
    );
    const result = decodeBodyForDisplay(listenRequest, {
      url: LISTEN_URL,
      direction: 'request',
    });
    expect(result!.text).toContain('documents[]');
  });

  it('picks the request schema for the request side', () => {
    const listenRequest = bytes(
      grpcFrame(protoString(1, 'projects/demo/databases/(default)')),
    );
    const result = decodeBodyForDisplay(listenRequest, {
      url: LISTEN_URL,
      direction: 'request',
    });
    expect(result!.label).toContain('ListenRequest');
    expect(result!.text).toContain('database: "projects/demo/databases/(default)"');
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

  it('leads a long stream with a per-kind summary', () => {
    // The point of the summary: a long stream is mostly bookkeeping, and the
    // two interesting messages should be visible without reading all of it.
    const ack = () => grpcFrame(protoLengthDelimited(2, protoVarintField(1, 1)));
    const doc = () =>
      grpcFrame(protoLengthDelimited(3, protoString(1, 'documents/users/u1')));
    const result = decodeBodyForDisplay(bytes(ack(), ack(), ack(), ack(), doc()), {
      url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen',
      direction: 'response',
    });

    expect(result!.text).toContain('summary of 5 messages');
    expect(result!.text).toContain('target_change');
    expect(result!.text).toContain('×4');
    expect(result!.text).toContain('document_change');
    // Every message is still listed in full below the summary.
    expect(result!.text).toContain('message 5 of 5');
  });

  it('counts an omitted enum as its proto3 default', () => {
    // An absent field is at its default, and enum defaults are always 0, so an
    // omitted target_change_type means NO_CHANGE — not "unset". Counting it is
    // what makes the tallies add up to the message count.
    const noChange = () =>
      grpcFrame(protoLengthDelimited(2, protoLengthDelimited(4, [0x01, 0x02])));
    const result = decodeBodyForDisplay(bytes(noChange(), noChange(), noChange(), noChange()), {
      url: 'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen',
      direction: 'response',
    });

    expect(result!.text).toContain('NO_CHANGE ×4');
  });

  it('omits the summary for a short body', () => {
    const result = decodeBodyForDisplay(
      bytes(grpcFrame(protoVarintField(1, 1)), grpcFrame(protoVarintField(1, 2))),
    );
    expect(result!.text).not.toContain('summary of');
    expect(result!.text).toContain('message 2 of 2');
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
