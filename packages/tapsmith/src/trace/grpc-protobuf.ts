/**
 * gRPC + protobuf body decoding for the trace viewer and UI mode.
 *
 * gRPC bodies are the one common payload the Network tab could not show: they
 * are length-prefixed protobuf, so rendering them as text produces noise. This
 * decodes two independent layers:
 *
 *  1. **gRPC framing** — each message is `[1-byte compressed flag][4-byte
 *     big-endian length][message]`, repeated.
 *  2. **Protobuf wire format** — a flat sequence of `(field number, wire type,
 *     value)` records.
 *
 * Field *names* never appear on the wire, so numeric output is the floor. A
 * display-only name table (`grpc-schema.ts`) lifts known services above it —
 * and resolves three wire ambiguities that numbers alone get visibly wrong
 * (opaque bytes, packed repeated scalars, maps). Everything degrades to numbers
 * for services the table doesn't cover.
 *
 * Truncation is normal, not exceptional: capture caps stored bodies (1 MB) and
 * long-lived streams are recorded at teardown, so a captured body routinely
 * ends mid-frame. Every function here degrades to a partial result instead of
 * failing, and reports what it could not read.
 */

import {
  lookupMessage,
  rootTypeForUrl,
  TIMESTAMP_TYPE,
  type FieldDef,
} from './grpc-schema.js';

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
  /** Length the truncated tail declared, when its 5-byte prefix was intact. */
  truncatedFrameLength: number | null
}

/** Largest frame length we will trust from a body's own prefix, so a body that
 * merely looks like gRPC cannot declare a multi-gigabyte message. */
const MAX_FRAME_LENGTH = 64 * 1024 * 1024;

/**
 * Split a gRPC body into its messages. Returns `null` when the bytes cannot be
 * gRPC framing at all, so callers can fall back to text rendering.
 */
export function decodeGrpcFrames(bytes: Uint8Array): GrpcFraming | null {
  const frames: GrpcFrame[] = [];
  let offset = 0;

  while (offset + 5 <= bytes.length) {
    const flag = bytes[offset];
    // Only 0 (uncompressed) and 1 (compressed) are defined; anything else means
    // this is not gRPC framing, so stop rather than invent frames.
    if (flag !== 0 && flag !== 1) break;
    const length = readUint32BE(bytes, offset + 1);
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

  let truncatedFrameLength: number | null = null;
  if (trailingBytes >= 5) {
    const flag = bytes[offset];
    if (flag === 0 || flag === 1) {
      const declared = readUint32BE(bytes, offset + 1);
      if (declared <= MAX_FRAME_LENGTH) truncatedFrameLength = declared;
    }
  }

  return { frames, trailingBytes, truncatedFrameLength };
}

function readUint32BE(bytes: Uint8Array, at: number): number {
  return (
    bytes[at] * 0x1000000 + bytes[at + 1] * 0x10000 + bytes[at + 2] * 0x100 + bytes[at + 3]
  );
}

// ─── Protobuf wire format ───

export type ProtoValue =
  | { kind: 'varint'; value: bigint; enumName?: string; bool?: boolean }
  | { kind: 'fixed64'; value: bigint }
  | { kind: 'fixed32'; value: number }
  | { kind: 'message'; fields: ProtoField[] }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'packed'; values: bigint[] }
  | { kind: 'mapEntry'; key: string; value: ProtoValue }
  | { kind: 'timestamp'; iso: string }

export interface ProtoField {
  fieldNumber: number
  /** Schema name, when the containing type is known. */
  name?: string
  /** Whether the schema declares this field repeated. */
  repeated?: boolean
  value: ProtoValue
}

/** Nesting limit, so a hostile or misparsed body cannot recurse until the stack
 * gives out. */
const MAX_DEPTH = 12;

/** Field cap per message: misparsed binary can otherwise yield hundreds of
 * thousands of one-byte "fields". */
const MAX_FIELDS = 2000;

interface Cursor {
  bytes: Uint8Array
  pos: number
}

interface DecodeCtx {
  depth: number
  /** Message type of the bytes being decoded, when known. */
  type?: string
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
 * Returns `null` unless the bytes parse *exactly* — every field consuming its
 * declared length, the last ending on the final byte. That strictness is what
 * makes the length-delimited heuristic trustworthy: a successful parse is
 * evidence of a real message rather than a coincidence.
 */
export function decodeProtobuf(
  bytes: Uint8Array,
  ctxOrDepth: DecodeCtx | number = 0,
): ProtoField[] | null {
  const ctx: DecodeCtx =
    typeof ctxOrDepth === 'number' ? { depth: ctxOrDepth } : ctxOrDepth;
  if (ctx.depth > MAX_DEPTH) return null;

  const schema = lookupMessage(ctx.type);
  const cur: Cursor = { bytes, pos: 0 };
  const fields: ProtoField[] = [];

  while (cur.pos < bytes.length) {
    if (fields.length >= MAX_FIELDS) return null;
    const tag = readVarint(cur);
    if (tag === null) return null;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    // Field 0 is illegal and numbers above 2^29-1 are out of range — both are
    // reliable signals that this is not really a message.
    if (fieldNumber === 0 || fieldNumber > 536870911) return null;

    const def = schema?.fields[fieldNumber];

    switch (wireType) {
      case 0: {
        const value = readVarint(cur);
        if (value === null) return null;
        const enumName = def?.enum?.[Number(value)];
        fields.push({
          fieldNumber,
          name: def?.name,
          ...(def?.repeated ? { repeated: true } : {}),
          value: {
            kind: 'varint',
            value,
            ...(enumName ? { enumName } : {}),
            ...(def?.bool ? { bool: value !== 0n } : {}),
          },
        });
        break;
      }
      case 1: {
        if (cur.pos + 8 > bytes.length) return null;
        let v = 0n;
        for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[cur.pos + i]);
        cur.pos += 8;
        fields.push({
          fieldNumber,
          name: def?.name,
          ...(def?.repeated ? { repeated: true } : {}),
          value: { kind: 'fixed64', value: v },
        });
        break;
      }
      case 2: {
        const len = readVarint(cur);
        if (len === null) return null;
        const length = Number(len);
        if (cur.pos + length > bytes.length) return null;
        const slice = bytes.subarray(cur.pos, cur.pos + length);
        cur.pos += length;
        fields.push({
          fieldNumber,
          name: def?.name,
          ...(def?.repeated ? { repeated: true } : {}),
          value: classifyLengthDelimited(slice, ctx, def),
        });
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
        fields.push({
          fieldNumber,
          name: def?.name,
          ...(def?.repeated ? { repeated: true } : {}),
          value: { kind: 'fixed32', value: v },
        });
        break;
      }
      // Wire types 3/4 are deprecated group markers and 6/7 are illegal; either
      // way the value's end is unknowable, so stop.
      default:
        return null;
    }
  }

  return fields.length > 0 ? fields : null;
}

/**
 * Decide what a length-delimited value *is*. The wire format cannot say: a
 * nested message, a UTF-8 string, packed repeated scalars and raw bytes all
 * share wire type 2.
 *
 * The schema wins when it covers the field. Without one, the order is
 * message → string → bytes, with one exception carved out for a real failure
 * this used to produce.
 *
 * The five bytes of `"email"` are also a valid message: `0x65` is a legal tag
 * for field 12, wire type 5, which then consumes `mail` as a fixed32 and lands
 * exactly on the end. A plain message-first order therefore rendered a Firestore
 * field name as `12: 0x6c69616d (fixed32)`.
 *
 * The exception is deliberately narrow — a *weak* parse (a lone fixed32/fixed64
 * field) over bytes that are entirely printable ASCII is read as text instead.
 * Preferring text for every printable slice would be too blunt: a small genuine
 * message like `{4: 42}` encodes to `0x20 0x2a`, which is also printable, and
 * would be flattened to `" *"`. Real messages nearly always carry a low field
 * number somewhere, whose tag byte falls in the control range, so this keeps
 * them intact while catching the short-string case.
 */
function classifyLengthDelimited(
  slice: Uint8Array,
  ctx: DecodeCtx,
  def: FieldDef | undefined,
): ProtoValue {
  if (def?.bytes) return { kind: 'bytes', value: slice };

  if (def?.packedVarint) {
    const packed = decodePackedVarints(slice);
    if (packed) return { kind: 'packed', values: packed };
  }

  if (def?.map) {
    const entry = decodeMapEntry(slice, ctx, def.map.value);
    if (entry) return entry;
  }

  if (def?.message) {
    const nested = decodeProtobuf(slice, { depth: ctx.depth + 1, type: def.message });
    if (nested) {
      return def.message === TIMESTAMP_TYPE
        ? timestampValue(nested) ?? { kind: 'message', fields: nested }
        : { kind: 'message', fields: nested };
    }
  }

  if (slice.length === 0) return { kind: 'bytes', value: slice };

  const nested = decodeProtobuf(slice, { depth: ctx.depth + 1 });
  if (nested && isWeakParse(nested) && isPrintableAscii(slice)) {
    return { kind: 'string', value: new TextDecoder().decode(slice) };
  }
  if (nested) {
    // Unschema'd two-field messages that look exactly like a Timestamp are
    // annotated as one — Firestore and most Google APIs use them everywhere,
    // and a bare `{1: 1781090975, 2: 776000000}` is unreadable.
    return timestampValue(nested) ?? { kind: 'message', fields: nested };
  }

  const text = decodeUtf8Strict(slice);
  if (text !== null) return { kind: 'string', value: text };

  return { kind: 'bytes', value: slice };
}

/** Decode a packed repeated varint field, or `null` if the bytes don't line up
 * exactly (in which case the caller falls back to the usual heuristic). */
function decodePackedVarints(slice: Uint8Array): bigint[] | null {
  const cur: Cursor = { bytes: slice, pos: 0 };
  const values: bigint[] = [];
  while (cur.pos < slice.length) {
    const v = readVarint(cur);
    if (v === null) return null;
    values.push(v);
    if (values.length > MAX_FIELDS) return null;
  }
  return values.length > 0 ? values : null;
}

/** Decode one protobuf map entry (`key` = 1, `value` = 2). */
function decodeMapEntry(
  slice: Uint8Array,
  ctx: DecodeCtx,
  valueType: string | undefined,
): ProtoValue | null {
  const fields = decodeProtobuf(slice, { depth: ctx.depth + 1 });
  if (!fields) return null;
  const keyField = fields.find((f) => f.fieldNumber === 1);
  const valueField = fields.find((f) => f.fieldNumber === 2);
  if (!keyField || keyField.value.kind !== 'string') return null;

  // Re-decode the value against its declared type now that we know the entry
  // really is a map entry.
  let value: ProtoValue = valueField?.value ?? { kind: 'bytes', value: new Uint8Array() };
  if (valueType && valueField) {
    const raw = mapEntryValueBytes(slice);
    if (raw) {
      const typed = decodeProtobuf(raw, { depth: ctx.depth + 1, type: valueType });
      if (typed) value = { kind: 'message', fields: typed };
    }
  }
  return { kind: 'mapEntry', key: keyField.value.value, value };
}

/** Raw bytes of field 2 in a map entry, needed to re-decode it against the
 * map's declared value type. */
function mapEntryValueBytes(slice: Uint8Array): Uint8Array | null {
  const cur: Cursor = { bytes: slice, pos: 0 };
  while (cur.pos < slice.length) {
    const tag = readVarint(cur);
    if (tag === null) return null;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (wireType !== 2) {
      // Skip fields we don't care about, by wire type.
      if (wireType === 0) {
        if (readVarint(cur) === null) return null;
      } else if (wireType === 1) {
        cur.pos += 8;
      } else if (wireType === 5) {
        cur.pos += 4;
      } else return null;
      continue;
    }
    const len = readVarint(cur);
    if (len === null) return null;
    const length = Number(len);
    if (cur.pos + length > slice.length) return null;
    if (fieldNumber === 2) return slice.subarray(cur.pos, cur.pos + length);
    cur.pos += length;
  }
  return null;
}

/** Recognise a `{seconds, nanos}` pair as a timestamp and render it ISO. The
 * range check keeps ordinary small integers from being mislabelled as dates. */
function timestampValue(fields: ProtoField[]): ProtoValue | null {
  if (fields.length === 0 || fields.length > 2) return null;
  const seconds = fields.find((f) => f.fieldNumber === 1);
  const nanos = fields.find((f) => f.fieldNumber === 2);
  if (!seconds || seconds.value.kind !== 'varint') return null;
  if (nanos && nanos.value.kind !== 'varint') return null;
  const secs = seconds.value.value;
  // ~2001-09-09 to ~2065: tight enough that counters and IDs don't qualify.
  if (secs < 1_000_000_000n || secs > 3_000_000_000n) return null;
  const nanoPart = nanos && nanos.value.kind === 'varint' ? nanos.value.value : 0n;
  if (nanoPart < 0n || nanoPart >= 1_000_000_000n) return null;
  const ms = Number(secs) * 1000 + Number(nanoPart / 1_000_000n);
  return { kind: 'timestamp', iso: new Date(ms).toISOString() };
}

/**
 * Whether a successful parse is thin enough to be a coincidence: a single field
 * holding a fixed-width scalar. Real messages of that exact shape are rare,
 * while short strings landing on it are not — `"email"` is one.
 */
function isWeakParse(fields: ProtoField[]): boolean {
  if (fields.length !== 1) return false;
  const kind = fields[0].value.kind;
  return kind === 'fixed32' || kind === 'fixed64';
}

/** Whether every byte is printable ASCII (space through `~`). */
function isPrintableAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

/**
 * Decode UTF-8, returning `null` unless the bytes are valid *and* free of
 * control characters — binary that happens to be valid UTF-8 would otherwise
 * render as invisible junk.
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

/** Cap on rendered output: a 1 MB protobuf body expands to more text than
 * anyone will read, and `<pre>` cost scales with it. */
const MAX_OUTPUT_CHARS = 400_000;

/** Longest message rendered on a single line rather than as an indented block. */
const INLINE_WIDTH = 72;

/** Above this many messages, lead with a per-kind summary. Below it the list
 * is short enough to read directly. */
const SUMMARY_MIN_MESSAGES = 3;

function label(field: ProtoField): string {
  const base = field.name ?? `${field.fieldNumber}`;
  // `[]` keeps a folded path honest: a one-element repeated field would
  // otherwise read exactly like a scalar chain.
  return field.repeated ? `${base}[]` : base;
}

function formatBytesPreview(bytes: Uint8Array): string {
  const shown = Array.from(bytes.subarray(0, 32))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  const suffix = bytes.length > 32 ? ' …' : '';
  return `${bytes.length} bytes: ${shown}${suffix}`;
}

/** Render a value that fits on one line, or `null` if it needs a block. */
function formatScalar(value: ProtoValue): string | null {
  switch (value.kind) {
    case 'varint':
      if (value.bool !== undefined) return String(value.bool);
      return value.enumName ? `${value.enumName} (${value.value})` : `${value.value}`;
    case 'fixed64':
      return `0x${value.value.toString(16)} (fixed64)`;
    case 'fixed32':
      return `0x${value.value.toString(16)} (fixed32)`;
    case 'string':
      return JSON.stringify(value.value);
    case 'bytes':
      return value.value.length === 0 ? '<empty>' : `<${formatBytesPreview(value.value)}>`;
    case 'packed':
      return `[${value.values.join(', ')}]`;
    case 'timestamp':
      return value.iso;
    default:
      return null;
  }
}

/**
 * Fold a chain of single-field messages into a dotted path. Firestore's
 * responses are full of `2 { 4 { 1 { 1: … } } }`, which reads far better as a
 * single line — and the same shape dominates any oneof-heavy schema.
 */
function foldChain(field: ProtoField): { path: string; value: ProtoValue } {
  let path = label(field);
  let value = field.value;
  while (value.kind === 'message' && value.fields.length === 1) {
    const only = value.fields[0];
    // Stop before folding *into* a map entry: entries are rendered by their own
    // grouped branch, and folding past one used to drop the field entirely
    // (a `map_value` holding a single key printed as a bare `name:` line).
    if (only.value.kind === 'mapEntry') break;
    path = `${path}.${label(only)}`;
    value = only.value;
  }
  return { path, value };
}

/** One-line rendering of a small message, or `null` when it needs a block. */
function tryInline(fields: ProtoField[]): string | null {
  const parts: string[] = [];
  for (const field of fields) {
    if (field.value.kind === 'mapEntry') return null;
    const scalar = formatScalar(field.value);
    if (scalar === null) return null;
    parts.push(`${label(field)}: ${scalar}`);
  }
  const text = parts.join(', ');
  return text.length <= INLINE_WIDTH ? `{ ${text} }` : null;
}

function formatFields(fields: ProtoField[], indent: string, out: string[]): void {
  let i = 0;
  while (i < fields.length) {
    if (out.length > 0 && out.join('').length > MAX_OUTPUT_CHARS) return;
    const field = fields[i];

    // Consecutive entries of the same map render as one titled block.
    if (field.value.kind === 'mapEntry') {
      const start = i;
      while (
        i < fields.length &&
        fields[i].value.kind === 'mapEntry' &&
        fields[i].fieldNumber === field.fieldNumber
      ) {
        i++;
      }
      out.push(`${indent}${label(field)}:\n`);
      for (let j = start; j < i; j++) {
        const entry = fields[j].value;
        if (entry.kind !== 'mapEntry') continue;
        const scalar = formatScalar(entry.value);
        if (scalar !== null) {
          out.push(`${indent}  ${entry.key}: ${scalar}\n`);
        } else if (entry.value.kind === 'message') {
          const inline = tryInline(entry.value.fields);
          if (inline) {
            out.push(`${indent}  ${entry.key}: ${inline}\n`);
          } else {
            out.push(`${indent}  ${entry.key}:\n`);
            formatFields(entry.value.fields, `${indent}    `, out);
          }
        }
      }
      continue;
    }

    const { path, value } = foldChain(field);
    const scalar = formatScalar(value);
    if (scalar !== null) {
      out.push(`${indent}${path}: ${scalar}\n`);
    } else if (value.kind === 'message') {
      const inline = tryInline(value.fields);
      if (inline) {
        out.push(`${indent}${path} ${inline}\n`);
      } else {
        out.push(`${indent}${path} {\n`);
        formatFields(value.fields, `${indent}  `, out);
        out.push(`${indent}}\n`);
      }
    }
    i++;
  }
}

/** Render decoded fields as indented text. */
export function formatProtobuf(fields: ProtoField[], indent = ''): string {
  const out: string[] = [];
  formatFields(fields, indent, out);
  const text = out.join('');
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated\n`
    : text;
}

/**
 * Per-message-kind summary of a streamed body.
 *
 * Long gRPC streams are overwhelmingly bookkeeping: a captured Firestore
 * `Listen` response can carry two `document_change`s among sixty
 * `target_change` acks, and reading the list top to bottom does not tell you
 * that. This answers "what happened on this stream?" before the detail.
 *
 * An earlier attempt collapsed *consecutive* runs of same-shaped messages, and
 * it never fired on real traffic: the acks cycle
 * (`CURRENT` → `NO_CHANGE` → `REMOVE` → `ADD`) rather than repeat, so no run
 * ever reached the threshold. Counting by kind is indifferent to ordering.
 */
interface KindSummary {
  label: string
  count: number
  /** Enum tallies keyed by field name, e.g. `target_change_type` → ADD ×14. */
  enums: Map<string, Map<string, number>>
  /** A couple of distinct identifying strings, e.g. document names. */
  samples: string[]
}

/** Deepest level searched when gathering enum tallies and sample strings —
 * enough to reach `document_change.document.name` without walking whole maps. */
const SUMMARY_SCAN_DEPTH = 3;

function scanForSummary(
  fields: ProtoField[],
  summary: KindSummary,
  depth: number,
): void {
  if (depth > SUMMARY_SCAN_DEPTH) return;
  for (const field of fields) {
    const value = field.value;
    if (value.kind === 'varint' && value.enumName && field.name) {
      const tally = summary.enums.get(field.name) ?? new Map<string, number>();
      tally.set(value.enumName, (tally.get(value.enumName) ?? 0) + 1);
      summary.enums.set(field.name, tally);
    } else if (value.kind === 'string' && summary.samples.length < 2) {
      if (!summary.samples.includes(value.value)) summary.samples.push(value.value);
    } else if (value.kind === 'message') {
      scanForSummary(value.fields, summary, depth + 1);
    }
  }
}

/**
 * Enum fields absent from a proto3 message are at their default, and enum
 * defaults are always 0 — so an omitted `target_change_type` means `NO_CHANGE`
 * rather than "not set". Counting those keeps the tallies adding up to the
 * message count, which is what makes the summary trustworthy.
 */
function countDefaultedEnums(
  fields: ProtoField[],
  typeName: string | undefined,
  summary: KindSummary,
): void {
  const schema = lookupMessage(typeName);
  if (!schema) return;
  for (const [num, def] of Object.entries(schema.fields)) {
    const zeroName = def.enum?.[0];
    if (!zeroName) continue;
    const present = fields.some((f) => f.fieldNumber === Number(num));
    if (present) continue;
    const tally = summary.enums.get(def.name) ?? new Map<string, number>();
    tally.set(zeroName, (tally.get(zeroName) ?? 0) + 1);
    summary.enums.set(def.name, tally);
  }
}

function summariseFrames(
  perFrameFields: (ProtoField[] | null)[],
  type: string | undefined,
): string[] {
  const summaries = new Map<string, KindSummary>();
  for (const fields of perFrameFields) {
    if (!fields) continue;
    // A oneof-style response has exactly one top-level field, which names the
    // kind; anything else is summarised under its field list.
    const key = fields.length === 1 ? label(fields[0]) : fields.map(label).join('+');
    const summary =
      summaries.get(key) ??
      { label: key, count: 0, enums: new Map(), samples: [] };
    summary.count++;
    if (fields.length === 1 && fields[0].value.kind === 'message') {
      const inner = fields[0].value.fields;
      scanForSummary(inner, summary, 0);
      countDefaultedEnums(inner, nestedTypeOf(type, fields[0].fieldNumber), summary);
    } else {
      scanForSummary(fields, summary, 0);
    }
    summaries.set(key, summary);
  }

  if (summaries.size === 0) return [];
  const width = Math.max(...Array.from(summaries.keys(), (k) => k.length));
  return Array.from(summaries.values()).map((s) => {
    const parts: string[] = [];
    for (const [field, tally] of s.enums) {
      const counts = Array.from(tally)
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name} ×${n}`)
        .join(', ');
      parts.push(`${field}: ${counts}`);
    }
    for (const sample of s.samples) {
      parts.push(sample.length > 60 ? `"…${sample.slice(-57)}"` : `"${sample}"`);
    }
    const count = `×${s.count}`;
    if (parts.length === 0) return `   ${s.label.padEnd(width)} ${count}\n`;
    return `   ${s.label.padEnd(width)} ${count.padEnd(4)} ${parts.join(' · ')}\n`;
  });
}

/** Message type of a nested field, for resolving defaulted enums. */
function nestedTypeOf(parentType: string | undefined, fieldNumber: number): string | undefined {
  return lookupMessage(parentType)?.fields[fieldNumber]?.message;
}

export interface DecodeBodyOptions {
  /** Captured request URL, used to pick a schema for the gRPC method. */
  url?: string
  /** Which side of the call these bytes are. */
  direction?: 'request' | 'response'
}

/**
 * Best-effort decode of a whole body for display: a gRPC body (framing plus a
 * message per frame), a bare protobuf message, or neither — `null` in the last
 * case so the caller can render text instead.
 */
export function decodeBodyForDisplay(
  bytes: Uint8Array,
  options: DecodeBodyOptions = {},
): { text: string; label: string } | null {
  if (bytes.length === 0) return null;

  const type =
    options.url && options.direction
      ? rootTypeForUrl(options.url, options.direction)
      : undefined;

  const framing = decodeGrpcFrames(bytes);
  if (framing) {
    const out: string[] = [];
    const total = framing.frames.length;

    // Decode once, so the summary and the listing agree and nothing is parsed
    // twice.
    const decoded = framing.frames.map((frame) =>
      frame.compressed ? null : decodeProtobuf(frame.message, { depth: 0, type }),
    );

    if (total > SUMMARY_MIN_MESSAGES) {
      out.push(`── summary of ${total} messages\n`);
      out.push(...summariseFrames(decoded, type));
      out.push('\n');
    }

    for (let i = 0; i < total; i++) {
      const frame = framing.frames[i];
      if (frame.compressed) {
        out.push(
          `── message ${i + 1} of ${total} (compressed, ${frame.message.length} bytes — not decoded)\n`,
        );
        continue;
      }
      const fields = decoded[i];
      const header = total > 1 ? `message ${i + 1} of ${total}` : 'message';
      out.push(`── ${header} (${frame.message.length} bytes)\n`);
      out.push(
        fields ? formatProtobuf(fields, '  ') : `  <${formatBytesPreview(frame.message)}>\n`,
      );
    }
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
    const plural = total === 1 ? '' : 's';
    const named = type ? ` · ${type.split('.').pop()}` : '';
    return { text: out.join(''), label: `gRPC · ${total} message${plural}${named}` };
  }

  // No gRPC framing — try a bare protobuf message (e.g. application/x-protobuf).
  const fields = decodeProtobuf(bytes, { depth: 0, type });
  if (fields) return { text: formatProtobuf(fields), label: 'protobuf' };

  return null;
}

/** Whether a content type is worth trying to decode as gRPC/protobuf. Kept
 * permissive: `application/grpc`, `+proto` suffixes and the various protobuf
 * spellings all appear in the wild. */
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
