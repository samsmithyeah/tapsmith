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
  /** Project-level use options to apply as base layer. */
  projectUseOptions?: RunFileUseOptions
  /** Project name for reporter grouping. */
  projectName?: string
}

/** IPC-safe subset of UseOptions for project-level overrides. */
export interface RunFileUseOptions {
  timeout?: number
  screenshot?: 'always' | 'only-on-failure' | 'never'
  retries?: number
  trace?: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries'
  appState?: string
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

// ─── Infrastructure error detection ───

/**
 * Error message patterns that indicate recoverable infrastructure failures.
 * When a test fails with one of these patterns, the worker will attempt to
 * recover the session and retry the file rather than permanently failing.
 */
export const RECOVERABLE_INFRASTRUCTURE_PATTERNS = [
  'Agent command timed out',
  'Agent returned empty response',
  'Not connected to agent',
  'Timed out connecting to agent socket',
  'Failed to connect to agent socket',
  '14 UNAVAILABLE',
  'No connection established',
  'ECONNREFUSED',
] as const

/**
 * Check whether an error represents a recoverable infrastructure failure
 * (agent disconnection, gRPC unavailability, etc.) as opposed to a real
 * test assertion failure.
 */
export function isRecoverableInfrastructureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return RECOVERABLE_INFRASTRUCTURE_PATTERNS.some((pattern) => message.includes(pattern))
}

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
  trace?: string | Record<string, unknown>
}

/** TestResult with Error serialized to plain object for IPC. */
export interface SerializedTestResult {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  error?: { message: string; stack?: string }
  screenshotPath?: string
  tracePath?: string
  workerIndex: number
  project?: string
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
    tracePath: result.tracePath,
    workerIndex,
    project: result.project,
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
    tracePath: s.tracePath,
    workerIndex: s.workerIndex,
    project: s.project,
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
