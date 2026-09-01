/**
 * Watch mode child process.
 *
 * Spawned by the watch coordinator for each test re-run. Connects to an
 * already-running daemon, resets the app, runs a single test file, and
 * streams results back to the parent via IPC. Exits after completion so
 * the next run gets a fresh ESM module cache.
 *
 * @see PILOT-120
 */

import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults } from './runner.js';
import type { TapsmithConfig } from './config.js';
import { probeResetCapabilities, type SessionPreflightContext } from './session-preflight.js';
import type { ResetCapabilities } from './app-reset.js';
import { installActionProgressPrinter } from './action-progress-renderer.js';
import { isNetworkTracingEnabled, networkHostsForPac, networkPassthroughHosts } from './trace/types.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  deserializeRegExpArray,
  configFromSerialized,
  type SerializedConfig,
  type RunFileUseOptions,
} from './worker-protocol.js';

// ─── IPC protocol ───

/**
 * Ask the in-flight run to stop and report what it has.
 *
 * The parent used to SIGTERM this child instead. That destroyed the run's own
 * account of itself: the `file-done` message never arrived, so every test that
 * had already finished was missing from the parent's summary even though it had
 * streamed a `test-end` for each one. A cooperative abort lets the run end
 * itself and report, exactly as watch mode's UI-worker counterpart does.
 */
export interface WatchRunAbortMessage {
  type: 'abort'
}

export type WatchRunIncomingMessage = WatchRunMessage | WatchRunAbortMessage;

export interface WatchRunMessage {
  type: 'run'
  daemonAddress: string
  deviceSerial: string
  filePath: string
  config: SerializedConfig
  screenshotDir?: string
  projectUseOptions?: RunFileUseOptions
  projectName?: string
  /** Run only tests whose fullName matches this (case-insensitive substring). */
  testFilter?: string
  /**
   * What to call this run in preflight errors, e.g. "Watch" or "Run".
   *
   * The MCP dispatcher runs its files through this same child, so the default
   * put "Watch (<serial>): … during watch reset" in front of failures from a
   * plain `tapsmith_run_tests` — naming a mode the caller was not using.
   */
  label?: string
  /**
   * The parent's sticky reset-capability knowledge for this device (in-app
   * hooks detected, …). This child is forked fresh per run, so without it
   * every run would start undetected and `appReset: 'auto'` would resolve to
   * clear · file even when the app supports warm resets. The child reports
   * what it learned back on `file-done`.
   */
  resetCapabilities?: ResetCapabilities
}

export interface WatchRunTestEndMessage {
  type: 'test-end'
  result: import('./worker-protocol.js').SerializedTestResult
}

export interface WatchRunFileDoneMessage {
  type: 'file-done'
  filePath: string
  results: import('./worker-protocol.js').SerializedTestResult[]
  suite: import('./worker-protocol.js').SerializedSuiteResult
  /** What this run learned about the device's reset capabilities — the parent
   * folds it into its sticky per-device store (detection only ever upgrades). */
  resetCapabilities?: ResetCapabilities
}

export interface WatchRunErrorMessage {
  type: 'error'
  error: { message: string; stack?: string }
}

export type WatchRunChildMessage =
  | WatchRunTestEndMessage
  | WatchRunFileDoneMessage
  | WatchRunErrorMessage

// ─── Config reconstruction ───

// ─── Helpers ───

let ipcOpen = true;

function send(msg: WatchRunChildMessage): void {
  if (!ipcOpen || !process.send) return;
  try {
    process.send(msg);
  } catch {
    // IPC channel may be closed if the parent was killed (e.g. Ctrl+C).
    // Swallow the error — the child is about to exit anyway.
    ipcOpen = false;
  }
}

function buildSessionContext(
  config: TapsmithConfig,
  device: Device,
  client: TapsmithGrpcClient,
  deviceSerial: string,
  label = 'Watch',
): SessionPreflightContext {
  return {
    label: `${label} (${deviceSerial})`,
    config,
    device,
    client,
    deviceSerial,
    networkTracingEnabled: isNetworkTracingEnabled(config.trace),
  };
}

// ─── Main handler ───

/**
 * Aborts the in-flight run when the parent asks. Set for the duration of a
 * run and cleared after, so a stop arriving while the child sits idle between
 * runs cannot abort the next one.
 */
let currentAbortController: AbortController | undefined;

/** Report a run that produced nothing, so the parent still hears an ending. */
function sendEmptyFileDone(filePath: string): void {
  const emptySuite: import('./runner.js').SuiteResult = { name: '', tests: [], suites: [], durationMs: 0 };
  send({
    type: 'file-done',
    filePath,
    results: [],
    suite: serializeSuiteResult(emptySuite, 0),
  });
}

async function handleRun(msg: WatchRunMessage): Promise<void> {
  const config = configFromSerialized(msg.config, msg.daemonAddress);
  config.device = msg.deviceSerial;

  const client = new TapsmithGrpcClient(msg.daemonAddress);
  const ready = await client.waitForReady(5_000);
  if (!ready) {
    throw new Error(`Failed to connect to daemon at ${msg.daemonAddress}`);
  }

  const device = new Device(client, config);
  await device.setDevice(
    msg.deviceSerial,
    isNetworkTracingEnabled(config.trace),
    networkHostsForPac(config.trace),
    networkPassthroughHosts(config.trace),
  );

  // Ensure the device is awake — the screen may have auto-locked while
  // watch mode was idle waiting for file changes.
  await device.wake();
  await device.unlock();

  const label = msg.label ?? 'Watch';
  const ctx = buildSessionContext(config, device, client, msg.deviceSerial, label);
  // Seed with the parent's sticky knowledge, then probe once if hooks were
  // never seen — one hierarchy read, and detection only ever upgrades, so a
  // hooked app pays it exactly once per watch/MCP session (the parent stores
  // the result). Without this every fresh child resolved `auto` to
  // clear · file and warm resets silently never engaged.
  ctx.capabilities = { ...(msg.resetCapabilities ?? {}) };
  if (!ctx.capabilities.hooksDetected) {
    await probeResetCapabilities(ctx);
  }

  // Created BEFORE preflight so a stop that lands during wake/unlock/app-reset
  // is honoured rather than being a no-op that runs the whole file anyway.
  const abortController = new AbortController();
  currentAbortController = abortController;
  client._setAbortSignal(abortController.signal);

  // Live progress lines for slow device actions (preflight reset, app-state
  // save/restore, …) — the child's stdout reaches the terminal directly (PILOT-232).
  const disposeActionProgressPrinter = installActionProgressPrinter();

  try {
    // The app reset is the runner's job (declared policy, traced as fixture
    // setup, ending with its own readiness check). A stop that lands during
    // it leaves the file's tests untouched and reports an empty ending.
    if (abortController.signal.aborted) {
      sendEmptyFileDone(msg.filePath);
      return;
    }

    const screenshotDir = msg.screenshotDir;

    // Reporter proxy: stream test results to parent
    const reporterProxy = {
      onTestEnd(result: import('./runner.js').TestResult): void {
        send({
          type: 'test-end',
          result: serializeTestResult(result, 0),
        });
      },
    };

    const suiteResult = await runTestFile(msg.filePath, {
      config,
      device,
      screenshotDir,
      reporter: reporterProxy,
      sessionContext: ctx,
      resetCapabilities: ctx.capabilities,
      projectUseOptions: msg.projectUseOptions,
      projectName: msg.projectName,
      testFilter: msg.testFilter,
      grep: deserializeRegExpArray(msg.config.grep),
      grepInvert: deserializeRegExpArray(msg.config.grepInvert),
      abortSignal: abortController.signal,
    });

    const results = collectResults(suiteResult);

    send({
      type: 'file-done',
      filePath: msg.filePath,
      results: results.map((r) => serializeTestResult(r, 0)),
      suite: serializeSuiteResult(suiteResult, 0),
      resetCapabilities: ctx.capabilities,
    });
  } finally {
    disposeActionProgressPrinter();
    client._setAbortSignal(undefined);
    if (currentAbortController === abortController) currentAbortController = undefined;
  }

  client.close();
}

// ─── IPC message handler ───

process.on('message', async (msg: WatchRunIncomingMessage) => {
  try {
    if (msg.type === 'abort') {
      // No run in flight: nothing to abort, and aborting the *next* one would
      // be wrong. The parent escalates to a signal if this goes unanswered.
      currentAbortController?.abort();
      return;
    }
    if (msg.type === 'run') {
      await handleRun(msg);
      process.exit(0);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    send({
      type: 'error',
      error: { message: error.message, stack: error.stack },
    });
    process.exit(1);
  }
});
