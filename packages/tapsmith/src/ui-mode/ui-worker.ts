/**
 * Persistent UI worker child process.
 *
 * Combines the persistent lifecycle of worker-runner.ts (init once, run
 * many files) with real-time trace streaming to the UI server. Every UI
 * session runs through these workers — one per device; a single device is
 * one worker that adopts the primary daemon/agent the CLI provisioned.
 *
 * @see PILOT-87
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { TapsmithGrpcClient } from '../grpc-client.js';
import { Device } from '../device.js';
import { runTestFile, collectResults } from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { installedApkMatches, isPackageInstalled, waitForPackageIndexed } from '../emulator.js';
import { installApp, isAppInstalled, probeSimulatorHealth, rebootSimulator } from '../ios-simulator.js';
import {
  serializeTestResult,
  serializeSuiteResult,
  isRecoverableInfrastructureError,
  configFromSerialized,
} from '../worker-protocol.js';
import { ensureSessionReady, executeAppReset, launchConfiguredApp, probeResetCapabilities, type SessionPreflightContext } from '../session-preflight.js';
import type { PreparedState, ResetCapabilities } from '../app-reset.js';
import { createActionProgressMessenger } from '../action-progress-renderer.js';
import { isAbortError } from '../abort.js';
import type { AnyTraceEvent } from '../trace/types.js';
import { isNetworkTracingEnabled, networkHostsForPac, networkPassthroughHosts } from '../trace/types.js';
import { encodeNetworkBodies } from './encode-bodies.js';
import { streamSourcesForEvent } from './source-stream.js';
import type {
  UIWorkerMessage,
  UIWorkerChildMessage,
  UIWorkerInitMessage,
  UIWorkerPrepareMessage,
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
let resolvedAgentApkPath: string | undefined;
let resolvedAgentTestApkPath: string | undefined;
let resolvedIosAppPathCached: string | undefined;

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
/** Runtime reset capabilities (in-app hooks detected?), shared by every context this worker builds. */
const sharedCapabilities: ResetCapabilities = {};
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
    label, config, device, client,
    agentApkPath: agentApkPath ?? resolvedAgentApkPath,
    agentTestApkPath: agentTestApkPath ?? resolvedAgentTestApkPath,
    iosXctestrunPath: iosXctestrunPath ?? resolvedXctestrunPath,
    iosAppPath: resolvedIosAppPathCached,
    deviceSerial: serial,
    networkTracingEnabled: isNetworkTracingEnabled(config.trace),
    capabilities: sharedCapabilities,
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
      networkPassthroughHosts(config.trace),
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

  // Adopting the primary device: the CLI already installed the app, started
  // the agent and cold-launched. Resolve the artifact paths recovery needs,
  // verify the session, and hand that launch to the first file as its
  // prepared state.
  if (msg.adoptPrimary) {
    await resolveArtifactPaths(msg);
    sendProgress('attaching to the primary device session');
    await ensureSessionReady(sessionContext(msg.deviceSerial), 'UI worker adopt');
    await probeResetCapabilities(sessionContext(msg.deviceSerial));
    preparedDevice = {
      policy: { mode: 'clear', scope: 'file' },
      preparedAt: Date.now(),
      durationMs: 0,
      source: 'startup launch',
    };
    finishInit();
    return;
  }

  // Install app if needed. Always reinstall on freshly-launched devices —
  // the AVD/simulator snapshot may have a stale copy of the app baked in.
  if (config.apk) {
    const resolvedApkPath = path.resolve(config.rootDir, config.apk);
    const alreadyInstalled = !msg.freshEmulator
      && config.package
      && msg.deviceSerial
      && isPackageInstalled(msg.deviceSerial, config.package)
      // A rebuilt APK must replace the installed one.
      && installedApkMatches(msg.deviceSerial, config.package, resolvedApkPath) !== false;

    if (alreadyInstalled) {
      sendProgress(`app ${config.package} already installed (matching build), skipping APK install`);
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
  const { resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun, resolvedIosAppPath } =
    await resolveArtifactPaths(msg);
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

  finishInit();
}

/**
 * Resolve agent APK / xctestrun / device-signed .app paths from the config,
 * auto-detecting the xctestrun like cli.ts and worker-runner.ts do. Needed
 * both to start the agent and (in adopt mode) for session recovery later.
 */
async function resolveArtifactPaths(msg: UIWorkerInitMessage): Promise<{
  resolvedAgentApk?: string
  resolvedAgentTestApk?: string
  resolvedIosXctestrun?: string
  resolvedIosAppPath?: string
}> {
  if (!config) throw new Error(`UI Worker ${workerId}: Not initialized`);
  const resolvedAgentApk = config.agentApk
    ? path.resolve(config.rootDir, config.agentApk)
    : undefined;
  const resolvedAgentTestApk = config.agentTestApk
    ? path.resolve(config.rootDir, config.agentTestApk)
    : undefined;
  let resolvedIosXctestrun = config.iosXctestrun
    ? path.resolve(config.rootDir, config.iosXctestrun)
    : undefined;
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
  resolvedAgentApkPath = resolvedAgentApk;
  resolvedAgentTestApkPath = resolvedAgentTestApk;
  resolvedIosAppPathCached = resolvedIosAppPath;
  return { resolvedAgentApk, resolvedAgentTestApk, resolvedIosXctestrun, resolvedIosAppPath };
}

function finishInit(): void {
  sendProgress('ready');
  send({ type: 'ready', workerId, policy: preparedDevice?.policy, capabilities: { ...sharedCapabilities } });

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
  preparedFor?: PreparedState,
): Promise<void> {
  if (!config || !device) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }
  // A background preparation that the server judged to satisfy this file's
  // policy replaces whatever launch-time prepared state was pending.
  if (preparedFor) preparedDevice = preparedFor;

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
        resetCapabilities: sharedCapabilities,
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

// ─── Background preparation ───

let currentPrepare: { prepareId: string; abort: AbortController } | undefined;

/**
 * Reset the app to `policy` while no run is in flight so the next Run click
 * pays only a readiness check. Cooperative cancellation: a `run-file` that
 * arrives mid-prepare aborts it (the gRPC call is cancelled through the
 * client's abort signal) and the queue then runs the file — the run never
 * waits for the preparation to finish.
 */
async function handlePrepare(msg: UIWorkerPrepareMessage): Promise<void> {
  if (!config || !device) {
    throw new Error(`UI Worker ${workerId}: Not initialized`);
  }
  const abort = new AbortController();
  currentPrepare = { prepareId: msg.prepareId, abort };
  device._client._setAbortSignal(abort.signal);
  const startedAt = Date.now();
  try {
    await device.wake();
    await device.unlock();
    // Project-level use (appState etc.) is folded into the policy by the
    // server; the effective config is the worker's own.
    const report = await executeAppReset(sessionContext(undefined), msg.policy, {
      phase: `background preparation${msg.forFile ? ` for ${path.basename(msg.forFile)}` : ''}`,
    });
    if (abort.signal.aborted) throw new Error('preparation cancelled');
    preparedDevice = undefined; // the server hands the prepared state back with run-file
    send({
      type: 'prepared',
      workerId,
      prepareId: msg.prepareId,
      policy: msg.policy,
      startedAt,
      durationMs: Date.now() - startedAt,
      steps: report.steps.map((s) => `${s.name}: ${s.durationMs}ms${s.ok ? '' : ' (failed)'}`),
      satisfiedBy: report.satisfiedBy,
    });
  } catch (err) {
    const cancelled = abort.signal.aborted || isAbortError(err);
    send({
      type: 'prepare-failed',
      workerId,
      prepareId: msg.prepareId,
      error: { message: err instanceof Error ? err.message : String(err) },
      cancelled,
    });
  } finally {
    device._client._setAbortSignal(undefined);
    if (currentPrepare?.prepareId === msg.prepareId) currentPrepare = undefined;
  }
}

// ─── Message loop ───
//
// Device-touching operations (init, run-file) are serialized through one
// promise chain: the IPC handler used to start each message's async work
// concurrently, so a `run-file` arriving while a previous op was still on
// the device raced it. `abort` and `shutdown` bypass the queue — they exist
// to interrupt whatever the queue is doing.

let opQueue: Promise<void> = Promise.resolve();

function reportError(err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`UI Worker ${workerId} error: ${error.message}\n`);
  send({
    type: 'error',
    workerId,
    error: { message: error.message, stack: error.stack },
  });
}

function enqueue(op: () => Promise<void>): void {
  opQueue = opQueue.then(op, op).catch(reportError);
}

process.on('message', (msg: UIWorkerMessage) => {
  switch (msg.type) {
    case 'init':
      enqueue(() => handleInit(msg));
      break;
    case 'run-file':
      enqueue(() => handleRunFile(msg.filePath, msg.projectUseOptions, msg.projectName, msg.testFilter, msg.preparedFor));
      break;
    case 'prepare':
      enqueue(() => handlePrepare(msg));
      break;
    case 'cancel-prepare':
      if (currentPrepare?.prepareId === msg.prepareId) currentPrepare.abort.abort();
      break;
    case 'abort':
      currentAbortController?.abort();
      break;
    case 'shutdown':
      handleShutdown();
      break;
  }
});
