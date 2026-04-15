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
import { isNetworkTracingEnabled, networkHostsForPac } from './trace/types.js';
import { runTestFile, collectResults } from './runner.js';
import type { PilotConfig } from './config.js';
import { isPackageInstalled, waitForPackageIndexed } from './emulator.js';
import { installApp, isAppInstalled, probeSimulatorHealth, rebootSimulator } from './ios-simulator.js';
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
let resolvedXctestrunPath: string | undefined;
let resolvedAppPath: string | undefined;

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
    platform: s.platform,
    app: s.app,
    iosXctestrun: s.iosXctestrun,
    simulator: s.simulator,
    resetAppDeepLink: s.resetAppDeepLink,
    resetAppWaitMs: s.resetAppWaitMs,
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
    await device.setDevice(
      msg.deviceSerial,
      isNetworkTracingEnabled(config.trace),
      networkHostsForPac(config.trace),
    );
  }

  // Wake and unlock device screen
  try {
    sendProgress('waking and unlocking device');
    await device.wake();
    await device.unlock();
  } catch {
    // Non-fatal
  }

  // Install app under test if APK path is configured and not already installed.
  // On a freshly-launched emulator, the AVD snapshot may have a stale copy of
  // the app baked in (so `pm list packages` says installed, but the bytes are
  // out of date). Always reinstall on fresh emulators to be safe — the cost
  // is small and the alternative is silent failures with stale UI.
  if (config.apk) {
    const alreadyInstalled = !msg.freshEmulator
      && config.package
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
  } else if (config.platform === 'ios' && config.app && msg.deviceSerial) {
    // iOS: install the .app on this device/simulator if not already present.
    // The CLI only installs on the primary target; cloned workers need it too.
    // Same fresh-simulator caveat as Android — reinstall unconditionally on
    // a freshly-cloned simulator since the bundle may be stale.
    // Physical devices go through devicectl, simulators go through simctl.
    const resolvedApp = path.resolve(config.rootDir, config.app);
    const { isPhysicalDevice, installAppOnDevice, isAppInstalledOnDevice } =
      await import('./ios-devicectl.js');
    const isPhys = isPhysicalDevice(msg.deviceSerial);
    if (isPhys) {
      const alreadyInstalled =
        config.package && (await isAppInstalledOnDevice(msg.deviceSerial, config.package));
      if (!alreadyInstalled) {
        sendProgress(`installing ${path.basename(resolvedApp)} on device`);
        await installAppOnDevice(msg.deviceSerial, resolvedApp);
      }
    } else {
      const alreadyInstalled = !msg.freshEmulator
        && config.package
        && isAppInstalled(msg.deviceSerial, config.package);
      if (!alreadyInstalled) {
        sendProgress(`installing ${path.basename(resolvedApp)}`);
        installApp(msg.deviceSerial, resolvedApp);
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
  let resolvedIosXctestrun = config.iosXctestrun
    ? path.resolve(config.rootDir, config.iosXctestrun)
    : undefined;
  // Auto-detect xctestrun if omitted, mirroring the single-worker
  // resolution in cli.ts. Picks the device-slice xctestrun under
  // ios-agent/.build-device for physical devices and the newest
  // simulator-slice xctestrun from Xcode DerivedData for simulators.
  if (!resolvedIosXctestrun && config.platform === 'ios' && msg.deviceSerial) {
    const { isPhysicalDevice } = await import('./ios-devicectl.js');
    const { findDeviceXctestrun, findSimulatorXctestrun } = await import('./ios-device-resolve.js');
    const isPhys = isPhysicalDevice(msg.deviceSerial);
    const found = isPhys ? findDeviceXctestrun(config.rootDir) : findSimulatorXctestrun();
    if (found) {
      resolvedIosXctestrun = found;
      sendProgress(`auto-detected xctestrun: ${path.basename(found)}`);
    }
  }
  const resolvedIosAppPath = config.platform === 'ios' && config.app
    ? path.resolve(config.rootDir, config.app)
    : undefined;
  resolvedXctestrunPath = resolvedIosXctestrun;
  resolvedAppPath = resolvedIosAppPath;
  sendProgress('starting Pilot agent');
  await device.startAgent(
    config.package ?? '',
    resolvedAgentApk,
    resolvedAgentTestApk,
    resolvedIosXctestrun,
    resolvedIosAppPath,
    isNetworkTracingEnabled(config.trace),
  );

  try {
    if (config.package) {
      sendProgress(`launching ${config.package}`);
      await launchConfiguredApp(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun, resolvedIosAppPath),
        'worker initialization',
      );
    } else {
      sendProgress('validating session readiness');
      await ensureSessionReady(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun),
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
      sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun),
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
        // On retry (attempt 2), bust the ESM import cache so the file's
        // test registrations re-execute. Without this, import() returns the
        // cached module and no tests are registered for the retry.
        bustImportCache: attempt > 1,
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
  iosXctestrunPath?: string,
  iosAppPath?: string,
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
    iosXctestrunPath: iosXctestrunPath ?? resolvedXctestrunPath,
    iosAppPath: iosAppPath ?? resolvedAppPath,
    deviceSerial: serial,
    networkTracingEnabled: isNetworkTracingEnabled(config.trace),
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
  const errMsg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `Worker ${workerId}: Recovering session after infrastructure error in ${path.basename(filePath)}: ${errMsg}\n`,
  );

  // On iOS, check if the simulator itself is unhealthy (e.g. "Shutting Down"
  // state, crashed, or unresponsive). If so, reboot it before attempting
  // session recovery — otherwise startAgent/launchApp will keep failing.
  if (config?.platform === 'ios' && assignedSerial) {
    const health = probeSimulatorHealth(assignedSerial);
    if (!health.healthy) {
      process.stderr.write(
        `Worker ${workerId}: Simulator ${assignedSerial} is unhealthy (${health.reason}), rebooting...\n`,
      );
      rebootSimulator(assignedSerial);
      // Re-install the app after reboot — it may have been lost
      if (config.app) {
        const resolvedApp = path.resolve(config.rootDir, config.app);
        installApp(assignedSerial, resolvedApp);
      }
      process.stderr.write(
        `Worker ${workerId}: Simulator rebooted and healthy.\n`,
      );
    }
  }

  if (config?.package) {
    await launchConfiguredApp(
      sessionContext(undefined),
      `recovery for ${path.basename(filePath)}`,
      { allowSoftReset: false },
    );
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
