// Single point of contact with the UI mode wire protocol.
//
// The suite runs against the built bundle in `packages/tapsmith/dist/`, the same
// artifact `ui-server.ts` serves to real users, so the protocol comes from there
// too — types and `encodeScreenFrame` stay in lockstep with the SPA under test
// instead of being restated (and drifting) here.
//
// It is a relative path rather than a `tapsmith/...` package import because that
// package's `exports` map only exposes `.`; widening it to reach test-only
// internals would change the published package's public surface.
export {
  encodeScreenFrame,
  decodeBinaryFrame,
  FRAME_KIND_SCREENSHOT,
  SCREEN_FRAME_HEADER_SIZE,
} from "../packages/tapsmith/dist/ui-mode/ui-protocol.js"

export type {
  ServerMessage,
  ClientMessage,
  TestTreeNode,
  TestNodeStatus,
  TestTreeMessage,
  TestStatusMessage,
  TestStartMessage,
  RunStartMessage,
  RunEndMessage,
  RunStateMessage,
  FileStatusMessage,
  TraceEventMessage,
  HierarchyUpdateMessage,
  WatchEventMessage,
  WorkerStatusMessage,
  WorkersInfoMessage,
  DeviceInfoMessage,
  SourceMessage,
  NetworkMessage,
  ErrorMessage,
  McpStatusMessage,
  McpToolCallMessage,
  RunProgressMessage,
} from "../packages/tapsmith/dist/ui-mode/ui-protocol.js"
