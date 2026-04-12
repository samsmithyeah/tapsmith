/**
 * WebSocket protocol for UI mode.
 *
 * Defines all message types exchanged between the UI server and the
 * browser-based Preact SPA. JSON messages use a `type` discriminator;
 * binary WebSocket frames carry device screenshots.
 *
 * @see PILOT-87
 */

import type { AnyTraceEvent } from '../trace/types.js';

// ─── Shared Types ───

/** Per-worker status used by UI components. */
export interface WorkerInfo {
  workerId: number
  deviceSerial: string
  /** Friendly display name, e.g. "iPhone 16 #1" for iOS or the serial for Android. */
  displayName: string
  status: 'idle' | 'running' | 'done' | 'initializing' | 'error'
  currentFile?: string
  currentTest?: string
  passed: number
  failed: number
  skipped: number
  platform?: 'android' | 'ios'
  /** Logical-point → pixel scale. iOS only; unset for Android (= 1). */
  devicePixelRatio?: number
}

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
  /** When running a single file/test in a multi-project config, the project
   * the file belongs to. Lets the client scope trace clearing to just that
   * project's copy and leave sibling projects' traces intact. */
  projectName?: string
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
  /** Worker that is running this test (multi-worker mode only). */
  workerId?: number
  /** Project this test belongs to. When set, the SPA scopes the update to
   * the matching project node — required when the same file is shared
   * across projects (multi-device configs). */
  projectName?: string
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
  /** Worker that ran this test (multi-worker mode only). */
  workerId?: number
  /** Project this test belongs to. When set, the SPA scopes the update to
   * the matching project node — required when the same file is shared
   * across projects (multi-device configs). */
  projectName?: string
}

export interface FileStatusMessage {
  type: 'file-status'
  filePath: string
  status: 'running' | 'done'
  /** Project this file belongs to. When set, the SPA scopes the update to
   * the matching project node. */
  projectName?: string
}

export interface TraceEventMessage {
  type: 'trace-event'
  /** The full name of the test this event belongs to. */
  testFullName: string
  /** Project the test belongs to. Used to scope trace storage so the same
   * test running under multiple projects (multi-device configs) doesn't
   * collide on a single trace map entry. */
  projectName?: string
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
  status: 'idle' | 'running' | 'done' | 'initializing' | 'error'
  passed: number
  failed: number
  skipped: number
}

export interface WorkersInfoMessage {
  type: 'workers-info'
  workers: Array<{
    workerId: number
    deviceSerial: string
    displayName: string
    platform?: 'android' | 'ios'
    devicePixelRatio?: number
  }>
}

export interface DeviceInfoMessage {
  type: 'device-info'
  serial: string
  model?: string
  isEmulator: boolean
  screenWidth?: number
  screenHeight?: number
  platform?: 'android' | 'ios'
  pilotVersion?: string
  devicePixelRatio?: number
}

export interface SourceMessage {
  type: 'source'
  fileName: string
  content: string
}

export interface NetworkMessage {
  type: 'network'
  testFullName: string
  /** Project the test belongs to. Used to scope trace storage in multi-device
   * configs so the same test under multiple projects doesn't collide. */
  projectName?: string
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
  | WorkersInfoMessage
  | DeviceInfoMessage
  | SourceMessage
  | NetworkMessage
  | ErrorMessage

// ─── Client → Server messages ───

export interface RunTestCommand {
  type: 'run-test'
  fullName: string
  filePath: string
  /** Project the test belongs to. Required when the same file is shared
   * across multiple projects (e.g. one Android and one iOS project both
   * matching `**\/*.test.ts`) so the server can route to the correct device. */
  projectName?: string
  /** When true, run dependency projects before this test. */
  runDeps?: boolean
}

export interface RunFileCommand {
  type: 'run-file'
  filePath: string
  /** Project the file belongs to. Required when the same file is shared
   * across multiple projects so the server can route to the correct device. */
  projectName?: string
  /** When true, run dependency projects before this file. */
  runDeps?: boolean
}

export interface RunAllCommand {
  type: 'run-all'
}

export interface RunProjectCommand {
  type: 'run-project'
  projectName: string
  /** When true, run dependency projects before this project. */
  runDeps?: boolean
}

export interface RunFailedCommand {
  type: 'run-failed'
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

export interface SelectWorkerCommand {
  type: 'select-worker'
  /** Worker ID whose device to mirror. */
  workerId: number
}

export interface SelectWorkerViewCommand {
  type: 'select-worker-view'
  /** 'all' to poll all workers simultaneously, or a specific worker ID. */
  mode: 'all' | number
}

export interface RespawnWorkerCommand {
  type: 'respawn-worker'
  workerId: number
}

/** Union of all client → server JSON messages. */
export type ClientMessage =
  | RunTestCommand
  | RunFileCommand
  | RunAllCommand
  | RunFailedCommand
  | RunProjectCommand
  | StopRunCommand
  | ToggleWatchCommand
  | RequestHierarchyCommand
  | TapCoordinatesCommand
  | SetFilterCommand
  | SelectWorkerCommand
  | SelectWorkerViewCommand
  | RespawnWorkerCommand

// ─── Binary frame helpers ───

/**
 * Screen frames are sent as binary WebSocket messages:
 *   bytes 0-3:  uint32 BE frame sequence number
 *   bytes 4-5:  uint16 BE worker ID (0 for single-worker mode)
 *   bytes 6-9:  uint16 BE width, uint16 BE height
 *   bytes 10+:  raw PNG data
 */
export const SCREEN_FRAME_HEADER_SIZE = 10;

export function encodeScreenFrame(
  seq: number,
  workerId: number,
  width: number,
  height: number,
  png: Buffer,
): Buffer {
  const header = Buffer.alloc(SCREEN_FRAME_HEADER_SIZE);
  header.writeUInt32BE(seq, 0);
  header.writeUInt16BE(workerId, 4);
  header.writeUInt16BE(width, 6);
  header.writeUInt16BE(height, 8);
  return Buffer.concat([header, png]);
}

export function decodeScreenFrameHeader(data: ArrayBuffer): {
  seq: number
  workerId: number
  width: number
  height: number
  pngOffset: number
} {
  const view = new DataView(data);
  return {
    seq: view.getUint32(0),
    workerId: view.getUint16(4),
    width: view.getUint16(6),
    height: view.getUint16(8),
    pngOffset: SCREEN_FRAME_HEADER_SIZE,
  };
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

// ─── UI Worker IPC (persistent worker ↔ UI server) ───

/** Server → UI worker: initialize with device, daemon, config. */
export interface UIWorkerInitMessage {
  type: 'init'
  workerId: number
  deviceSerial: string
  daemonPort: number
  config: import('../worker-protocol.js').SerializedConfig
  screenshotDir?: string
  freshEmulator?: boolean
}

/** Server → UI worker: run a test file. */
export interface UIWorkerRunFileMessage {
  type: 'run-file'
  filePath: string
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions
  projectName?: string
  testFilter?: string
}

/** Server → UI worker: shut down gracefully. */
export interface UIWorkerShutdownMessage {
  type: 'shutdown'
}

/** Server → UI worker: abort the current run (let current test finish, skip rest). */
export interface UIWorkerAbortMessage {
  type: 'abort'
}

export type UIWorkerMessage =
  | UIWorkerInitMessage
  | UIWorkerRunFileMessage
  | UIWorkerShutdownMessage
  | UIWorkerAbortMessage

/** UI worker → server: worker is ready. */
export interface UIWorkerReadyMessage {
  type: 'ready'
  workerId: number
}

/** UI worker → server: progress during initialization. */
export interface UIWorkerProgressMessage {
  type: 'progress'
  workerId: number
  message: string
}

/** UI worker → server: test starting. */
export interface UIWorkerTestStartMessage {
  type: 'test-start'
  workerId: number
  fullName: string
  filePath: string
}

/** UI worker → server: test completed. */
export interface UIWorkerTestEndMessage {
  type: 'test-end'
  workerId: number
  result: import('../worker-protocol.js').SerializedTestResult
}

/** UI worker → server: real-time trace event. */
export interface UIWorkerTraceEventMessage {
  type: 'trace-event'
  workerId: number
  event: AnyTraceEvent
  screenshotBefore?: string
  screenshotAfter?: string
  hierarchyBefore?: string
  hierarchyAfter?: string
}

/** UI worker → server: test source code. */
export interface UIWorkerSourceMessage {
  type: 'source'
  workerId: number
  fileName: string
  content: string
}

/** UI worker → server: network entries. */
export interface UIWorkerNetworkMessage {
  type: 'network'
  workerId: number
  entries: import('../trace/types.js').NetworkEntry[]
}

/** UI worker → server: file execution completed. */
export interface UIWorkerFileDoneMessage {
  type: 'file-done'
  workerId: number
  filePath: string
  results: import('../worker-protocol.js').SerializedTestResult[]
  suite: import('../worker-protocol.js').SerializedSuiteResult
}

/** UI worker → server: error. */
export interface UIWorkerErrorMessage {
  type: 'error'
  workerId: number
  error: { message: string; stack?: string }
}

export type UIWorkerChildMessage =
  | UIWorkerReadyMessage
  | UIWorkerProgressMessage
  | UIWorkerTestStartMessage
  | UIWorkerTestEndMessage
  | UIWorkerTraceEventMessage
  | UIWorkerSourceMessage
  | UIWorkerNetworkMessage
  | UIWorkerFileDoneMessage
  | UIWorkerErrorMessage
