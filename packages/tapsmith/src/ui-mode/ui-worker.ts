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
import { TapsmithGrpcClient } from '../grpc-client.js';
import { Device } from '../device.js';
import { runTestFile, collectResults } from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { isPackageInstalled, waitForPackageIndexed } from '../emulator.js';
import { installApp, isAppInstalled, probeSimulatorHealth, rebootSimulator } from '../ios-simulator.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  isRecoverableInfrastructureError,
  configFromSerialized,
} from '../worker-protocol.js';
import { ensureSessionReady, launchConfiguredApp, type SessionPreflightContext } from '../session-preflight.js';
import type { PreparedState } from '../app-reset.js';
import { createActionProgressMessenger } from '../action-progress-renderer.js';
import { isAbortError } from '../abort.js';
import type { AnyTraceEvent } from '../trace/types.js';
import { isNetworkTracingEnabled, networkHostsForPac } from '../trace/types.js';
import { encodeNetworkBodies } from './encode-bodies.js';
import { streamSourcesForEvent } from './source-stream.js';
import type {
  UIWorkerMessage,
  UIWorkerChildMessage,
  UIWorkerInitMessage,
  UIWorkerTraceEventMessage,
} from './ui-protocol.js';

// ─── State ───

let workerId = -1;
let device: Device | undefined;
let client: TapsmithGrpcClient | undefined;
let config: TapsmithConfig | undefined;
let assignedSerial: string | undefined;
let screenshotDir: string | undefined;
let ipcOpen = true;
let currentAbortController: AbortController | undefined;
let resolvedXctestrunPath: string | undefined;

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

/**
 * A launch that already left the app in fresh state (startup, warmup,
 * recovery). Handed to the next file's runner so it can skip its own reset
 * when the declared policy is satisfied — consumed exactly once.
 */
let preparedDevice: PreparedState | undefined;
function consumePreparedDevice(): PreparedState | undefined {
  const p = preparedDevice;
  preparedDevice = undefined;
  return p;
}

function sessionContext(
  deviceSerial?: string,
  agentApkPath?: string,
  agentTestApkPath?: string,
  iosXctestrunPath?: string,
): SessionPreflightContext {
  if (!device || !client || !config) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }
  const serial = deviceSerial ?? assignedSerial;
  const label = serial
    ? `UI Worker ${workerId} (${serial})`
    : `UI Worker ${workerId}`;
  return {
    label, config, device, client, agentApkPath, agentTestApkPath,
    iosXctestrunPath: iosXctestrunPath ?? resolvedXctestrunPath,
    deviceSerial: serial,
    networkTracingEnabled: isNetworkTracingEnabled(config.trace),
  };
}

// ─── Trace event streaming ───

function setupTraceStreaming(dev: Device): void {
  const collector = dev.tracing._currentCollector;
  if (!collector) return;

  const sentSources = new Set<string>();
  collector.setEventCallback((event: AnyTraceEvent, screenshots, lifecycle) => {
    streamSourcesForEvent(event, sentSources, (p, fileName, content) =>
      send({ type: 'source', workerId, path: p, fileName, content }));
    const msg: UIWorkerTraceEventMessage = {
      type: 'trace-event',
      workerId,
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

  client = new TapsmithGrpcClient(daemonAddress);
  const ready = await client.waitForReady(10_000);
  if (!ready) {
    throw new Error(`UI Worker ${workerId}: Failed to connect to daemon at ${daemonAddress}`);
  }

  device = new Device(client, config);
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

  // Wake and unlock
  try {
    sendProgress('waking and unlocking device');
    await device.wake();
    await device.unlock();
  } catch {
    // Non-fatal
  }

  // Install app if needed. Always reinstall on freshly-launched devices —
  // the AVD/simulator snapshot may have a stale copy of the app baked in.
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
      if (config.package && msg.deviceSerial) {
        await waitForPackageIndexed(msg.deviceSerial, config.package);
      }
    }
  } else if (config.platform === 'ios' && config.app && msg.deviceSerial) {
    // iOS: install the .app on this device/simulator if not already present.
    // The CLI only installs on the primary target; cloned workers need it too.
    // Physical devices go through devicectl, simulators go through simctl.
    const resolvedApp = path.resolve(config.rootDir, config.app);
    const { isPhysicalDevice, installAppOnDevice, isAppInstalledOnDevice } =
      await import('../ios-devicectl.js');
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
  // resolution in cli.ts and the parallel-worker path in worker-runner.ts.
  if (!resolvedIosXctestrun && config.platform === 'ios' && msg.deviceSerial) {
    const { isPhysicalDevice } = await import('../ios-devicectl.js');
    const { findDeviceXctestrun, findSimulatorXctestrun } =
      await import('../ios-device-resolve.js');
    const isPhys = isPhysicalDevice(msg.deviceSerial);
    const found = isPhys ? findDeviceXctestrun(config.rootDir) : findSimulatorXctestrun();
    if (found) {
      resolvedIosXctestrun = found;
      sendProgress(`auto-detected xctestrun: ${path.basename(found)}`);
    }
  }
  resolvedXctestrunPath = resolvedIosXctestrun;
  // Cache the device-signed .app path on physical iOS so the daemon can
  // reinstall via devicectl for clearAppData (no host-filesystem container
  // access on real hardware). Matches the cli.ts setupSequentialDevice path.
  let resolvedIosAppPath: string | undefined;
  if (config.platform === 'ios' && config.app && msg.deviceSerial) {
    const { isPhysicalDevice } = await import('../ios-devicectl.js');
    if (isPhysicalDevice(msg.deviceSerial)) {
      resolvedIosAppPath = path.resolve(config.rootDir, config.app);
    }
  }
  sendProgress('starting Tapsmith agent');
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
      preparedDevice = await launchConfiguredApp(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun),
        'UI worker startup launch',
      );
    } else {
      sendProgress('validating session readiness');
      await ensureSessionReady(
        sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun),
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
    preparedDevice = await launchConfiguredApp(
      sessionContext(msg.deviceSerial, resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun),
      'emulator warmup launch',
    );
    await device.waitForIdle();
  }

  sendProgress('ready');
  send({ type: 'ready', workerId });

  // From here on, stream slow-device-action progress (between-file preflight,
  // test.use({appState}) restore, recovery) so the UI can show "Restoring app
  // state…" instead of a generic waiting state (PILOT-232). An action's end
  // clears the label — the indicator is "what's happening now", and the
  // Actions panel only renders it while no trace actions have streamed yet,
  // so traced in-test actions can't double-report. Unlike the stdout printer,
  // the label replaces an existing placeholder rather than adding output, so
  // it announces near-immediately; the tiny delay only skips sub-action blips.
  createActionProgressMessenger({
    startDelayMs: 250,
    emit: (text, phase) => sendProgress(phase === 'end' ? '' : text),
  });
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

  // Created BEFORE the between-files preflight so a stop that lands during
  // wake/unlock/app-reset is honored too — otherwise the abort IPC would be
  // a no-op and the worker would run the entire next file (PILOT-222).
  const abortController = new AbortController();
  currentAbortController = abortController;
  device._client._setAbortSignal(abortController.signal);

  try {
    // Ensure the device is awake — the screen may have auto-locked while
    // watch mode was idle waiting for file changes. The between-file app
    // reset itself is the runner's job (declared policy, recorded in the
    // trace as fixture setup, ending with its own readiness check).
    await device.wake();
    await device.unlock();
  } catch (err) {
    // Whether aborted or a genuine preflight failure, this run is over —
    // don't leave a stale controller for a later idle-state abort IPC.
    currentAbortController = undefined;
    if (abortController.signal.aborted || isAbortError(err)) {
      sendEmptyFileDone(filePath);
      return;
    }
    throw err;
  } finally {
    device._client._setAbortSignal(undefined);
    if (abortController.signal.aborted) currentAbortController = undefined;
  }
  if (abortController.signal.aborted) {
    // Stop arrived during preflight without failing a device call.
    sendEmptyFileDone(filePath);
    return;
  }

  // Send test source file
  try {
    const sourceContent = fs.readFileSync(filePath, 'utf-8');
    send({ type: 'source', workerId, path: filePath.replace(/\\/g, '/'), fileName: path.basename(filePath), content: sourceContent });
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

  // Hook into trace streaming — patch once and restore after each run
  // to prevent closure accumulation in persistent workers.
  const dev = device;
  const origStartManaged = dev.tracing._startManaged.bind(dev.tracing);
  dev.tracing._startManaged = (...args: Parameters<typeof dev.tracing._startManaged>) => {
    const collector = origStartManaged(...args);
    setupTraceStreaming(dev);
    return collector;
  };

  let suiteResult;
  try {
    suiteResult = await runFileWithRecovery(
      filePath, reporterProxy, projectUseOptions, projectName, testFilter,
      abortController.signal,
    );
  } finally {
    // Restore original to prevent accumulating wrappers across runs
    dev.tracing._startManaged = origStartManaged;
    currentAbortController = undefined;
  }

  const results = collectResults(suiteResult);

  send({
    type: 'file-done',
    workerId,
    filePath,
    results: results.map((r) => serializeTestResult(r, workerId)),
    suite: serializeSuiteResult(suiteResult, workerId),
  });
}

/** Report a file as done with no results — used when a user stop lands
 * before the file's tests ever started (e.g. during the preflight reset). */
function sendEmptyFileDone(filePath: string): void {
  const emptySuite: import('../runner.js').SuiteResult = { name: '', tests: [], suites: [], durationMs: 0 };
  send({
    type: 'file-done',
    workerId,
    filePath,
    results: [],
    suite: serializeSuiteResult(emptySuite, workerId),
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
        onTestStart: async (fullName: string, options?: { attributionOnly?: boolean }) => {
          send({ type: 'test-start', workerId, fullName, filePath, attributionOnly: options?.attributionOnly });
        },
        beforeEachTest: async (fullName: string) => {
          await ensureSessionReady(sessionContext(undefined), `before test ${fullName}`);
        },
        abortFileOnError: isRecoverableInfrastructureError,
        sessionContext: sessionContext(undefined),
        preparedDevice: consumePreparedDevice(),
        projectUseOptions,
        projectName,
        testFilter,
        onNetworkEntries: (entries) => {
          const { entries: safe, bodies } = encodeNetworkBodies(entries);
          send({ type: 'network', workerId, entries: safe, bodies });
        },
      });

      // A user stop is not an infrastructure failure — never recover/retry,
      // just return what ran (PILOT-222).
      if (abortSignal?.aborted) return suite;

      const infrastructureFailure = findRecoverableInfrastructureFailure(collectResults(suite));
      if (!infrastructureFailure) return suite;
      if (attempt === 2) throw infrastructureFailure;
      await recoverFileSession(filePath, infrastructureFailure);
      continue;
    } catch (err) {
      if (abortSignal?.aborted || !isRecoverableInfrastructureError(err) || attempt === 2) throw err;
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

  // On iOS, check if the simulator itself is unhealthy (e.g. "Shutting Down"
  // state, crashed, or unresponsive). If so, reboot it before attempting
  // session recovery — otherwise startAgent/launchApp will keep failing.
  if (config?.platform === 'ios' && assignedSerial) {
    const health = probeSimulatorHealth(assignedSerial);
    if (!health.healthy) {
      process.stderr.write(
        `UI Worker ${workerId}: Simulator ${assignedSerial} is unhealthy (${health.reason}), rebooting...\n`,
      );
      rebootSimulator(assignedSerial);
      if (config.app) {
        const resolvedApp = path.resolve(config.rootDir, config.app);
        installApp(assignedSerial, resolvedApp);
      }
      process.stderr.write(
        `UI Worker ${workerId}: Simulator rebooted and healthy.\n`,
      );
    }
  }

  if (config?.package) {
    preparedDevice = await launchConfiguredApp(
      sessionContext(undefined),
      `recovery for ${path.basename(filePath)}`,
    );
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
