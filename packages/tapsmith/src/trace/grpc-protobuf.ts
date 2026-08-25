/**
 * Schema-free gRPC + protobuf body decoding for the trace viewer and UI mode.
 *
 * gRPC bodies are the one common payload the Network tab could not show: they
 * are length-prefixed protobuf, so rendering them as text produces noise. This
 * decodes two independent layers, neither of which needs a `.proto` file:
 *
 *  1. **gRPC framing** — each message is `[1-byte compressed flag][4-byte
 *     big-endian length][message]`, repeated.
 *  2. **Protobuf wire format** — a flat sequence of `(field number, wire type,
 *     value)` records. Field *names* live only in the schema, so output is
 *     keyed by field number, the same as `protoc --decode_raw`.
 *
 * Deliberately schema-free: vendoring `google.firestore.v1` (and the
 * `google.api`/`google.rpc`/well-known-type tree it pulls in) would help one
 * backend, bloat the browser bundle, and still miss every other gRPC service.
 * Field numbers plus decoded strings are enough to see what a call carried.
 *
 * Truncation is normal, not exceptional: capture caps stored bodies (1 MB) and
 * long-lived streams are recorded at teardown, so a captured body routinely
 * ends mid-frame. Every function here degrades to a partial result instead of
 * failing, and reports what it could not read.
 */

// ─── gRPC framing ───

/** One length-prefixed message from a gRPC body. */
export interface GrpcFrame {
  /** Per-message compression flag. A compressed frame's bytes are left
   * undecoded — the codec is named in the `grpc-encoding` header, not here. */
  compressed: boolean
  message: Uint8Array
}

export interface GrpcFraming {
  frames: GrpcFrame[]
  /** Bytes left over after the last complete frame — a truncated tail. */
  trailingBytes: number
  /** Length the truncated tail declared, when its 5-byte prefix was intact.
   * Lets the UI say how much is missing rather than just "truncated". */
  truncatedFrameLength: number | null
}

/** Largest frame length we will trust from a body's own prefix. Guards against
 * reading a bogus multi-gigabyte length out of a body that only looks like
 * gRPC — the value is a hard cap on any single captured message, comfortably
 * above the 1 MB capture cap. */
const MAX_FRAME_LENGTH = 64 * 1024 * 1024;

/**
 * Split a gRPC body into its messages.
 *
 * Returns `null` when the bytes cannot be gRPC framing at all (no complete
 * frame and no plausible prefix), so callers can fall back to text rendering.
 */
export function decodeGrpcFrames(bytes: Uint8Array): GrpcFraming | null {
  const frames: GrpcFrame[] = [];
  let offset = 0;

  while (offset + 5 <= bytes.length) {
    const flag = bytes[offset];
    // Only 0 (uncompressed) and 1 (compressed) are defined. Anything else
    // means this is not gRPC framing, so stop rather than invent frames.
    if (flag !== 0 && flag !== 1) break;
    const length =
      bytes[offset + 1] * 0x1000000 +
      bytes[offset + 2] * 0x10000 +
      bytes[offset + 3] * 0x100 +
      bytes[offset + 4];
    if (length > MAX_FRAME_LENGTH) break;
    if (offset + 5 + length > bytes.length) break; // truncated tail
    frames.push({
      compressed: flag === 1,
      message: bytes.subarray(offset + 5, offset + 5 + length),
    });
    offset += 5 + length;
  }

  const trailingBytes = bytes.length - offset;
  if (frames.length === 0) return null;

  // Report the declared length of a truncated tail when its prefix survived.
  let truncatedFrameLength: number | null = null;
  if (trailingBytes >= 5) {
    const flag = bytes[offset];
    if (flag === 0 || flag === 1) {
      const declared =
        bytes[offset + 1] * 0x1000000 +
        bytes[offset + 2] * 0x10000 +
        bytes[offset + 3] * 0x100 +
        bytes[offset + 4];
      if (declared <= MAX_FRAME_LENGTH) truncatedFrameLength = declared;
    }
  }

  return { frames, trailingBytes, truncatedFrameLength };
}

// ─── Protobuf wire format ───

export type ProtoValue =
  | { kind: 'varint'; value: bigint }
  | { kind: 'fixed64'; value: bigint }
  | { kind: 'fixed32'; value: number }
  | { kind: 'message'; fields: ProtoField[] }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; value: Uint8Array }

export interface ProtoField {
  fieldNumber: number
  value: ProtoValue
}

/** Nesting limit. Protobuf allows deep nesting; a cap keeps a hostile or
 * misparsed body from recursing until the stack gives out. */
const MAX_DEPTH = 12;

/** Field cap per message, for the same reason. Misparsed binary can otherwise
 * yield hundreds of thousands of one-byte "fields". */
const MAX_FIELDS = 2000;

interface Cursor {
  bytes: Uint8Array
  pos: number
}

function readVarint(cur: Cursor): bigint | null {
  let result = 0n;
  let shift = 0n;
  // A varint is at most 10 bytes; beyond that the input is malformed.
  for (let i = 0; i < 10; i++) {
    if (cur.pos >= cur.bytes.length) return null;
    const byte = cur.bytes[cur.pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  return null;
}

/**
 * Decode a protobuf message body into its fields.
 *
 * Returns `null` if the bytes are not a well-formed message — meaning they do
 * not parse *exactly*, with every field consuming its declared length and the
 * last one ending at the final byte. That strictness is what makes the
 * length-delimited heuristic below trustworthy: random text almost never
 * satisfies it, so a successful parse is good evidence of a real message.
 */
export function decodeProtobuf(bytes: Uint8Array, depth = 0): ProtoField[] | null {
  if (depth > MAX_DEPTH) return null;
  const cur: Cursor = { bytes, pos: 0 };
  const fields: ProtoField[] = [];

  while (cur.pos < bytes.length) {
    if (fields.length >= MAX_FIELDS) return null;
    const tag = readVarint(cur);
    if (tag === null) return null;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    // Field 0 is illegal, and a field number beyond 2^29-1 is out of range —
    // both are reliable signals that this is not really a message.
    if (fieldNumber === 0 || fieldNumber > 536870911) return null;

    switch (wireType) {
      case 0: {
        const value = readVarint(cur);
        if (value === null) return null;
        fields.push({ fieldNumber, value: { kind: 'varint', value } });
        break;
      }
      case 1: {
        if (cur.pos + 8 > bytes.length) return null;
        let v = 0n;
        for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[cur.pos + i]);
        cur.pos += 8;
        fields.push({ fieldNumber, value: { kind: 'fixed64', value: v } });
        break;
      }
      case 2: {
        const len = readVarint(cur);
        if (len === null) return null;
        const length = Number(len);
        if (cur.pos + length > bytes.length) return null;
        const slice = bytes.subarray(cur.pos, cur.pos + length);
        cur.pos += length;
        fields.push({ fieldNumber, value: classifyLengthDelimited(slice, depth) });
        break;
      }
      case 5: {
        if (cur.pos + 4 > bytes.length) return null;
        const v =
          bytes[cur.pos] +
          bytes[cur.pos + 1] * 0x100 +
          bytes[cur.pos + 2] * 0x10000 +
          bytes[cur.pos + 3] * 0x1000000;
        cur.pos += 4;
        fields.push({ fieldNumber, value: { kind: 'fixed32', value: v } });
        break;
      }
      // Wire types 3/4 are the deprecated group markers, and 6/7 are illegal.
      // Either way we cannot know where the value ends, so stop.
      default:
        return null;
    }
  }

  return fields.length > 0 ? fields : null;
}

/**
 * Decide what a length-delimited value *is*. The wire format cannot say: a
 * nested message, a UTF-8 string and raw bytes share wire type 2.
 *
 * Order is message → string → bytes, matching `protoc --decode_raw`. Message
 * first is safe precisely because [`decodeProtobuf`] demands an exact parse;
 * preferring the string reading would instead flatten real nested messages
 * into mojibake whenever their bytes happened to be valid UTF-8.
 */
function classifyLengthDelimited(slice: Uint8Array, depth: number): ProtoValue {
  if (slice.length === 0) return { kind: 'bytes', value: slice };

  const nested = decodeProtobuf(slice, depth + 1);
  if (nested) return { kind: 'message', fields: nested };

  const text = decodeUtf8Strict(slice);
  if (text !== null) return { kind: 'string', value: text };

  return { kind: 'bytes', value: slice };
}

/**
 * Decode UTF-8, returning `null` unless the bytes are valid *and* free of
 * control characters. `TextDecoder` with `fatal` rejects malformed sequences;
 * the control-character check additionally rejects binary that happens to be
 * valid UTF-8 (a run of low bytes) but would render as invisible junk.
 */
function decodeUtf8Strict(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // Allow tab/newline/carriage return; reject other C0 controls and DEL.
  // Checked by code point rather than a regex so the literal control
  // characters never have to appear in this source file.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return text;
}

// ─── Rendering ───

/** Cap on rendered output. A 1 MB protobuf body can expand to far more text
 * than anyone will read, and `<pre>` rendering cost scales with it. */
const MAX_OUTPUT_CHARS = 400_000;

function formatBytesPreview(bytes: Uint8Array): string {
  const shown = Array.from(bytes.subarray(0, 32))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  return bytes.length > 32
    ? `${bytes.length} bytes: ${shown} …`
    : `${bytes.length} bytes: ${shown}`;
}

function formatFields(fields: ProtoField[], indent: string, out: string[]): void {
  for (const { fieldNumber, value } of fields) {
    if (out.join('').length > MAX_OUTPUT_CHARS) return;
    switch (value.kind) {
      case 'varint':
        out.push(`${indent}${fieldNumber}: ${value.value}\n`);
        break;
      case 'fixed64':
        out.push(`${indent}${fieldNumber}: 0x${value.value.toString(16)} (fixed64)\n`);
        break;
      case 'fixed32':
        out.push(`${indent}${fieldNumber}: 0x${value.value.toString(16)} (fixed32)\n`);
        break;
      case 'string':
        out.push(`${indent}${fieldNumber}: ${JSON.stringify(value.value)}\n`);
        break;
      case 'bytes':
        out.push(`${indent}${fieldNumber}: <${formatBytesPreview(value.value)}>\n`);
        break;
      case 'message':
        out.push(`${indent}${fieldNumber} {\n`);
        formatFields(value.fields, `${indent}  `, out);
        out.push(`${indent}}\n`);
        break;
    }
  }
}

/** Render decoded fields as indented text, in the shape `protoc --decode_raw`
 * uses (field number, then value or a nested block). */
export function formatProtobuf(fields: ProtoField[], indent = ''): string {
  const out: string[] = [];
  formatFields(fields, indent, out);
  const text = out.join('');
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated\n`
    : text;
}

/**
 * Best-effort decode of a whole body for display.
 *
 * Handles the three cases the Network tab actually meets: a gRPC body (framing
 * plus a protobuf message per frame), a bare protobuf message with no gRPC
 * framing, and something that is neither. Returns `null` in the last case so
 * the caller can render text instead.
 */
export function decodeBodyForDisplay(
  bytes: Uint8Array,
): { text: string; label: string } | null {
  if (bytes.length === 0) return null;

  const framing = decodeGrpcFrames(bytes);
  if (framing) {
    const out: string[] = [];
    framing.frames.forEach((frame, i) => {
      const header =
        framing.frames.length > 1 ? `message ${i + 1} of ${framing.frames.length}` : 'message';
      if (frame.compressed) {
        // Without the codec from `grpc-encoding` we cannot inflate it, and
        // guessing would produce confident nonsense.
        out.push(`── ${header} (compressed, ${frame.message.length} bytes — not decoded)\n`);
        return;
      }
      const fields = decodeProtobuf(frame.message);
      out.push(`── ${header} (${frame.message.length} bytes)\n`);
      out.push(
        fields
          ? formatProtobuf(fields, '  ')
          : `  <${formatBytesPreview(frame.message)}>\n`,
      );
    });
    if (framing.trailingBytes > 0) {
      const missing =
        framing.truncatedFrameLength !== null
          ? ` — declares ${framing.truncatedFrameLength} bytes, ${framing.trailingBytes - 5} present`
          : '';
      out.push(
        `── truncated: ${framing.trailingBytes} trailing bytes${missing}\n` +
          `   (capture caps stored bodies, and streams are recorded at teardown)\n`,
      );
    }
    const plural = framing.frames.length === 1 ? '' : 's';
    return {
      text: out.join(''),
      label: `gRPC · ${framing.frames.length} message${plural}`,
    };
  }

  // No gRPC framing — try a bare protobuf message (e.g. a plain
  // application/x-protobuf body).
  const fields = decodeProtobuf(bytes);
  if (fields) return { text: formatProtobuf(fields), label: 'protobuf' };

  return null;
}

/** Whether a content type is one whose body is worth trying to decode as
 * gRPC/protobuf. Kept permissive: `application/grpc`, `+proto` suffixes and
 * the various protobuf spellings all appear in the wild. */
export function isProtobufContentType(contentType: string): boolean {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  return (
    ct.startsWith('application/grpc') ||
    ct === 'application/protobuf' ||
    ct === 'application/x-protobuf' ||
    ct === 'application/vnd.google.protobuf' ||
    ct.endsWith('+proto') ||
    ct.endsWith('+protobuf')
  );
}
