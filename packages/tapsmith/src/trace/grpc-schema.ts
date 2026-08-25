/**
 * Display-only field names for well-known gRPC messages.
 *
 * Protobuf carries field *numbers* on the wire, never names, so a schema-free
 * decode can only ever print `3 { 1 { 1: "projects/…" } }`. This table supplies
 * names for the messages Tapsmith users actually meet, turning that into
 * `document_change.document.name: "projects/…"`.
 *
 * It is deliberately a hand-written table rather than vendored `.proto` files:
 * `google/firestore/v1/*.proto` pulls in the `google.api`, `google.rpc`,
 * `google.type` and well-known-type trees, which is a large dependency to carry
 * into a browser bundle for what amounts to a lookup table. Field numbers here
 * are transcribed from the published protos (googleapis/googleapis, master) —
 * see each section for the source file.
 *
 * The schema does more than rename. Three wire-format ambiguities can only be
 * resolved with it, and each one produced visibly wrong output before:
 *
 *  * **Opaque bytes vs. nested message.** A Firestore `resume_token` is random
 *    bytes that frequently parse as a valid message, so a schema-free decode
 *    invents structure that isn't there. `bytes: true` stops that.
 *  * **Packed repeated scalars.** `target_ids` is a packed `repeated int32`,
 *    which on the wire is length-delimited — indistinguishable from a string or
 *    a message without the schema. It rendered as `<1 bytes: 02>` instead of
 *    `[2]`.
 *  * **Maps.** `Document.fields` is a `map<string, Value>`, encoded as repeated
 *    entry messages with key=1, value=2. Naming the map lets those collapse
 *    into readable `key: value` lines.
 *
 * Unknown methods and unknown field numbers fall back to numeric output, so an
 * incomplete table degrades rather than misleads.
 */

export interface FieldDef {
  name: string
  /** Decode the value against this message type. */
  message?: string
  /** Varint field whose values are enum members. */
  enum?: Record<number, string>
  /** Opaque bytes — never attempt a nested-message parse. */
  bytes?: boolean
  /** Packed repeated varint (`repeated int32`/`int64` with default packing). */
  packedVarint?: boolean
  /** Protobuf map. Entries are messages with key=1, value=2. */
  map?: { value?: string }
  /** Varint field that is really a `bool`, so 0/1 render as false/true. */
  bool?: boolean
}

export interface MessageDef {
  fields: Record<number, FieldDef>
}

/** Marker type name for `google.protobuf.Timestamp`, rendered as an ISO date. */
export const TIMESTAMP_TYPE = 'google.protobuf.Timestamp';

// ─── google/protobuf/timestamp.proto, google/rpc/status.proto ───

const WELL_KNOWN: Record<string, MessageDef> = {
  [TIMESTAMP_TYPE]: {
    fields: {
      1: { name: 'seconds' },
      2: { name: 'nanos' },
    },
  },
  // Wrappers exist so a wrapped scalar renders as the scalar rather than as a
  // one-field message.
  'google.protobuf.Int32Value': { fields: { 1: { name: 'value' } } },
  'google.rpc.Status': {
    fields: {
      1: { name: 'code' },
      2: { name: 'message' },
      3: { name: 'details' },
    },
  },
};

// ─── google/firestore/v1/document.proto ───

const DOCUMENT: Record<string, MessageDef> = {
  'google.firestore.v1.Document': {
    fields: {
      1: { name: 'name' },
      2: { name: 'fields', map: { value: 'google.firestore.v1.Value' } },
      3: { name: 'create_time', message: TIMESTAMP_TYPE },
      4: { name: 'update_time', message: TIMESTAMP_TYPE },
    },
  },
  'google.firestore.v1.Value': {
    fields: {
      1: { name: 'boolean_value', bool: true },
      2: { name: 'integer_value' },
      3: { name: 'double_value' },
      5: { name: 'reference_value' },
      6: { name: 'map_value', message: 'google.firestore.v1.MapValue' },
      8: { name: 'geo_point_value' },
      9: { name: 'array_value', message: 'google.firestore.v1.ArrayValue' },
      10: { name: 'timestamp_value', message: TIMESTAMP_TYPE },
      11: { name: 'null_value' },
      17: { name: 'string_value' },
      18: { name: 'bytes_value', bytes: true },
      19: { name: 'field_reference_value' },
    },
  },
  'google.firestore.v1.ArrayValue': {
    fields: { 1: { name: 'values', message: 'google.firestore.v1.Value' } },
  },
  'google.firestore.v1.MapValue': {
    fields: { 1: { name: 'fields', map: { value: 'google.firestore.v1.Value' } } },
  },
};

// ─── google/firestore/v1/write.proto ───

const WRITE: Record<string, MessageDef> = {
  'google.firestore.v1.DocumentChange': {
    fields: {
      1: { name: 'document', message: 'google.firestore.v1.Document' },
      5: { name: 'target_ids', packedVarint: true },
      6: { name: 'removed_target_ids', packedVarint: true },
    },
  },
  'google.firestore.v1.DocumentDelete': {
    fields: {
      1: { name: 'document' },
      4: { name: 'read_time', message: TIMESTAMP_TYPE },
      6: { name: 'removed_target_ids', packedVarint: true },
    },
  },
  'google.firestore.v1.DocumentRemove': {
    fields: {
      1: { name: 'document' },
      2: { name: 'removed_target_ids', packedVarint: true },
      4: { name: 'read_time', message: TIMESTAMP_TYPE },
    },
  },
  'google.firestore.v1.ExistenceFilter': {
    fields: {
      1: { name: 'target_id' },
      2: { name: 'count' },
      3: { name: 'unchanged_names' },
    },
  },
};

// ─── google/firestore/v1/firestore.proto ───

const TARGET_CHANGE_TYPE: Record<number, string> = {
  0: 'NO_CHANGE',
  1: 'ADD',
  2: 'REMOVE',
  3: 'CURRENT',
  4: 'RESET',
};

const FIRESTORE: Record<string, MessageDef> = {
  'google.firestore.v1.ListenRequest': {
    fields: {
      1: { name: 'database' },
      2: { name: 'add_target', message: 'google.firestore.v1.Target' },
      3: { name: 'remove_target' },
      4: { name: 'labels', map: {} },
    },
  },
  'google.firestore.v1.ListenResponse': {
    fields: {
      2: { name: 'target_change', message: 'google.firestore.v1.TargetChange' },
      3: { name: 'document_change', message: 'google.firestore.v1.DocumentChange' },
      4: { name: 'document_delete', message: 'google.firestore.v1.DocumentDelete' },
      5: { name: 'filter', message: 'google.firestore.v1.ExistenceFilter' },
      6: { name: 'document_remove', message: 'google.firestore.v1.DocumentRemove' },
    },
  },
  'google.firestore.v1.Target': {
    fields: {
      2: { name: 'query', message: 'google.firestore.v1.Target.QueryTarget' },
      3: { name: 'documents', message: 'google.firestore.v1.Target.DocumentsTarget' },
      // Opaque server cursor: random bytes that often parse as a plausible
      // message, which is exactly the confident-nonsense case this flag exists
      // to prevent.
      4: { name: 'resume_token', bytes: true },
      5: { name: 'target_id' },
      6: { name: 'once' },
      11: { name: 'read_time', message: TIMESTAMP_TYPE },
      12: { name: 'expected_count', message: 'google.protobuf.Int32Value' },
    },
  },
  'google.firestore.v1.Target.DocumentsTarget': {
    fields: { 2: { name: 'documents' } },
  },
  'google.firestore.v1.Target.QueryTarget': {
    fields: {
      1: { name: 'parent' },
      2: { name: 'structured_query', message: 'google.firestore.v1.StructuredQuery' },
    },
  },
  'google.firestore.v1.TargetChange': {
    fields: {
      1: { name: 'target_change_type', enum: TARGET_CHANGE_TYPE },
      2: { name: 'target_ids', packedVarint: true },
      3: { name: 'cause', message: 'google.rpc.Status' },
      4: { name: 'resume_token', bytes: true },
      6: { name: 'read_time', message: TIMESTAMP_TYPE },
    },
  },
};

// ─── google/firestore/v1/query.proto ───

const FIELD_FILTER_OP: Record<number, string> = {
  0: 'OPERATOR_UNSPECIFIED',
  1: 'LESS_THAN',
  2: 'LESS_THAN_OR_EQUAL',
  3: 'GREATER_THAN',
  4: 'GREATER_THAN_OR_EQUAL',
  5: 'EQUAL',
  6: 'NOT_EQUAL',
  7: 'ARRAY_CONTAINS',
  8: 'IN',
  9: 'ARRAY_CONTAINS_ANY',
  10: 'NOT_IN',
};

const QUERY: Record<string, MessageDef> = {
  'google.firestore.v1.StructuredQuery': {
    fields: {
      1: { name: 'select', message: 'google.firestore.v1.StructuredQuery.Projection' },
      2: { name: 'from', message: 'google.firestore.v1.StructuredQuery.CollectionSelector' },
      3: { name: 'where', message: 'google.firestore.v1.StructuredQuery.Filter' },
      4: { name: 'order_by', message: 'google.firestore.v1.StructuredQuery.Order' },
      5: { name: 'limit', message: 'google.protobuf.Int32Value' },
      6: { name: 'offset' },
      7: { name: 'start_at' },
      8: { name: 'end_at' },
    },
  },
  'google.firestore.v1.StructuredQuery.CollectionSelector': {
    fields: {
      2: { name: 'collection_id' },
      3: { name: 'all_descendants', bool: true },
    },
  },
  'google.firestore.v1.StructuredQuery.Filter': {
    fields: {
      1: { name: 'composite_filter', message: 'google.firestore.v1.StructuredQuery.CompositeFilter' },
      2: { name: 'field_filter', message: 'google.firestore.v1.StructuredQuery.FieldFilter' },
      3: { name: 'unary_filter', message: 'google.firestore.v1.StructuredQuery.UnaryFilter' },
    },
  },
  'google.firestore.v1.StructuredQuery.CompositeFilter': {
    fields: {
      1: { name: 'op', enum: { 0: 'OPERATOR_UNSPECIFIED', 1: 'AND', 2: 'OR' } },
      2: { name: 'filters', message: 'google.firestore.v1.StructuredQuery.Filter' },
    },
  },
  'google.firestore.v1.StructuredQuery.FieldFilter': {
    fields: {
      1: { name: 'field', message: 'google.firestore.v1.StructuredQuery.FieldReference' },
      2: { name: 'op', enum: FIELD_FILTER_OP },
      3: { name: 'value', message: 'google.firestore.v1.Value' },
    },
  },
  'google.firestore.v1.StructuredQuery.UnaryFilter': {
    fields: {
      1: { name: 'op' },
      2: { name: 'field', message: 'google.firestore.v1.StructuredQuery.FieldReference' },
    },
  },
  'google.firestore.v1.StructuredQuery.FieldReference': {
    fields: { 2: { name: 'field_path' } },
  },
  'google.firestore.v1.StructuredQuery.Order': {
    fields: {
      1: { name: 'field', message: 'google.firestore.v1.StructuredQuery.FieldReference' },
      2: {
        name: 'direction',
        enum: { 0: 'DIRECTION_UNSPECIFIED', 1: 'ASCENDING', 2: 'DESCENDING' },
      },
    },
  },
  'google.firestore.v1.StructuredQuery.Projection': {
    fields: {
      2: { name: 'fields', message: 'google.firestore.v1.StructuredQuery.FieldReference' },
    },
  },
};

const SCHEMAS: Record<string, MessageDef> = {
  ...WELL_KNOWN,
  ...DOCUMENT,
  ...WRITE,
  ...FIRESTORE,
  ...QUERY,
};

/** Root message types for a gRPC method, keyed by `<package>.<Service>/<Method>`. */
const METHODS: Record<string, { request?: string; response?: string }> = {
  'google.firestore.v1.Firestore/Listen': {
    request: 'google.firestore.v1.ListenRequest',
    response: 'google.firestore.v1.ListenResponse',
  },
};

export function lookupMessage(typeName: string | undefined): MessageDef | undefined {
  return typeName ? SCHEMAS[typeName] : undefined;
}

/**
 * Root message type for one side of a gRPC call, or `undefined` when the
 * service isn't in the table (in which case decoding stays numeric).
 *
 * `url` is the captured request URL; the gRPC method is its path, in the form
 * `/<package>.<Service>/<Method>`.
 */
export function rootTypeForUrl(
  url: string,
  direction: 'request' | 'response',
): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const entry = METHODS[path.replace(/^\//, '')];
  return direction === 'request' ? entry?.request : entry?.response;
}
