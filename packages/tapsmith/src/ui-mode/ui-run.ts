/**
 * UI mode test execution child process.
 *
 * Adapted from watch-run.ts. Connects to an already-running daemon,
 * runs a single test file, and streams results + trace events back
 * to the parent (UI server) via IPC. Exits after completion so the
 * next run gets a fresh ESM module cache.
 *
 * @see PILOT-87
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { Device } from '../device.js';
import { runTestFile, collectResults } from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { ensureSessionReady, launchConfiguredApp, type SessionPreflightContext } from '../session-preflight.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  type SerializedConfig,
} from '../worker-protocol.js';
import type {
  UIRunMessage,
  UIRunChildMessage,
  UIRunTraceEventMessage,
} from './ui-protocol.js';
import type { AnyTraceEvent } from '../trace/types.js';
import { isNetworkTracingEnabled, networkHostsForPac } from '../trace/types.js';
import { encodeNetworkBodies } from './encode-bodies.js';

// ─── Helpers ───

let ipcOpen = true;

function send(msg: UIRunChildMessage): Promise<void> {
  if (!ipcOpen || !process.send) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      process.send!(msg, () => resolve());
    } catch {
      ipcOpen = false;
      resolve();
    }
  });
}

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
  };
}

function buildSessionContext(
  config: TapsmithConfig,
  device: Device,
  client: TapsmithGrpcClient,
  deviceSerial: string,
): SessionPreflightContext {
  return {
    label: `UI mode (${deviceSerial})`,
    config,
    device,
    client,
    deviceSerial,
    networkTracingEnabled: isNetworkTracingEnabled(config.trace),
  };
}

// ─── Trace event streaming ───

/**
 * Set up a trace event listener that forwards events to the parent
 * via IPC. Called after the trace collector is created in the runner.
 */
function setupTraceStreaming(device: Device): void {
  const collector = device.tracing._currentCollector;
  if (!collector) return;

  collector.setEventCallback((event: AnyTraceEvent, screenshots, lifecycle) => {
    const msg: UIRunTraceEventMessage = {
      type: 'trace-event',
      event,
      lifecycle,
      screenshotBefore: screenshots?.before?.toString('base64'),
      screenshotAfter: screenshots?.after?.toString('base64'),
      hierarchyBefore: screenshots?.hierarchyBefore,
      hierarchyAfter: screenshots?.hierarchyAfter,
    };
    send(msg);
  });
}

// ─── Main handler ───

async function handleRun(msg: UIRunMessage): Promise<void> {
  const config = configFromSerialized(msg.config, msg.daemonAddress);
  config.device = msg.deviceSerial;

  // Force trace on for UI mode so we get real-time trace events
  if (!config.trace || config.trace === 'off') {
    config.trace = 'on';
  }

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
  );

  const ctx = buildSessionContext(config, device, client, msg.deviceSerial);

  // Reset app for clean state
  if (config.package) {
    await launchConfiguredApp(ctx, `UI run for ${path.basename(msg.filePath)}`);
  } else {
    await ensureSessionReady(ctx, `UI preflight for ${path.basename(msg.filePath)}`);
  }

  const screenshotDir = msg.screenshotDir;

  // Send test source file so the Source tab can display it
  try {
    const sourceContent = fs.readFileSync(msg.filePath, 'utf-8');
    send({ type: 'source', fileName: path.basename(msg.filePath), content: sourceContent });
  } catch {
    // best-effort
  }

  // Reporter proxy: stream test results to parent
  const reporterProxy = {
    onTestEnd(result: import('../runner.js').TestResult): void {
      send({
        type: 'test-end',
        result: serializeTestResult(result, 0),
      });
    },
  };

  // Hook into the device to stream trace events once the runner starts tracing
  const origStartManaged = device.tracing._startManaged.bind(device.tracing);
  device.tracing._startManaged = (...args: Parameters<typeof device.tracing._startManaged>) => {
    const collector = origStartManaged(...args);
    // Set up trace streaming after the collector is created
    setupTraceStreaming(device);
    return collector;
  };

  const suiteResult = await runTestFile(msg.filePath, {
    config,
    device,
    screenshotDir,
    reporter: reporterProxy,
    onTestStart: async (fullName: string) => {
      send({ type: 'test-start', fullName, filePath: msg.filePath });
    },
    projectUseOptions: msg.projectUseOptions,
    projectName: msg.projectName,
    testFilter: msg.testFilter,
    onNetworkEntries: (entries) => {
      const { entries: safe, bodies } = encodeNetworkBodies(entries);
      send({ type: 'network', entries: safe, bodies });
    },
  });

  const results = collectResults(suiteResult);

  await send({
    type: 'file-done',
    filePath: msg.filePath,
    results: results.map((r) => serializeTestResult(r, 0)),
    suite: serializeSuiteResult(suiteResult, 0),
  });

  client.close();
}

// ─── IPC message handler ───

process.on('message', async (msg: UIRunMessage) => {
  try {
    if (msg.type === 'run') {
      await handleRun(msg);
      // Disconnect IPC channel gracefully so all pending messages flush
      // before the process exits (process.exit() can lose buffered IPC).
      process.disconnect();
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
