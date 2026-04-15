/**
 * Trace data model types.
 *
 * Defines the schema for trace archives produced by the Pilot test runner.
 * A trace archive is a .zip file containing:
 *   - trace.json     — NDJSON event log
 *   - metadata.json  — device/test/version info
 *   - screenshots/   — PNGs keyed by action index
 *   - hierarchy/     — View hierarchy XML snapshots
 *   - logcat/        — Logcat segments per action
 *   - console/       — Test-code console output per action
 *   - sources/       — Test source files (optional)
 *   - attachments/   — User-added attachments
 *   - network.json   — NDJSON network request log
 *   - network/       — Large request/response bodies
 */

// ─── Trace Event Types ───

export type TraceEventType =
  | 'action'
  | 'assertion'
  | 'group-start'
  | 'group-end'
  | 'console'
  | 'attachment'
  | 'error'
  | 'step-start'
  | 'step-end'

/** Action categories for display grouping. */
export type ActionCategory =
  | 'tap'
  | 'type'
  | 'swipe'
  | 'scroll'
  | 'press-key'
  | 'navigation'
  | 'device'
  | 'assertion'
  | 'screenshot'
  | 'other'

/** Console output level. */
export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug'


// ─── Core Event Schema ───

export interface TraceEvent {
  /** Event type discriminator. */
  type: TraceEventType
  /** Monotonic action index (0-based). */
  actionIndex: number
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number
  /** Device ID for multi-device support. */
  deviceId?: string
}

export interface ActionTraceEvent extends TraceEvent {
  type: 'action'
  /** Action category for display. */
  category: ActionCategory
  /** Human-readable action name (e.g. "tap", "type", "swipe"). */
  action: string
  /** Serialized selector, if applicable. */
  selector?: string
  /** Input value for type/clearAndType actions. */
  inputValue?: string
  /** Duration of the action in milliseconds. */
  duration: number
  /** Whether the action succeeded. */
  success: boolean
  /** Error message if the action failed. */
  error?: string
  /** Error stack trace. */
  errorStack?: string
  /** Element bounds at the time of the action. */
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Tap/swipe coordinates for overlay rendering. */
  point?: { x: number; y: number }
  /** End point for swipe/drag actions. */
  endPoint?: { x: number; y: number }
  /** Whether a "before" screenshot was captured. */
  hasScreenshotBefore: boolean
  /** Whether an "after" screenshot was captured. */
  hasScreenshotAfter: boolean
  /** Whether a "before" hierarchy snapshot was captured. */
  hasHierarchyBefore: boolean
  /** Whether an "after" hierarchy snapshot was captured. */
  hasHierarchyAfter: boolean
  /** Source location where the action was called. */
  sourceLocation?: SourceLocation
  /** Wait time before the element was found (ms). */
  waitTime?: number
  /** Number of retries before success. */
  retryCount?: number
  /** Internal action log entries. */
  log?: string[]
}

export interface AssertionTraceEvent extends TraceEvent {
  type: 'assertion'
  /** Assertion method name (e.g. "toBeVisible", "toHaveText"). */
  assertion: string
  /** Serialized selector. */
  selector?: string
  /** Expected value. */
  expected?: string
  /** Actual value. */
  actual?: string
  /** Whether the assertion passed. */
  passed: boolean
  /** Whether this was a soft assertion. */
  soft: boolean
  /** Whether this was a negated assertion. */
  negated: boolean
  /** Duration of the assertion polling. */
  duration: number
  /** Number of poll attempts. */
  attempts: number
  /** Error message if the assertion failed. */
  error?: string
  /** Element bounds at the time of the assertion (for screenshot overlay). */
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Source location. */
  sourceLocation?: SourceLocation
  /** Whether a "before" screenshot was captured. */
  hasScreenshotBefore?: boolean
  /** Whether an "after" screenshot was captured. */
  hasScreenshotAfter?: boolean
  /** Whether a "before" hierarchy snapshot was captured. */
  hasHierarchyBefore?: boolean
  /** Whether an "after" hierarchy snapshot was captured. */
  hasHierarchyAfter?: boolean
}

export interface GroupTraceEvent extends TraceEvent {
  type: 'group-start' | 'group-end'
  /** Group name. */
  name: string
}

export interface ConsoleTraceEvent extends TraceEvent {
  type: 'console'
  /** Console level. */
  level: ConsoleLevel
  /** Console message. */
  message: string
  /** Source: 'test' for test code, 'device' for logcat. */
  source: 'test' | 'device'
}

export interface AttachmentTraceEvent extends TraceEvent {
  type: 'attachment'
  /** Attachment name. */
  name: string
  /** MIME type. */
  contentType: string
  /** Path within the archive (relative to archive root). */
  path: string
  /** Original file size in bytes. */
  size: number
}

export interface ErrorTraceEvent extends TraceEvent {
  type: 'error'
  /** Error message. */
  message: string
  /** Error stack trace. */
  stack?: string
}

// ─── Source Location ───

export interface SourceLocation {
  file: string
  line: number
  column?: number
}

// ─── Trace Metadata ───

export interface TraceMetadata {
  /** Format version for forward compatibility. */
  version: 1
  /** Pilot SDK version. */
  pilotVersion: string
  /** Test file path. */
  testFile: string
  /** Fully qualified test name. */
  testName: string
  /** Test status. */
  testStatus: 'passed' | 'failed' | 'skipped' | 'running' | 'idle'
  /** Test duration in ms. */
  testDuration: number
  /** Test start timestamp (ms since epoch). */
  startTime: number
  /** Test end timestamp (ms since epoch). */
  endTime: number
  /** Device info. */
  device: TraceDeviceInfo
  /** Trace configuration used. */
  traceConfig: TraceConfigSnapshot
  /** Total number of actions recorded. */
  actionCount: number
  /** Total number of screenshots. */
  screenshotCount: number
  /** Error message if the test failed. */
  error?: string
  /** Project name this test belongs to (when projects are configured). */
  project?: string
  /** Path to the app state archive restored before this test. */
  appState?: string
}

export interface TraceDeviceInfo {
  serial: string
  model?: string
  osVersion?: string
  screenResolution?: { width: number; height: number }
  isEmulator: boolean
  packageName?: string
  /** Device pixel ratio (e.g. 3 for retina iOS). Bounds are in logical points; screenshots in pixels. */
  devicePixelRatio?: number
}

export interface TraceConfigSnapshot {
  screenshots: boolean
  snapshots: boolean
  sources: boolean
  network: boolean
}

// ─── Trace Configuration ───

export type TraceMode =
  | 'off'
  | 'on'
  | 'on-first-retry'
  | 'on-all-retries'
  | 'retain-on-failure'
  | 'retain-on-first-failure'

export interface TraceConfig {
  /** Trace recording mode. */
  mode: TraceMode
  /** Whether to capture screenshots before/after each action. */
  screenshots: boolean
  /** Whether to capture view hierarchy snapshots. */
  snapshots: boolean
  /** Whether to include test source files. */
  sources: boolean
  /** Whether to include user-added attachments. */
  attachments: boolean
  /** Whether to capture network traffic via HTTP proxy. */
  network: boolean
  /**
   * Glob-style host patterns to retain in captured network entries.
   * Defaults to `undefined` — keep every captured entry.
   *
   * Matters most for physical iOS devices, where Pilot's Wi-Fi MITM
   * proxy is system-wide and sees every app's traffic, including iOS
   * background services (captive portal checks, analytics, iCloud).
   * Set an allowlist of hostnames that match the app(s) under test so
   * the trace only keeps relevant entries:
   *
   *     trace: {
   *       mode: 'on',
   *       networkHosts: ['*.myapp.com', 'api.example.com'],
   *     }
   *
   * Simulators already filter per-PID (via the macOS Network Extension
   * redirector), so leaving this unset is fine for sim-only runs. On
   * physical iOS, unset = verbose traces with system noise.
   *
   * Patterns use glob semantics: `*` matches one hostname segment,
   * `**` (or a leading `*.`) matches any number. Matching is
   * case-insensitive. See `filterEntriesByHosts` for the exact rules.
   */
  networkHosts?: string[]
}

/** Parse a string shorthand or object into a full TraceConfig. */
export function resolveTraceConfig(
  input: TraceMode | Partial<TraceConfig> | undefined,
): TraceConfig {
  const defaults: TraceConfig = {
    mode: 'off',
    screenshots: true,
    snapshots: true,
    sources: true,
    attachments: true,
    network: true,
  };

  if (input === undefined) return defaults;

  if (typeof input === 'string') {
    return { ...defaults, mode: input };
  }

  return { ...defaults, ...input };
}

// ─── Network Types (Phase 6) ───

export interface NetworkEntry {
  /** Request index. */
  index: number
  /** Action index this request is associated with. */
  actionIndex: number
  /** Timestamp of request start. */
  startTime: number
  /** Timestamp of response end. */
  endTime: number
  /** HTTP method. */
  method: string
  /** Full URL. */
  url: string
  /** HTTP status code. */
  status: number
  /** Response content type. */
  contentType: string
  /** Request size in bytes. */
  requestSize: number
  /** Response size in bytes. */
  responseSize: number
  /** Duration in ms. */
  duration: number
  /** Path to request body file in archive (if large). */
  requestBodyPath?: string
  /** Path to response body file in archive (if large). */
  responseBodyPath?: string
  /** Request headers. */
  requestHeaders: Record<string, string>
  /** Response headers. */
  responseHeaders: Record<string, string>
  /** Request body bytes (transient — not serialized to archive JSON). */
  requestBody?: Buffer
  /** Response body bytes (transient — not serialized to archive JSON). */
  responseBody?: Buffer
}

// ─── Union type for all events ───

export type AnyTraceEvent =
  | ActionTraceEvent
  | AssertionTraceEvent
  | GroupTraceEvent
  | ConsoleTraceEvent
  | AttachmentTraceEvent
  | ErrorTraceEvent
