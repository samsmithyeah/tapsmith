// Single point of contact with the trace-archive format.
//
// Same rationale as `protocol.ts`: the types come from the SDK's own
// `trace/types.ts` in the built output, so a fixture whose shape drifts from the
// real archive fails typecheck rather than silently exercising nothing.
export type {
  AnyTraceEvent,
  TraceEvent,
  ActionTraceEvent,
  AssertionTraceEvent,
  ConsoleTraceEvent,
  GroupTraceEvent,
  TraceMetadata,
  TraceDeviceInfo,
  NetworkEntry,
  SourceLocation,
} from "../packages/tapsmith/dist/trace/types.js"
