/**
 * Worker child process entry point for parallel test execution.
 *
 * Each worker is forked by the dispatcher and assigned a dedicated device.
 * It receives test files to run via IPC, executes them sequentially, and
 * sends results back to the main process.
 *
 * @see PILOT-106
 */

import * as path from 'node:path';
import { PilotGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import { runTestFile, collectResults } from './runner.js';
import type { PilotConfig } from './config.js';
import { isPackageInstalled, waitForPackageIndexed } from './emulator.js';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  InitMessage,
  SerializedConfig,
} from './worker-protocol.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  isRecoverableInfrastructureError,
} from './worker-protocol.js';
import { ensureSessionReady, launchConfiguredApp, type SessionPreflightContext } from './session-preflight.js';

let workerId = -1;
let device: Device | undefined;
let client: PilotGrpcClient | undefined;
let config: PilotConfig | undefined;
let assignedSerial: string | undefined;

function send(msg: WorkerToMainMessage): void {
  if (process.send) {
    process.send(msg);
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

async function handleInit(msg: InitMessage): Promise<void> {
  workerId = msg.workerId;
  const daemonAddress = `localhost:${msg.daemonPort}`;
  sendProgress(`connecting to daemon on ${daemonAddress}`);

  config = configFromSerialized(msg.config, daemonAddress);

  // Connect to our dedicated daemon
  client = new PilotGrpcClient(daemonAddress);
  const ready = await client.waitForReady(10_000);
  if (!ready) {
    throw new Error(`Worker ${workerId}: Failed to connect to daemon at ${daemonAddress}`);
  }

  device = new Device(client, config);

  // Set the assigned device
  assignedSerial = msg.deviceSerial;
  config.device = msg.deviceSerial;
  if (msg.deviceSerial) {
    sendProgress(`selecting device ${msg.deviceSerial}`);
    await device.setDevice(msg.deviceSerial);
  }

  // Wake and unlock device screen
  try {
    sendProgress('waking and unlocking device');
    await device.wake();
    await device.unlock();
  } catch {
    // Non-fatal
  }

  // Install app under test if APK path is configured and not already installed
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
      // Wait for package manager to index the new app
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
        'worker initialization',
      );
    } else {
      sendProgress('validating session readiness');
      await ensureSessionReady(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk),
        'worker initialization',
      );
    }
  } catch (err) {
    throw new Error(
      `Worker ${workerId} (${msg.deviceSerial}): ${err instanceof Error ? err.message : err}`,
    );
  }

  // Warm up freshly launched emulators by cycling the app once. The first
  // launch on a cold emulator triggers JIT compilation and DEX optimization
  // that makes the first few tests unreasonably slow or timeout.
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

async function handleRunFile(filePath: string, projectUseOptions?: import('./worker-protocol.js').RunFileUseOptions, projectName?: string): Promise<void> {
  if (!config || !device) {
    throw new Error(`Worker ${workerId}: Not initialized`);
  }

  send({ type: 'file-start', workerId, filePath });

  // Reset app between files for isolation
  if (config.package) {
    await launchConfiguredApp(sessionContext(undefined), `file reset for ${path.basename(filePath)}`);
  }

  const screenshotDir =
    config.screenshot !== 'never'
      ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
      : undefined;

  // Create a reporter proxy that sends events back to main process
  const reporterProxy = {
    onTestEnd(result: import('./runner.js').TestResult): void {
      send({
        type: 'test-end',
        workerId,
        result: serializeTestResult(result, workerId),
      });
    },
  };

  const suiteResult = await runFileWithRecovery(filePath, screenshotDir, reporterProxy, projectUseOptions, projectName);

  const results = collectResults(suiteResult);

  send({
    type: 'file-done',
    workerId,
    filePath,
    suite: serializeSuiteResult(suiteResult, workerId),
    results: results.map((r) => serializeTestResult(r, workerId)),
  });
}

async function runFileWithRecovery(
  filePath: string,
  screenshotDir: string | undefined,
  reporterProxy: { onTestEnd(result: import('./runner.js').TestResult): void },
  projectUseOptions?: import('./worker-protocol.js').RunFileUseOptions,
  projectName?: string,
): Promise<import('./runner.js').SuiteResult> {
  if (!config || !device) {
    throw new Error(`Worker ${workerId}: Not initialized`);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const suite = await runTestFile(filePath, {
        config,
        device,
        screenshotDir,
        reporter: reporterProxy,
        beforeEachTest: async (fullName) => {
          await ensureSessionReady(
            sessionContext(undefined),
            `before test ${fullName}`,
          );
        },
        abortFileOnError: isRecoverableInfrastructureError,
        projectUseOptions,
        projectName,
      });
      const infrastructureFailure = findRecoverableInfrastructureFailure(collectResults(suite));
      if (!infrastructureFailure) {
        return suite;
      }
      if (attempt === 2) {
        throw infrastructureFailure;
      }
      await recoverFileSession(filePath, infrastructureFailure);
      continue;
    } catch (err) {
      if (!isRecoverableInfrastructureError(err) || attempt === 2) {
        throw err;
      }

      await recoverFileSession(filePath, err);
    }
  }

  throw new Error(`Worker ${workerId}: exhausted recovery attempts for ${path.basename(filePath)}`);
}

function handleShutdown(): void {
  if (device) {
    device.close();
  }
  process.exit(0);
}

function sessionContext(
  deviceSerial?: string,
  agentApkPath?: string,
  agentTestApkPath?: string,
): SessionPreflightContext {
  if (!device || !client || !config) {
    throw new Error(`Worker ${workerId}: Not initialized`);
  }

  const serial = deviceSerial ?? assignedSerial;
  const label = serial
    ? `Worker ${workerId} (${serial})`
    : `Worker ${workerId}`;

  return {
    label,
    config,
    device,
    client,
    agentApkPath,
    agentTestApkPath,
    deviceSerial: serial,
  };
}

function findRecoverableInfrastructureFailure(
  results: Array<import('./runner.js').TestResult>,
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
    `Worker ${workerId}: Recovering session after infrastructure error in ${path.basename(filePath)}: ${err instanceof Error ? err.message : err}\n`,
  );

  if (config?.package) {
    await launchConfiguredApp(sessionContext(undefined), `recovery for ${path.basename(filePath)}`);
  } else {
    await ensureSessionReady(sessionContext(undefined), `recovery for ${path.basename(filePath)}`);
  }
}

// ─── IPC message handler ───

process.on('message', async (msg: MainToWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'run-file':
        await handleRunFile(msg.filePath, msg.projectUseOptions, msg.projectName);
        break;
      case 'shutdown':
        handleShutdown();
        break;
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`Worker ${workerId} error: ${error.message}\n`);
    send({
      type: 'error',
      workerId,
      error: { message: error.message, stack: error.stack },
    });
  }
});
