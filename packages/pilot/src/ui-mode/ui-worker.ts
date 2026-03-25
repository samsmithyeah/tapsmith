/**
 * Persistent UI worker child process.
 *
 * Combines the persistent lifecycle of worker-runner.ts (init once, run
 * many files) with the real-time trace streaming of ui-run.ts. Forked
 * by the UI server when workers > 1.
 *
 * @see PILOT-87
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { PilotGrpcClient } from '../grpc-client.js';
import { Device } from '../device.js';
import { runTestFile, collectResults } from '../runner.js';
import type { PilotConfig } from '../config.js';
import { isPackageInstalled, waitForPackageIndexed } from '../emulator.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  isRecoverableInfrastructureError,
  type SerializedConfig,
} from '../worker-protocol.js';
import { ensureSessionReady, launchConfiguredApp, type SessionPreflightContext } from '../session-preflight.js';
import type { AnyTraceEvent } from '../trace/types.js';
import type {
  UIWorkerMessage,
  UIWorkerChildMessage,
  UIWorkerInitMessage,
  UIWorkerTraceEventMessage,
} from './ui-protocol.js';

// ─── State ───

let workerId = -1;
let device: Device | undefined;
let client: PilotGrpcClient | undefined;
let config: PilotConfig | undefined;
let assignedSerial: string | undefined;
let screenshotDir: string | undefined;
let ipcOpen = true;
let currentAbortController: AbortController | undefined;

// ─── Helpers ───

function send(msg: UIWorkerChildMessage): void {
  if (!ipcOpen || !process.send) return;
  try {
    process.send(msg);
  } catch {
    ipcOpen = false;
  }
}

function sendProgress(message: string): void {
  send({ type: 'progress', workerId, message });
}

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
  };
}

function sessionContext(
  deviceSerial?: string,
  agentApkPath?: string,
  agentTestApkPath?: string,
): SessionPreflightContext {
  if (!device || !client || !config) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }
  const serial = deviceSerial ?? assignedSerial;
  const label = serial
    ? `UI Worker ${workerId} (${serial})`
    : `UI Worker ${workerId}`;
  return { label, config, device, client, agentApkPath, agentTestApkPath, deviceSerial: serial };
}

// ─── Trace event streaming ───

function setupTraceStreaming(dev: Device): void {
  const collector = dev.tracing._currentCollector;
  if (!collector) return;

  collector.setEventCallback((event: AnyTraceEvent, screenshots) => {
    const msg: UIWorkerTraceEventMessage = {
      type: 'trace-event',
      workerId,
      event,
      screenshotBefore: screenshots?.before?.toString('base64'),
      screenshotAfter: screenshots?.after?.toString('base64'),
      hierarchyBefore: screenshots?.hierarchyBefore,
      hierarchyAfter: screenshots?.hierarchyAfter,
    };
    send(msg);
  });
}

// ─── Init handler ───

async function handleInit(msg: UIWorkerInitMessage): Promise<void> {
  workerId = msg.workerId;
  screenshotDir = msg.screenshotDir;
  const daemonAddress = `localhost:${msg.daemonPort}`;
  sendProgress(`connecting to daemon on ${daemonAddress}`);

  config = configFromSerialized(msg.config, daemonAddress);

  // Force trace on for UI mode
  if (!config.trace || config.trace === 'off') {
    config.trace = 'on';
  }

  client = new PilotGrpcClient(daemonAddress);
  const ready = await client.waitForReady(10_000);
  if (!ready) {
    throw new Error(`UI Worker ${workerId}: Failed to connect to daemon at ${daemonAddress}`);
  }

  device = new Device(client, config);
  assignedSerial = msg.deviceSerial;
  config.device = msg.deviceSerial;

  if (msg.deviceSerial) {
    sendProgress(`selecting device ${msg.deviceSerial}`);
    await device.setDevice(msg.deviceSerial);
  }

  // Wake and unlock
  try {
    sendProgress('waking and unlocking device');
    await device.wake();
    await device.unlock();
  } catch {
    // Non-fatal
  }

  // Install app if needed
  if (config.apk) {
    const alreadyInstalled = config.package
      && msg.deviceSerial
      && isPackageInstalled(msg.deviceSerial, config.package);

    if (alreadyInstalled) {
      sendProgress(`app ${config.package} already installed, skipping APK install`);
    } else {
      const resolvedApk = path.resolve(config.rootDir, config.apk);
      sendProgress(`installing app APK ${path.basename(resolvedApk)}`);
      await device.installApk(resolvedApk);
      if (config.package && msg.deviceSerial) {
        await waitForPackageIndexed(msg.deviceSerial, config.package);
      }
    }
  }

  // Start agent
  const resolvedAgentApk = config.agentApk
    ? path.resolve(config.rootDir, config.agentApk)
    : undefined;
  const resolvedAgentTestApk = config.agentTestApk
    ? path.resolve(config.rootDir, config.agentTestApk)
    : undefined;
  sendProgress('starting Pilot agent');
  await device.startAgent('', resolvedAgentApk, resolvedAgentTestApk);

  try {
    if (config.package) {
      sendProgress(`launching ${config.package}`);
      await launchConfiguredApp(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk),
        'UI worker initialization',
      );
    } else {
      sendProgress('validating session readiness');
      await ensureSessionReady(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk),
        'UI worker initialization',
      );
    }
  } catch (err) {
    throw new Error(
      `UI Worker ${workerId} (${msg.deviceSerial}): ${err instanceof Error ? err.message : err}`,
    );
  }

  // Warm up fresh emulators
  if (msg.freshEmulator && config.package) {
    sendProgress('warming up fresh emulator');
    await device.waitForIdle();
    await device.terminateApp(config.package);
    await launchConfiguredApp(
      sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk),
      'warmup',
    );
    await device.waitForIdle();
  }

  sendProgress('ready');
  send({ type: 'ready', workerId });
}

// ─── Run file handler ───

async function handleRunFile(
  filePath: string,
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions,
  projectName?: string,
  testFilter?: string,
): Promise<void> {
  if (!config || !device) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }

  // Reset app between files
  if (config.package) {
    await launchConfiguredApp(sessionContext(undefined), `file reset for ${path.basename(filePath)}`);
  }

  // Send test source file
  try {
    const sourceContent = fs.readFileSync(filePath, 'utf-8');
    send({ type: 'source', workerId, fileName: path.basename(filePath), content: sourceContent });
  } catch {
    // best-effort
  }

  const reporterProxy = {
    onTestEnd(result: import('../runner.js').TestResult): void {
      send({
        type: 'test-end',
        workerId,
        result: serializeTestResult(result, workerId),
      });
    },
  };

  // Hook into trace streaming
  const dev = device;
  const origStartManaged = dev.tracing._startManaged.bind(dev.tracing);
  dev.tracing._startManaged = (...args: Parameters<typeof dev.tracing._startManaged>) => {
    const collector = origStartManaged(...args);
    setupTraceStreaming(dev);
    return collector;
  };

  currentAbortController = new AbortController();

  const suiteResult = await runFileWithRecovery(
    filePath, reporterProxy, projectUseOptions, projectName, testFilter,
    currentAbortController.signal,
  );

  const results = collectResults(suiteResult);

  currentAbortController = undefined;

  send({
    type: 'file-done',
    workerId,
    filePath,
    results: results.map((r) => serializeTestResult(r, workerId)),
    suite: serializeSuiteResult(suiteResult, workerId),
  });
}

async function runFileWithRecovery(
  filePath: string,
  reporterProxy: { onTestEnd(result: import('../runner.js').TestResult): void },
  projectUseOptions?: import('../worker-protocol.js').RunFileUseOptions,
  projectName?: string,
  testFilter?: string,
  abortSignal?: AbortSignal,
): Promise<import('../runner.js').SuiteResult> {
  if (!config || !device) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const suite = await runTestFile(filePath, {
        config,
        device,
        screenshotDir,
        reporter: reporterProxy,
        bustImportCache: true,
        abortSignal,
        beforeEachTest: async (fullName: string) => {
          send({ type: 'test-start', workerId, fullName, filePath });
          await ensureSessionReady(sessionContext(undefined), `before test ${fullName}`);
        },
        abortFileOnError: isRecoverableInfrastructureError,
        projectUseOptions,
        projectName,
        testFilter,
        onNetworkEntries: (entries) => {
          const safe = entries.map((e) => ({
            ...e,
            requestBody: undefined,
            responseBody: undefined,
          }));
          send({ type: 'network', workerId, entries: safe });
        },
      });

      const infrastructureFailure = findRecoverableInfrastructureFailure(collectResults(suite));
      if (!infrastructureFailure) return suite;
      if (attempt === 2) throw infrastructureFailure;
      await recoverFileSession(filePath, infrastructureFailure);
      continue;
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) throw err;
      await recoverFileSession(filePath, err);
    }
  }

  throw new Error(`UI Worker ${workerId}: exhausted recovery attempts for ${path.basename(filePath)}`);
}

function findRecoverableInfrastructureFailure(
  results: Array<import('../runner.js').TestResult>,
): Error | undefined {
  for (const result of results) {
    if (result.status !== 'failed' || !result.error) continue;
    if (!isRecoverableInfrastructureError(result.error)) continue;
    return new Error(`${result.fullName}: ${result.error.message}`);
  }
  return undefined;
}

async function recoverFileSession(filePath: string, err: unknown): Promise<void> {
  process.stderr.write(
    `UI Worker ${workerId}: Recovering session after infrastructure error in ${path.basename(filePath)}: ${err instanceof Error ? err.message : err}\n`,
  );
  if (config?.package) {
    await launchConfiguredApp(sessionContext(undefined), `recovery for ${path.basename(filePath)}`);
  } else {
    await ensureSessionReady(sessionContext(undefined), `recovery for ${path.basename(filePath)}`);
  }
}

// ─── Shutdown ───

function handleShutdown(): void {
  if (device) device.close();
  if (client) client.close();
  process.exit(0);
}

// ─── IPC message handler ───

process.on('message', async (msg: UIWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'run-file':
        await handleRunFile(msg.filePath, msg.projectUseOptions, msg.projectName, msg.testFilter);
        break;
      case 'abort':
        currentAbortController?.abort();
        break;
      case 'shutdown':
        handleShutdown();
        break;
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`UI Worker ${workerId} error: ${error.message}\n`);
    send({
      type: 'error',
      workerId,
      error: { message: error.message, stack: error.stack },
    });
  }
});
