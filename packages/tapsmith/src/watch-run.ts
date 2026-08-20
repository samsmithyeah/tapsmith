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

import * as path from 'node:path';
import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults } from './runner.js';
import type { TapsmithConfig } from './config.js';
import { ensureSessionReady, launchConfiguredApp, type SessionPreflightContext } from './session-preflight.js';
import { installActionProgressPrinter } from './action-progress-renderer.js';
import { isNetworkTracingEnabled, networkHostsForPac, networkPassthroughHosts } from './trace/types.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  deserializeRegExpArray,
  type SerializedConfig,
  type RunFileUseOptions,
} from './worker-protocol.js';

// ─── IPC protocol ───

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

function configFromSerialized(s: SerializedConfig, daemonAddress: string): TapsmithConfig {
  return {
    timeout: s.timeout,
    retries: s.retries,
    screenshot: s.screenshot,
    testMatch: [],
    daemonAddress,
    rootDir: s.rootDir,
    outputDir: s.outputDir,
    apk: s.apk,
    activity: s.activity,
    package: s.package,
    agentApk: s.agentApk,
    agentTestApk: s.agentTestApk,
    workers: 1,
    launchEmulators: false,
    trace: s.trace as TapsmithConfig['trace'],
    video: s.video as TapsmithConfig['video'],
    platform: s.platform,
    app: s.app,
    iosXctestrun: s.iosXctestrun,
    simulator: s.simulator,
    resetAppDeepLink: s.resetAppDeepLink,
    resetAppWaitMs: s.resetAppWaitMs,
    baseURL: s.baseURL,
    extraHTTPHeaders: s.extraHTTPHeaders,
    grep: deserializeRegExpArray(s.grep),
    grepInvert: deserializeRegExpArray(s.grepInvert),
  };
}

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
  const phase = label.toLowerCase();

  // Live progress lines for slow device actions (preflight reset, app-state
  // save/restore, …) — the child's stdout reaches the terminal directly (PILOT-232).
  const disposeActionProgressPrinter = installActionProgressPrinter();

  try {
    // Reset app for clean state
    if (config.package) {
      await launchConfiguredApp(ctx, `${phase} reset for ${path.basename(msg.filePath)}`);
    } else {
      await ensureSessionReady(ctx, `${phase} preflight for ${path.basename(msg.filePath)}`);
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
      projectUseOptions: msg.projectUseOptions,
      projectName: msg.projectName,
      testFilter: msg.testFilter,
      grep: deserializeRegExpArray(msg.config.grep),
      grepInvert: deserializeRegExpArray(msg.config.grepInvert),
    });

    const results = collectResults(suiteResult);

    send({
      type: 'file-done',
      filePath: msg.filePath,
      results: results.map((r) => serializeTestResult(r, 0)),
      suite: serializeSuiteResult(suiteResult, 0),
    });
  } finally {
    disposeActionProgressPrinter();
  }

  client.close();
}

// ─── IPC message handler ───

process.on('message', async (msg: WatchRunMessage) => {
  try {
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
