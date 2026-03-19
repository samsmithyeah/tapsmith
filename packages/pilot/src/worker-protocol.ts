/**
 * IPC message protocol between the main process (dispatcher) and worker
 * child processes. Each worker is assigned a device and runs test files
 * sent to it by the dispatcher.
 *
 * @see PILOT-106
 */

import type { TestResult, SuiteResult } from './runner.js'

// ─── Main → Worker messages ───

export interface InitMessage {
  type: 'init'
  workerId: number
  deviceSerial: string
  daemonPort: number
  config: SerializedConfig
  /** True when the emulator was freshly launched for this run (needs warmup). */
  freshEmulator?: boolean
}

export interface RunFileMessage {
  type: 'run-file'
  filePath: string
}

export interface ShutdownMessage {
  type: 'shutdown'
}

export type MainToWorkerMessage = InitMessage | RunFileMessage | ShutdownMessage

// ─── Worker → Main messages ───

export interface ReadyMessage {
  type: 'ready'
  workerId: number
}

export interface WorkerProgressMessage {
  type: 'progress'
  workerId: number
  message: string
}

export interface TestEndMessage {
  type: 'test-end'
  workerId: number
  result: SerializedTestResult
}

export interface FileStartMessage {
  type: 'file-start'
  workerId: number
  filePath: string
}

export interface FileDoneMessage {
  type: 'file-done'
  workerId: number
  filePath: string
  suite: SerializedSuiteResult
  results: SerializedTestResult[]
}

export interface WorkerErrorMessage {
  type: 'error'
  workerId: number
  error: { message: string; stack?: string }
}

export type WorkerToMainMessage =
  | ReadyMessage
  | WorkerProgressMessage
  | TestEndMessage
  | FileStartMessage
  | FileDoneMessage
  | WorkerErrorMessage

// ─── Serialized types (safe for IPC / structured clone) ───

/** Config fields needed by workers (subset of PilotConfig). */
export interface SerializedConfig {
  timeout: number
  retries: number
  screenshot: 'always' | 'only-on-failure' | 'never'
  rootDir: string
  outputDir: string
  apk?: string
  activity?: string
  package?: string
  agentApk?: string
  agentTestApk?: string
}

/** TestResult with Error serialized to plain object for IPC. */
export interface SerializedTestResult {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  error?: { message: string; stack?: string }
  screenshotPath?: string
  workerIndex: number
}

export interface SerializedSuiteResult {
  name: string
  tests: SerializedTestResult[]
  suites: SerializedSuiteResult[]
  durationMs: number
}

// ─── Serialization helpers ───

export function serializeTestResult(result: TestResult, workerIndex: number): SerializedTestResult {
  return {
    name: result.name,
    fullName: result.fullName,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error
      ? { message: result.error.message, stack: result.error.stack }
      : undefined,
    screenshotPath: result.screenshotPath,
    workerIndex,
  }
}

export function serializeSuiteResult(suite: SuiteResult, workerIndex: number): SerializedSuiteResult {
  return {
    name: suite.name,
    tests: suite.tests.map((t) => serializeTestResult(t, workerIndex)),
    suites: suite.suites.map((s) => serializeSuiteResult(s, workerIndex)),
    durationMs: suite.durationMs,
  }
}

export function deserializeTestResult(s: SerializedTestResult): TestResult & { workerIndex: number } {
  return {
    name: s.name,
    fullName: s.fullName,
    status: s.status,
    durationMs: s.durationMs,
    error: s.error
      ? Object.assign(new Error(s.error.message), { stack: s.error.stack })
      : undefined,
    screenshotPath: s.screenshotPath,
    workerIndex: s.workerIndex,
  }
}

export function deserializeSuiteResult(s: SerializedSuiteResult): SuiteResult {
  return {
    name: s.name,
    tests: s.tests.map(deserializeTestResult),
    suites: s.suites.map(deserializeSuiteResult),
    durationMs: s.durationMs,
  }
}
