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
import { PilotGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults } from './runner.js';
import type { PilotConfig } from './config.js';
import { ensureSessionReady, launchConfiguredApp, type SessionPreflightContext } from './session-preflight.js';
import {
  serializeTestResult,
  serializeSuiteResult,
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

function configFromSerialized(s: SerializedConfig, daemonAddress: string): PilotConfig {
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
    trace: s.trace as PilotConfig['trace'],
    platform: s.platform,
    app: s.app,
    iosXctestrun: s.iosXctestrun,
    simulator: s.simulator,
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
  config: PilotConfig,
  device: Device,
  client: PilotGrpcClient,
  deviceSerial: string,
): SessionPreflightContext {
  return {
    label: `Watch (${deviceSerial})`,
    config,
    device,
    client,
    deviceSerial,
  };
}

// ─── Main handler ───

async function handleRun(msg: WatchRunMessage): Promise<void> {
  const config = configFromSerialized(msg.config, msg.daemonAddress);
  config.device = msg.deviceSerial;

  const client = new PilotGrpcClient(msg.daemonAddress);
  const ready = await client.waitForReady(5_000);
  if (!ready) {
    throw new Error(`Failed to connect to daemon at ${msg.daemonAddress}`);
  }

  const device = new Device(client, config);
  await device.setDevice(msg.deviceSerial);

  const ctx = buildSessionContext(config, device, client, msg.deviceSerial);

  // Reset app for clean state
  if (config.package) {
    await launchConfiguredApp(ctx, `watch reset for ${path.basename(msg.filePath)}`);
  } else {
    await ensureSessionReady(ctx, `watch preflight for ${path.basename(msg.filePath)}`);
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
  });

  const results = collectResults(suiteResult);

  send({
    type: 'file-done',
    filePath: msg.filePath,
    results: results.map((r) => serializeTestResult(r, 0)),
    suite: serializeSuiteResult(suiteResult, 0),
  });

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
