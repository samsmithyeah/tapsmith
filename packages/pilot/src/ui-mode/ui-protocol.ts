/**
 * WebSocket protocol for UI mode.
 *
 * Defines all message types exchanged between the UI server and the
 * browser-based Preact SPA. JSON messages use a `type` discriminator;
 * binary WebSocket frames carry device screenshots.
 *
 * @see PILOT-87
 */

import type { AnyTraceEvent } from '../trace/types.js'

// ─── Test Tree ───

export interface TestTreeNode {
  /** Deterministic ID: filePath + suite chain + test name. */
  id: string
  type: 'project' | 'file' | 'suite' | 'test'
  name: string
  filePath: string
  /** Fully qualified name: "suite > nested > test name". */
  fullName: string
  status: TestNodeStatus
  duration?: number
  error?: string
  children?: TestTreeNode[]
  watchEnabled?: boolean
  /** For project nodes: names of projects this depends on. */
  dependencies?: string[]
}

export type TestNodeStatus =
  | 'idle'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'

// ─── Server → Client messages ───

export interface TestTreeMessage {
  type: 'test-tree'
  files: TestTreeNode[]
}

export interface RunStartMessage {
  type: 'run-start'
  fileCount: number
  /** When running a single file, the file path. Used to scope trace clearing. */
  filePath?: string
  /** When running a single test, the test fullName. Used to scope trace clearing. */
  testFilter?: string
}

export interface RunEndMessage {
  type: 'run-end'
  status: 'passed' | 'failed'
  duration: number
  passed: number
  failed: number
  skipped: number
}

export interface TestStartMessage {
  type: 'test-start'
  fullName: string
  filePath: string
}

export interface TestStatusMessage {
  type: 'test-status'
  /** Test full name (unique within a run). */
  fullName: string
  filePath: string
  status: TestNodeStatus
  duration?: number
  error?: string
  tracePath?: string
}

export interface FileStatusMessage {
  type: 'file-status'
  filePath: string
  status: 'running' | 'done'
}

export interface TraceEventMessage {
  type: 'trace-event'
  /** The full name of the test this event belongs to. */
  testFullName: string
  event: AnyTraceEvent
  /** Base64-encoded PNG screenshot taken before the action. */
  screenshotBefore?: string
  /** Base64-encoded PNG screenshot taken after the action. */
  screenshotAfter?: string
  /** Hierarchy XML captured before the action. */
  hierarchyBefore?: string
  /** Hierarchy XML captured after the action. */
  hierarchyAfter?: string
}

export interface HierarchyUpdateMessage {
  type: 'hierarchy-update'
  xml: string
}

export interface WatchEventMessage {
  type: 'watch-event'
  filePath: string
  event: 'changed' | 'added' | 'removed' | 'watch-enabled' | 'watch-disabled'
}

export interface WorkerStatusMessage {
  type: 'worker-status'
  workerId: number
  deviceSerial: string
  deviceModel?: string
  currentFile?: string
  currentTest?: string
  status: 'idle' | 'running' | 'done'
  passed: number
  failed: number
  skipped: number
}

export interface DeviceInfoMessage {
  type: 'device-info'
  serial: string
  model?: string
  isEmulator: boolean
  screenWidth?: number
  screenHeight?: number
}

export interface SourceMessage {
  type: 'source'
  fileName: string
  content: string
}

export interface NetworkMessage {
  type: 'network'
  entries: import('../trace/types.js').NetworkEntry[]
}

export interface ErrorMessage {
  type: 'error'
  message: string
  stack?: string
}

/** Union of all server → client JSON messages. */
export type ServerMessage =
  | TestTreeMessage
  | RunStartMessage
  | RunEndMessage
  | TestStartMessage
  | TestStatusMessage
  | FileStatusMessage
  | TraceEventMessage
  | HierarchyUpdateMessage
  | WatchEventMessage
  | WorkerStatusMessage
  | DeviceInfoMessage
  | SourceMessage
  | NetworkMessage
  | ErrorMessage

// ─── Client → Server messages ───

export interface RunTestCommand {
  type: 'run-test'
  fullName: string
  filePath: string
  /** When true, run dependency projects before this test. */
  runDeps?: boolean
}

export interface RunFileCommand {
  type: 'run-file'
  filePath: string
  /** When true, run dependency projects before this file. */
  runDeps?: boolean
}

export interface RunAllCommand {
  type: 'run-all'
}

export interface RunProjectCommand {
  type: 'run-project'
  projectName: string
}

export interface StopRunCommand {
  type: 'stop-run'
}

export interface ToggleWatchCommand {
  type: 'toggle-watch'
  /** File path to toggle, or 'all' for all files. */
  filePath: string
}

export interface RequestHierarchyCommand {
  type: 'request-hierarchy'
}

export interface TapCoordinatesCommand {
  type: 'tap-coordinates'
  /** X coordinate normalized to 0–1 range. */
  x: number
  /** Y coordinate normalized to 0–1 range. */
  y: number
}

export interface SetFilterCommand {
  type: 'set-filter'
  name?: string
  status?: 'all' | 'passed' | 'failed' | 'skipped'
}

/** Union of all client → server JSON messages. */
export type ClientMessage =
  | RunTestCommand
  | RunFileCommand
  | RunAllCommand
  | RunProjectCommand
  | StopRunCommand
  | ToggleWatchCommand
  | RequestHierarchyCommand
  | TapCoordinatesCommand
  | SetFilterCommand

// ─── Binary frame helpers ───

/**
 * Screen frames are sent as binary WebSocket messages:
 *   bytes 0-3:  uint32 BE frame sequence number
 *   bytes 4-7:  uint16 BE width, uint16 BE height
 *   bytes 8+:   raw PNG data
 */
export const SCREEN_FRAME_HEADER_SIZE = 8

export function encodeScreenFrame(
  seq: number,
  width: number,
  height: number,
  png: Buffer,
): Buffer {
  const header = Buffer.alloc(SCREEN_FRAME_HEADER_SIZE)
  header.writeUInt32BE(seq, 0)
  header.writeUInt16BE(width, 4)
  header.writeUInt16BE(height, 6)
  return Buffer.concat([header, png])
}

export function decodeScreenFrameHeader(data: ArrayBuffer): {
  seq: number
  width: number
  height: number
  pngOffset: number
} {
  const view = new DataView(data)
  return {
    seq: view.getUint32(0),
    width: view.getUint16(4),
    height: view.getUint16(6),
    pngOffset: SCREEN_FRAME_HEADER_SIZE,
  }
}

// ─── IPC protocol (child process ↔ UI server) ───

export interface UIRunMessage {
  type: 'run'
  daemonAddress: string
  deviceSerial: string
  filePath: string
  config: import('../worker-protocol.js').SerializedConfig
  screenshotDir?: string
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions
  projectName?: string
  /** Filter to a specific test by fullName (for single-test runs). */
  testFilter?: string
}

export interface UIRunTestStartMessage {
  type: 'test-start'
  fullName: string
  filePath: string
}

export interface UIRunTestEndMessage {
  type: 'test-end'
  result: import('../worker-protocol.js').SerializedTestResult
}

export interface UIRunFileDoneMessage {
  type: 'file-done'
  filePath: string
  results: import('../worker-protocol.js').SerializedTestResult[]
  suite: import('../worker-protocol.js').SerializedSuiteResult
}

export interface UIRunTraceEventMessage {
  type: 'trace-event'
  event: AnyTraceEvent
  screenshotBefore?: string
  screenshotAfter?: string
  hierarchyBefore?: string
  hierarchyAfter?: string
}

export interface UIRunSourceMessage {
  type: 'source'
  fileName: string
  content: string
}

export interface UIRunNetworkMessage {
  type: 'network'
  entries: import('../trace/types.js').NetworkEntry[]
}

export interface UIRunErrorMessage {
  type: 'error'
  error: { message: string; stack?: string }
}

export type UIRunChildMessage =
  | UIRunTestStartMessage
  | UIRunTestEndMessage
  | UIRunFileDoneMessage
  | UIRunTraceEventMessage
  | UIRunSourceMessage
  | UIRunNetworkMessage
  | UIRunErrorMessage

// ─── Discovery IPC ───

export interface UIDiscoverMessage {
  type: 'discover'
  filePath: string
}

export interface UIDiscoverResultMessage {
  type: 'discover-result'
  filePath: string
  tree: TestTreeNode
}

export interface UIDiscoverErrorMessage {
  type: 'discover-error'
  filePath: string
  error: { message: string; stack?: string }
}

export type UIDiscoverChildMessage =
  | UIDiscoverResultMessage
  | UIDiscoverErrorMessage
