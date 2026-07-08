/**
 * IPC message protocol between the main process (dispatcher) and worker
 * child processes. Each worker is assigned a device and runs test files
 * sent to it by the dispatcher.
 *
 * @see PILOT-106
 */

import type { TestResult, SuiteResult } from './runner.js';
import { normalizeGrep, type TapsmithConfig } from './config.js';

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
  /**
   * Per-project grep filters, intersected with the root `grep` from the worker's
   * `SerializedConfig`. A test must match at least one entry in each set.
   */
  projectGrep?: SerializedRegExp[]
  /**
   * Per-project grep-invert filters, unioned with the root `grepInvert` from
   * the worker's `SerializedConfig`.
   */
  projectGrepInvert?: SerializedRegExp[]
}

/** IPC-safe subset of UseOptions for project-level overrides. */
export interface RunFileUseOptions {
  timeout?: number
  screenshot?: 'always' | 'only-on-failure' | 'never'
  retries?: number
  trace?: 'off' | 'on' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure' | 'retain-on-first-failure' | 'retain-on-failure-and-retries'
  video?: 'off' | 'on' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure' | 'retain-on-first-failure' | 'retain-on-failure-and-retries'
  appState?: string
  baseURL?: string
  extraHTTPHeaders?: Record<string, string>
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

export interface TestStartMessage {
  type: 'test-start'
  workerId: number
  fullName: string
  filePath: string
  projectName?: string
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

export interface FileRetryMessage {
  type: 'file-retry'
  workerId: number
  filePath: string
}

export interface WorkerErrorMessage {
  type: 'error'
  workerId: number
  error: { message: string; stack?: string }
}

export type WorkerToMainMessage =
  | ReadyMessage
  | WorkerProgressMessage
  | TestStartMessage
  | TestEndMessage
  | FileStartMessage
  | FileDoneMessage
  | FileRetryMessage
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
  'Agent connection dropped',
  // TCP-reset variant of a dropped connection ("Agent connection lost during
  // read" / "... and agent is unreachable", agent_comms.rs). Without it, a
  // reset-shaped transient drop bypasses every recovery layer (PILOT-282).
  'Agent connection lost',
  'Not connected to agent',
  'Timed out connecting to agent socket',
  'Failed to connect to agent socket',
  'Failed to reconnect to agent',
  'Agent socket not reachable',
  'Unable to lookup in current state',
  'server died',
  'xcodebuild exited with',
  '4 DEADLINE_EXCEEDED',
  '14 UNAVAILABLE',
  'No connection established',
  'ECONNREFUSED',
  'session recovered during before test',
  'Network capture disabled',
] as const;

/**
 * Check whether an error represents a recoverable infrastructure failure
 * (agent disconnection, gRPC unavailability, etc.) as opposed to a real
 * test assertion failure.
 */
export function isRecoverableInfrastructureError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RECOVERABLE_INFRASTRUCTURE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Run a device-infrastructure setup step, retrying once if it fails with a
 * recoverable infrastructure error (e.g. device selection tripping its
 * deadline because `simctl list` stalls while simulators boot on a loaded
 * runner). `onRetry` fires before the second attempt so callers can report
 * progress their own way.
 */
export async function retryOnceOnRecoverableInfra<T>(
  fn: () => Promise<T>,
  onRetry: (err: unknown) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRecoverableInfrastructureError(err)) throw err;
    onRetry(err);
    return fn();
  }
}

/**
 * Agent startup failures worth one in-place retry: the daemon's own launch
 * failure text, plus transport-level errors (deadline exceeded, dropped
 * connection) that mean the startAgent call itself died mid-flight — a cold
 * first xcodebuild often warms DerivedData/simulator for the second attempt.
 */
export function isRetryableAgentStartError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('xcodebuild exited') ||
    message.includes('Timed out waiting for iOS agent') ||
    isRecoverableInfrastructureError(err)
  );
}

// ─── Serialized types (safe for IPC / structured clone) ───

/** Config fields needed by workers (subset of TapsmithConfig). */
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
  video?: string | Record<string, unknown>
  platform?: 'android' | 'ios'
  app?: string
  iosXctestrun?: string
  simulator?: string
  resetAppDeepLink?: string
  resetAppWaitMs?: number
  baseURL?: string
  extraHTTPHeaders?: Record<string, string>
  /** RegExp filters for test fullNames. Source/flags are serialized for IPC. */
  grep?: SerializedRegExp[]
  grepInvert?: SerializedRegExp[]
}

/** Convert a TapsmithConfig into the IPC-safe subset needed by worker child processes. */
export function serializeConfig(config: TapsmithConfig): SerializedConfig {
  return {
    timeout: config.timeout,
    retries: config.retries,
    screenshot: config.screenshot,
    rootDir: config.rootDir,
    outputDir: config.outputDir,
    apk: config.apk,
    activity: config.activity,
    package: config.package,
    agentApk: config.agentApk,
    agentTestApk: config.agentTestApk,
    trace: typeof config.trace === 'string' || typeof config.trace === 'object'
      ? config.trace
      : undefined,
    video: typeof config.video === 'string' || typeof config.video === 'object'
      ? config.video
      : undefined,
    platform: config.platform,
    app: config.app,
    iosXctestrun: config.iosXctestrun,
    simulator: config.simulator,
    resetAppDeepLink: config.resetAppDeepLink,
    resetAppWaitMs: config.resetAppWaitMs,
    baseURL: config.baseURL,
    extraHTTPHeaders: config.extraHTTPHeaders,
    grep: serializeRegExpArray(normalizeGrep(config.grep)),
    grepInvert: serializeRegExpArray(normalizeGrep(config.grepInvert)),
  };
}

/** IPC-safe RegExp representation (RegExp instances don't survive structured clone reliably). */
export interface SerializedRegExp {
  source: string
  flags: string
}

export function serializeRegExp(re: RegExp): SerializedRegExp {
  return { source: re.source, flags: re.flags };
}

export function serializeRegExpArray(values: RegExp[] | undefined): SerializedRegExp[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map(serializeRegExp);
}

export function deserializeRegExpArray(values: SerializedRegExp[] | undefined): RegExp[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((v) => new RegExp(v.source, v.flags));
}

/** TestResult with Error serialized to plain object for IPC. */
export interface SerializedTestResult {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  error?: { message: string; stack?: string }
  firstAttemptError?: { message: string; stack?: string }
  failedAttemptArtifacts?: { screenshot?: boolean; trace?: boolean; video?: boolean }
  screenshotPath?: string
  tracePath?: string
  videoPath?: string
  workerIndex: number
  project?: string
  retry?: number
  _willRetry?: boolean
  filePath?: string
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
    firstAttemptError: result.firstAttemptError
      ? { message: result.firstAttemptError.message, stack: result.firstAttemptError.stack }
      : undefined,
    failedAttemptArtifacts: result.failedAttemptArtifacts,
    screenshotPath: result.screenshotPath,
    tracePath: result.tracePath,
    videoPath: result.videoPath,
    workerIndex,
    project: result.project,
    retry: result.retry,
    _willRetry: result._willRetry,
    filePath: result.filePath,
  };
}

export function serializeSuiteResult(suite: SuiteResult, workerIndex: number): SerializedSuiteResult {
  return {
    name: suite.name,
    tests: suite.tests.map((t) => serializeTestResult(t, workerIndex)),
    suites: suite.suites.map((s) => serializeSuiteResult(s, workerIndex)),
    durationMs: suite.durationMs,
  };
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
    firstAttemptError: s.firstAttemptError
      ? Object.assign(new Error(s.firstAttemptError.message), { stack: s.firstAttemptError.stack })
      : undefined,
    failedAttemptArtifacts: s.failedAttemptArtifacts,
    screenshotPath: s.screenshotPath,
    tracePath: s.tracePath,
    videoPath: s.videoPath,
    workerIndex: s.workerIndex,
    project: s.project,
    retry: s.retry,
    _willRetry: s._willRetry,
    filePath: s.filePath,
  };
}

export function deserializeSuiteResult(s: SerializedSuiteResult): SuiteResult {
  return {
    name: s.name,
    tests: s.tests.map(deserializeTestResult),
    suites: s.suites.map(deserializeSuiteResult),
    durationMs: s.durationMs,
  };
}
