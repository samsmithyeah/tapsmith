/**
 * Parallel test dispatcher.
 *
 * Coordinates multiple worker processes, each assigned to a dedicated
 * device and daemon instance. Distributes test files using a work-stealing
 * queue for natural load balancing.
 *
 * @see PILOT-106
 */

import { fork, spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveDeviceStrategy, type PilotConfig } from './config.js';
import { PilotGrpcClient } from './grpc-client.js';
import type { TestResult, SuiteResult } from './runner.js';
import type { PilotReporter, FullResult } from './reporter.js';
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  SerializedConfig,
} from './worker-protocol.js';
import { deserializeTestResult, deserializeSuiteResult } from './worker-protocol.js';
import {
  clearOfflineEmulatorTransports,
  provisionEmulators,
  preserveEmulatorsForReuse,
  forceCleanupEmulators,
  filterHealthyDevices,
  getRunningAvdName,
  cleanupStaleEmulators,
  prefilterDevicesForStrategy,
  selectDevicesForStrategy,
  type DeviceHealthResult,
  type LaunchedEmulator,
} from './emulator.js';
import {
  provisionSimulators,
  cleanupStaleSimulators,
  preserveSimulatorsForReuse,
  forceCleanupSimulators,
  filterHealthySimulators,
  listCompatibleBootedSimulators,
  type ClonedSimulator,
} from './ios-simulator.js';
import { resolveTraceConfig } from './trace/types.js';
import { ensureSudoAccess } from './macos-proxy.js';
import { freeStaleAgentPort, findPidsOnPort } from './port-utils.js';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

interface TaggedFile {
  filePath: string
  projectUseOptions?: import('./worker-protocol.js').RunFileUseOptions
  projectName?: string
}

interface WorkerHandle {
  id: number
  process: ChildProcess
  deviceSerial: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
  busy: boolean
  currentFile?: TaggedFile
  retired?: boolean
}

export interface DispatcherOptions {
  config: PilotConfig
  reporter: PilotReporter
  testFiles: string[]
  workers: number
  /** Resolved projects for wave-based execution. When set, files are dispatched per-wave. */
  projects?: import('./project.js').ResolvedProject[]
  /** Pre-sorted project waves from topologicalSort(). Required when `projects` is set. */
  projectWaves?: import('./project.js').ResolvedProject[][]
}

const EXISTING_DEVICE_INIT_TIMEOUT_MS = 90_000;
const LAUNCHED_EMULATOR_INIT_TIMEOUT_MS = 180_000;

/**
 * Run test files in parallel across multiple workers/devices.
 * Returns a FullResult aggregating all worker results.
 */
export async function runParallel(opts: DispatcherOptions): Promise<FullResult> {
  const { config, reporter, testFiles } = opts;
  const isIos = config.platform === 'ios';
  const deviceStrategy = resolveDeviceStrategy(config);

  // ─── Pre-discovery cleanup ───
  let reusableSimulatorUdids: string[] = [];

  if (isIos) {
    if (config.simulator) {
      const staleResult = cleanupStaleSimulators(config.simulator);
      reusableSimulatorUdids = staleResult.reusable;
      if (staleResult.killed.length > 0) {
        process.stderr.write(
          `${DIM}Cleaned up ${staleResult.killed.length} stale simulator(s).${RESET}\n`,
        );
      }
      if (staleResult.reusable.length > 0) {
        process.stderr.write(
          `${DIM}Reusing ${staleResult.reusable.length} simulator(s) from previous run.${RESET}\n`,
        );
      }
    }
  } else {
    const clearedOfflineEmulators = clearOfflineEmulatorTransports();
    for (const serial of clearedOfflineEmulators) {
      process.stderr.write(
        `${YELLOW}Cleared stale offline emulator transport ${serial} before device discovery.${RESET}\n`,
      );
    }

    const staleResult = cleanupStaleEmulators(config.avd);
    if (staleResult.killed.length > 0) {
      process.stderr.write(
        `${DIM}Cleaned up ${staleResult.killed.length} stale emulator(s).${RESET}\n`,
      );
    }
  }

  // Spawn the first worker daemon early so we can use it for device discovery.
  // This daemon will also serve as worker 0's daemon.
  const baseDaemonPort = Number.parseInt(config.daemonAddress.split(':').pop() ?? '50051', 10);
  const baseAgentPort = 18700;
  const rawBin = process.env.PILOT_DAEMON_BIN ?? config.daemonBin ?? 'pilot-core';
  const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
    ? path.resolve(config.rootDir, rawBin)
    : rawBin;

  const firstDaemonPort = baseDaemonPort + 1;
  const firstAgentPort = baseAgentPort + 1;

  // Free the first agent host port from any leftover stale process before
  // spawning firstDaemon. The common offender is a leftover iOS `PilotAgent`
  // from a previous iOS run — its host-localhost socket squats on the port
  // we want to use for `adb forward`, silently shadowing the Android agent
  // so every command routes to the iOS simulator. Subsequent worker slots
  // free their own agent port inline during slot allocation below, since
  // the slot allocator may walk past `opts.workers` when daemon ports are
  // occupied — freeing only `[0, opts.workers)` upfront would miss them.
  freeStaleAgentPort(firstAgentPort);

  const firstDaemon = spawn(
    daemonBin,
    ['--port', String(firstDaemonPort), '--agent-port', String(firstAgentPort)],
    { stdio: 'ignore' },
  );
  firstDaemon.unref();
  firstDaemon.on('error', () => {
    // Handled by the waitForReady timeout below
  });

  // Wait for daemon to be ready
  const discoveryClient = new PilotGrpcClient(`localhost:${firstDaemonPort}`);
  const ready = await discoveryClient.waitForReady(10_000);
  if (!ready) {
    firstDaemon.kill();
    const portInUse = !(await isPortAvailable(firstDaemonPort));
    const hint = portInUse
      ? ` Port ${firstDaemonPort} is already in use — another Pilot run may be active, or a stale daemon is running. Kill it with: lsof -ti tcp:${firstDaemonPort} | xargs kill`
      : ` Is pilot-core installed? (tried: ${daemonBin})`;
    throw new Error(`Failed to start worker daemon.${hint}`);
  }

  // Verify the daemon we connected to is actually OUR firstDaemon and not a
  // stale pilot-core left over from a previous run squatting on the same port.
  // If our spawn failed to bind silently (firstDaemon.on('error') swallows it),
  // waitForReady would have happily connected to the squatter, and the entire
  // run would proceed against an incoherent daemon — wrong simulators, wrong
  // worker config, mysterious test failures. Fail fast with a clear hint
  // instead of autonomously killing the squatter (it might belong to another
  // concurrent Pilot run, which the slot allocator would handle by walking).
  const listenerPids = findPidsOnPort(firstDaemonPort);
  if (firstDaemon.pid !== undefined && !listenerPids.includes(firstDaemon.pid)) {
    firstDaemon.kill();
    const squatterHint = listenerPids.length > 0
      ? ` Port ${firstDaemonPort} is held by PID ${listenerPids.join(',')} — likely a stale pilot-core daemon from a previous run. If no other Pilot run is active, kill it with: kill ${listenerPids.join(' ')}`
      : ` Port ${firstDaemonPort} is held by an unknown process. Try: lsof -ti tcp:${firstDaemonPort} | xargs kill`;
    throw new Error(`Failed to start worker daemon: spawned process bound to a different port (likely failed to bind).${squatterHint}`);
  }

  // Discover available devices
  const deviceList = await discoveryClient.listDevices();
  discoveryClient.close();
  // Device states from pilot-core: "Discovered" (available), "Active" (in use), "Disconnected"
  const onlineDevices = deviceList.devices.filter((d) =>
    d.state === 'Discovered' || d.state === 'Active',
  );

  let launchedEmulators: LaunchedEmulator[] = [];
  let clonedSimulators: ClonedSimulator[] = [];
  let freshIosUdids = new Set<string>();
  let deviceSerials: string[];

  if (isIos) {
    // ─── iOS device discovery & provisioning ───
    // The daemon reports ALL booted iOS simulators. Filter to only those
    // compatible with the primary — different runtimes cause xcodebuild
    // test-without-building to fail since the xctestrun is OS-version-specific.
    const iosDevices = onlineDevices.filter((d) => d.platform === 'ios');
    let candidateUdids = iosDevices.map((d) => d.serial);
    if (candidateUdids.length > 0) {
      const compatible = listCompatibleBootedSimulators(candidateUdids[0]);
      const compatibleSet = new Set(compatible.map((s) => s.udid));
      candidateUdids = candidateUdids.filter((u) => compatibleSet.has(u));
    }
    const iosHealthy = filterHealthySimulators(candidateUdids);
    for (const unhealthy of iosHealthy.unhealthySimulators) {
      process.stderr.write(
        `${YELLOW}Skipping unhealthy simulator ${unhealthy.udid}: ${unhealthy.reason}.${RESET}\n`,
      );
    }
    deviceSerials = iosHealthy.healthyUdids;

    const neededWorkers = Math.min(opts.workers, testFiles.length);
    if (deviceSerials.length < neededWorkers && config.simulator) {
      process.stderr.write(
        `${DIM}Provisioning iOS simulators: have ${deviceSerials.length}, need ${neededWorkers}${RESET}\n`,
      );
      const provision = provisionSimulators({
        simulatorName: config.simulator,
        workers: neededWorkers,
        existingUdids: deviceSerials,
        appPath: config.app ? path.resolve(config.rootDir, config.app) : undefined,
        reusableUdids: reusableSimulatorUdids,
      });
      clonedSimulators = provision.clonedSimulators;
      freshIosUdids = provision.freshUdids;
      deviceSerials = provision.allUdids;

      if (clonedSimulators.length > 0) {
        process.stderr.write(
          `${DIM}Cloned ${clonedSimulators.length} simulator(s) for parallel workers.${RESET}\n`,
        );
      }

      // Re-discover devices so the daemon sees newly booted simulators
      if (provision.allUdids.length > iosDevices.length) {
        // Give simulators a moment to register, then refresh
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const refreshClient = new PilotGrpcClient(`localhost:${firstDaemonPort}`);
        await refreshClient.waitForReady(5_000);
        await refreshClient.listDevices();
        refreshClient.close();
      }
    }
  } else {
    // ─── Android device discovery & provisioning ───
    const androidDevices = onlineDevices.filter((d) => d.platform !== 'ios');
    const prefilteredOnline = prefilterDevicesForStrategy(
      androidDevices.map((d) => d.serial),
      deviceStrategy,
      config.avd,
    );
    warnSkippedDevices(prefilteredOnline.skippedDevices);
    const healthyOnline = filterHealthyDevices(prefilteredOnline.candidateSerials);
    warnUnhealthyDevices(healthyOnline.unhealthyDevices);
    const selectedOnline = selectDevicesForStrategy(
      healthyOnline.healthySerials,
      deviceStrategy,
      config.avd,
    );
    warnSkippedDevices(
      selectedOnline.skippedDevices.filter(
        (device) => !prefilteredOnline.skippedDevices.some((prefiltered) => prefiltered.serial === device.serial),
      ),
    );

    if (
      config.launchEmulators &&
      selectedOnline.selectedSerials.length < Math.min(opts.workers, testFiles.length)
    ) {
      const provision = await provisionEmulators({
        existingSerials: selectedOnline.selectedSerials,
        occupiedSerials: androidDevices.map((d) => d.serial),
        workers: Math.min(opts.workers, testFiles.length),
        avd: config.avd,
      });
      launchedEmulators = provision.launched;
      const healthyProvisioned = filterHealthyDevices(provision.allSerials);
      warnUnhealthyDevices(healthyProvisioned.unhealthyDevices);
      const selectedProvisioned = selectDevicesForStrategy(
        healthyProvisioned.healthySerials,
        deviceStrategy,
        config.avd,
      );
      warnSkippedDevices(selectedProvisioned.skippedDevices);
      deviceSerials = selectedProvisioned.selectedSerials;
    } else {
      deviceSerials = selectedOnline.selectedSerials;
    }
  }

  if (deviceSerials.length === 0) {
    throw new Error(
      isIos
        ? `No booted iOS simulators found.${config.simulator ? ` Boot a simulator matching '${config.simulator}', or add more simulators for parallel execution.` : ' Set `simulator` in your config and boot at least one.'}`
        : 'No online devices found. Connect a device, start an emulator, ' +
          'or set `launchEmulators: true` in your config.',
    );
  }

  const workers: WorkerHandle[] = [];
  const allResults: TestResult[] = [];
  const allSuites: SuiteResult[] = [];
  const totalStart = Date.now();
  let setupDuration = 0;
  // Cap workers at the max files in any single wave — workers in other waves
  // would sit idle since waves execute sequentially.
  const maxFilesInWave = opts.projectWaves
    ? Math.max(...opts.projectWaves.map((wave) =>
        wave.reduce((sum, p) => sum + p.testFiles.length, 0),
      ))
    : testFiles.length;
  const maxUsefulWorkers = Math.min(opts.workers, maxFilesInWave);
  let firstDaemonAssigned = false;

  // Register signal handlers to ensure cleanup on SIGINT/SIGTERM.
  // Without this, Ctrl-C leaves orphaned daemons and emulators.
  const emergencyCleanup = () => {
    for (const worker of workers) {
      try { worker.process?.kill(); } catch { /* already dead */ }
      try { worker.daemonProcess?.kill(); } catch { /* already dead */ }
    }
    if (!firstDaemonAssigned) {
      try { firstDaemon.kill(); } catch { /* already dead */ }
    }
    if (launchedEmulators.length > 0) {
      forceCleanupEmulators(launchedEmulators);
    }
    if (clonedSimulators.length > 0) {
      forceCleanupSimulators(clonedSimulators);
    }
  };
  process.on('SIGINT', emergencyCleanup);
  process.on('SIGTERM', emergencyCleanup);

  try {
    // Fork worker processes.
    // When running under tsx (TypeScript test files), __dirname points to src/
    // and we need to fork with tsx as the loader. When running from compiled JS,
    // __dirname points to dist/ and we can fork directly.
    const jsScript = path.resolve(__dirname, 'worker-runner.js');
    const tsScript = path.resolve(__dirname, 'worker-runner.ts');
    const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript);
    const resolvedScript = useTypeScript ? tsScript : jsScript;

    // When forking a .ts file, we need tsx to handle it.
    let tsxBin: string | undefined;
    if (useTypeScript) {
      const pilotPkgDir = path.resolve(__dirname, '..');
      const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx');
      tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';
    }

    // iOS: pre-acquire sudo access for network capture in the main process
    // so workers don't each independently prompt for a password.
    if (isIos) {
      const traceConfig = resolveTraceConfig(config.trace);
      if (traceConfig.mode !== 'off' && traceConfig.network) {
        ensureSudoAccess();
      }
    }

    // Serialize config for workers
    const serializedConfig: SerializedConfig = {
      timeout: config.timeout,
      retries: config.retries,
      screenshot: config.screenshot,
      rootDir: config.rootDir,
      outputDir: config.outputDir,
      apk: config.apk,
      activity: config.activity,
      package: config.package,
      agentApk: config.agentApk,
      agentTestApk: config.agentTestApk,
      trace: typeof config.trace === 'string' || typeof config.trace === 'object'
        ? config.trace
        : undefined,
      platform: config.platform,
      app: config.app,
      iosXctestrun: config.iosXctestrun,
      simulator: config.simulator,
      resetAppDeepLink: config.resetAppDeepLink,
      resetAppWaitMs: config.resetAppWaitMs,
    };

    const launchedSerials = new Set(launchedEmulators.map((emu) => emu.serial));

    // Pre-check port availability to avoid wasting time on occupied ports.
    // Ports are baseDaemonPort+1+workerId; skip workers whose port is taken.
    // For each candidate slot we also free any stale iOS PilotAgent squatting
    // on the agent port — the slot loop may walk past opts.workers when daemon
    // ports are occupied, so we cannot rely on a fixed-size upfront sweep.
    // wid=0 is special: it reuses firstDaemon (already spawned), and its
    // agent port (firstAgentPort) was freed before that spawn.
    const availableWorkerSlots: Array<{ workerId: number; daemonPort: number; agentPort: number }> = [];
    for (let wid = 0; availableWorkerSlots.length < maxUsefulWorkers && availableWorkerSlots.length < deviceSerials.length && wid < maxUsefulWorkers + 10; wid++) {
      const port = baseDaemonPort + 1 + wid;
      const agentPort = baseAgentPort + 1 + wid;
      if (wid === 0) {
        availableWorkerSlots.push({ workerId: availableWorkerSlots.length, daemonPort: port, agentPort });
        continue;
      }
      freeStaleAgentPort(agentPort);
      if (await isPortAvailable(port)) {
        availableWorkerSlots.push({ workerId: availableWorkerSlots.length, daemonPort: port, agentPort });
      } else {
        process.stderr.write(
          `${DIM}Skipping port ${port} (in use), trying next...${RESET}\n`,
        );
      }
    }

    // Initialize all workers in parallel — each has its own daemon, device,
    // and agent so there are no shared resources during init.
    const initPromises: Promise<WorkerHandle>[] = [];

    for (const slot of availableWorkerSlots) {
      const candidateSerial = deviceSerials[slot.workerId];
      const isFresh = launchedSerials.has(candidateSerial) || freshIosUdids.has(candidateSerial);
      initPromises.push(
        initializeWorker({
          workerId: slot.workerId,
          deviceSerial: candidateSerial,
          daemonBin,
          serializedConfig,
          baseDaemonPort,
          baseAgentPort,
          firstDaemon,
          resolvedScript,
          initializationTimeoutMs: isFresh
            ? LAUNCHED_EMULATOR_INIT_TIMEOUT_MS
            : EXISTING_DEVICE_INIT_TIMEOUT_MS,
          freshEmulator: isFresh,
          tsxBin,
          daemonPortOverride: slot.daemonPort,
          agentPortOverride: slot.agentPort,
        }),
      );
    }

    const initResults = await Promise.allSettled(initPromises);
    for (let i = 0; i < initResults.length; i++) {
      const result = initResults[i];
      if (result.status === 'fulfilled') {
        const worker = result.value;
        if (worker.id === 0) firstDaemonAssigned = true;
        workers.push(worker);
      } else {
        const serial = deviceSerials[i];
        process.stderr.write(
          `${YELLOW}Skipping device ${serial}: ${result.reason instanceof Error ? result.reason.message : result.reason}.${RESET}\n`,
        );
      }
    }

    const workerCount = workers.length;

    if (workerCount === 0) {
      throw new Error(
        'No worker-ready devices found. Start healthy emulators or devices, ' +
        'or set `launchEmulators: true` in your config.',
      );
    }

    if (workerCount < maxUsefulWorkers) {
      process.stderr.write(
        `${YELLOW}Warning: Requested ${maxUsefulWorkers} workers but only ${workerCount} healthy worker-ready device(s) available. Using ${workerCount} worker(s).${RESET}\n`,
      );
    }

    setupDuration = Date.now() - totalStart;

    process.stderr.write(
      `${DIM}Running ${testFiles.length} test file(s) across ${workerCount} worker(s)${RESET}\n`,
    );

    // ─── Wave-based work-stealing dispatch ───
    // Build tagged file entries for dispatch. When projects are configured,
    // we dispatch in waves (one per dependency tier). Otherwise, single wave.

    type Wave = TaggedFile[]

    const waves: Wave[] = [];
    const failedProjects = new Set<string>();

    if (opts.projectWaves && opts.projects) {
      for (const wave of opts.projectWaves) {
        const waveFiles: TaggedFile[] = [];
        for (const project of wave) {
          for (const file of project.testFiles) {
            waveFiles.push({
              filePath: file,
              projectUseOptions: project.use as TaggedFile['projectUseOptions'],
              projectName: project.name,
            });
          }
        }
        if (waveFiles.length > 0) {
          waves.push(waveFiles);
        }
      }
    } else {
      // No projects — single wave with all files
      waves.push(testFiles.map((f) => ({ filePath: f })));
    }

    // Dispatch one wave at a time. Within a wave, work-stealing across workers.
    async function dispatchWave(waveFiles: TaggedFile[]): Promise<void> {
      const fileQueue = [...waveFiles];

      await new Promise<void>((resolve, reject) => {
        let hasError = false;
        let settled = false;

        function maybeResolve(): void {
          if (settled || hasError) return;
          if (fileQueue.length > 0) return;
          if (workers.every((w) => w.retired || !w.busy)) {
            settled = true;
            resolve();
          }
        }

        function failRun(error: Error): void {
          if (settled || hasError) return;
          hasError = true;
          settled = true;
          reject(error);
        }

        function dispatchNext(worker: WorkerHandle): void {
          if (worker.retired) return;

          const next = fileQueue.shift();
          if (!next) {
            worker.busy = false;
            worker.currentFile = undefined;
            maybeResolve();
            return;
          }

          worker.busy = true;
          worker.currentFile = next;
          reporter.onTestFileStart?.(next.filePath);

          const msg: MainToWorkerMessage = {
            type: 'run-file',
            filePath: next.filePath,
            projectUseOptions: next.projectUseOptions,
            projectName: next.projectName,
          };
          worker.process.send(msg);
        }

        function retireWorker(worker: WorkerHandle, reason: string): void {
          if (worker.retired) return;

          worker.retired = true;
          const inFlightFile = worker.currentFile;
          worker.currentFile = undefined;
          worker.busy = false;

          cleanupWorkerResources(worker);

          if (inFlightFile) {
            fileQueue.unshift(inFlightFile);
            process.stderr.write(
              `${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) became unavailable: ${reason}. Requeueing ${path.basename(inFlightFile.filePath)} and continuing with remaining workers.${RESET}\n`,
            );
          } else {
            process.stderr.write(
              `${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) became unavailable: ${reason}. Continuing with remaining workers.${RESET}\n`,
            );
          }

          const activeWorkers = workers.filter((w) => !w.retired);
          if (activeWorkers.length === 0) {
            failRun(
              new Error(
                `All workers became unavailable before the run completed. Last failure: ${reason}`,
              ),
            );
            return;
          }

          const idleWorker = activeWorkers.find((w) => !w.busy);
          if (idleWorker) {
            dispatchNext(idleWorker);
          }

          maybeResolve();
        }

        // Remove previous listeners and re-attach for this wave
        for (const worker of workers) {
          worker.process.removeAllListeners('message');
          worker.process.removeAllListeners('exit');

          worker.process.on('message', (msg: WorkerToMainMessage) => {
            if (hasError || worker.retired) return;

            switch (msg.type) {
              case 'test-end': {
                const result = deserializeTestResult(msg.result);
                reporter.onTestEnd?.(result);
                break;
              }
              case 'file-start':
                break;
              case 'file-done': {
                worker.currentFile = undefined;
                const results = msg.results.map(deserializeTestResult);
                const suite = deserializeSuiteResult(msg.suite);
                allResults.push(...results);
                allSuites.push(suite);

                reporter.onTestFileEnd?.(msg.filePath, results);

                dispatchNext(worker);
                break;
              }
              case 'error': {
                retireWorker(worker, msg.error.message);
                break;
              }
            }
          });

          worker.process.on('exit', (code) => {
            if (code !== 0 && !hasError && !worker.retired) {
              retireWorker(worker, `exited unexpectedly with code ${code}`);
            }
          });

          // Start dispatching to each worker
          dispatchNext(worker);
        }
      });
    }

    // Execute waves sequentially, with dependency-failure skipping
    if (opts.projectWaves && opts.projects) {
      for (const projectWave of opts.projectWaves) {
        const filteredWaveFiles: TaggedFile[] = [];
        for (const project of projectWave) {
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
          if (blockedBy) {
            process.stderr.write(
              `${DIM}Skipping project "${project.name}" — dependency "${blockedBy}" failed${RESET}\n`,
            );
            for (const file of project.testFiles) {
              const skippedResult: TestResult = {
                name: path.basename(file),
                fullName: path.basename(file),
                status: 'skipped',
                durationMs: 0,
                project: project.name,
              };
              allResults.push(skippedResult);
              reporter.onTestEnd?.(skippedResult);
            }
            failedProjects.add(project.name);
            continue;
          }
          for (const file of project.testFiles) {
            filteredWaveFiles.push({
              filePath: file,
              projectUseOptions: project.use as TaggedFile['projectUseOptions'],
              projectName: project.name,
            });
          }
        }
        if (filteredWaveFiles.length > 0) {
          const resultsBefore = allResults.length;
          await dispatchWave(filteredWaveFiles);

          // Track failures per-project (not per-wave) so only actual failed
          // projects block their dependents, not unrelated sibling projects.
          const waveResults = allResults.slice(resultsBefore);
          for (const project of projectWave) {
            if (failedProjects.has(project.name)) continue;
            const projectFailed = waveResults.some(
              (r) => r.status === 'failed' && r.project === project.name,
            );
            if (projectFailed) {
              failedProjects.add(project.name);
            }
          }
        }
      }
    } else {
      // No projects — single wave with all files
      await dispatchWave(waves[0] ?? []);
    }
  } finally {
    process.removeListener('SIGINT', emergencyCleanup);
    process.removeListener('SIGTERM', emergencyCleanup);

    // Cleanup order matters: workers first, then daemons, then ADB state, then emulators.
    // This ensures nothing is using the resources when we clean them up.

    // 1. Shut down workers gracefully, then force-kill
    const workerExitPromises: Promise<void>[] = [];
    for (const worker of workers) {
      try {
        if (worker.process?.connected) {
          const exitPromise = new Promise<void>((resolve) => {
            worker.process.once('exit', () => resolve());
            setTimeout(() => {
              try { worker.process.kill(); } catch { /* already dead */ }
              resolve();
            }, 3_000);
          });
          worker.process.send({ type: 'shutdown' } satisfies MainToWorkerMessage);
          workerExitPromises.push(exitPromise);
        }
      } catch { /* worker may already be dead */ }
    }
    await Promise.all(workerExitPromises);

    // 2. Kill daemons
    for (const worker of workers) {
      try {
        worker.daemonProcess?.kill();
      } catch { /* daemon may already be dead */ }
    }

    if (!firstDaemonAssigned) {
      try {
        firstDaemon.kill();
      } catch { /* daemon may already be dead */ }
    }

    if (isIos) {
      // 3. Preserve cloned simulators for reuse by the next run.
      // They stay booted and in the manifest. Only emergency cleanup deletes them.
      preserveSimulatorsForReuse(clonedSimulators);
    } else {
      // 3. Clean up ADB port forwards created by worker daemons.
      // Each daemon set up `adb forward tcp:<agentPort> tcp:18700` on its device.
      // Stale forwards break subsequent runs on the same device.
      for (const worker of workers) {
        try {
          execFileSync('adb', ['-s', worker.deviceSerial, 'forward', '--remove', `tcp:${worker.agentPort}`], {
            timeout: 5_000,
            stdio: 'ignore',
          });
        } catch { /* forward may already be gone */ }
      }

      // 4. Leave emulators running for reuse by the next run.
      // The PID manifest keeps them tracked. Only emergency cleanup kills them.
      preserveEmulatorsForReuse(launchedEmulators);
    }
  }

  const totalDuration = Date.now() - totalStart;
  const hasFailed = allResults.some((r) => r.status === 'failed');

  return {
    status: hasFailed ? 'failed' : 'passed',
    duration: totalDuration,
    setupDuration,
    tests: allResults,
    suites: allSuites,
  };
}

function cleanupWorkerResources(worker: WorkerHandle): void {
  try {
    if (worker.process.connected) {
      worker.process.kill();
    }
  } catch { /* already dead */ }

  try {
    worker.daemonProcess?.kill();
  } catch { /* already dead */ }

  try {
    execFileSync('adb', ['-s', worker.deviceSerial, 'forward', '--remove', `tcp:${worker.agentPort}`], {
      timeout: 5_000,
      stdio: 'ignore',
    });
  } catch { /* forward may already be gone */ }
}

interface InitializeWorkerOptions {
  workerId: number
  deviceSerial: string
  daemonBin: string
  serializedConfig: SerializedConfig
  baseDaemonPort: number
  baseAgentPort: number
  firstDaemon: ChildProcess
  resolvedScript: string
  initializationTimeoutMs: number
  freshEmulator: boolean
  tsxBin?: string
  /** Override the daemon port instead of computing baseDaemonPort + 1 + workerId. */
  daemonPortOverride?: number
  /** Override the agent port instead of computing baseAgentPort + 1 + workerId. */
  agentPortOverride?: number
}

async function initializeWorker(opts: InitializeWorkerOptions): Promise<WorkerHandle> {
  const {
    workerId,
    deviceSerial,
    daemonBin,
    serializedConfig,
    baseDaemonPort,
    baseAgentPort,
    firstDaemon,
    resolvedScript,
    initializationTimeoutMs,
    tsxBin,
  } = opts;

  const daemonPort = opts.daemonPortOverride ?? (baseDaemonPort + 1 + workerId);
  const agentPort = opts.agentPortOverride ?? (baseAgentPort + 1 + workerId);

  let daemonProcess: ChildProcess | undefined;
  if (workerId === 0) {
    daemonProcess = firstDaemon;
  } else {
    daemonProcess = spawn(
      daemonBin,
      ['--port', String(daemonPort), '--agent-port', String(agentPort)],
      { stdio: 'ignore' },
    );
    daemonProcess.unref();
    daemonProcess.on('error', (err) => {
      process.stderr.write(`Daemon for worker ${workerId} failed to start: ${err.message}\n`);
    });

    const client = new PilotGrpcClient(`localhost:${daemonPort}`);
    const ready = await client.waitForReady(10_000);
    client.close();
    if (!ready) {
      try { daemonProcess.kill(); } catch { /* already dead */ }
      const portInUse = !(await isPortAvailable(daemonPort));
      const hint = portInUse ? ` (port ${daemonPort} is already in use)` : '';
      throw new Error(`worker daemon on port ${daemonPort} did not become ready${hint}`);
    }
  }

  const child = fork(resolvedScript, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    ...(tsxBin ? { execPath: tsxBin } : {}),
    env: {
      ...process.env,
      PILOT_WORKER_ID: String(workerId),
    },
  });
  // Init + dispatch loop each add message/exit listeners; raise the cap to avoid warnings.
  child.setMaxListeners(20);

  const worker: WorkerHandle = {
    id: workerId,
    process: child,
    deviceSerial,
    daemonPort,
    agentPort,
    daemonProcess,
    busy: false,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `worker ${workerId} timed out during initialization after ${Math.round(initializationTimeoutMs / 1000)}s`,
          ),
        );
      }, initializationTimeoutMs);

      const onExit = (code: number | null) => {
        if (code !== 0) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`worker ${workerId} exited with code ${code} during initialization`));
        }
      };

      const onMessage = (msg: WorkerToMainMessage) => {
        if (msg.type === 'ready' && msg.workerId === worker.id) {
          clearTimeout(timeout);
          cleanup();
          resolve();
        } else if (msg.type === 'progress' && msg.workerId === worker.id) {
          process.stderr.write(
            `${DIM}  Worker ${worker.id} (${worker.deviceSerial}): ${msg.message}${RESET}\n`,
          );
        } else if (msg.type === 'error' && msg.workerId === worker.id) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(msg.error.message));
        }
      };

      const cleanup = () => {
        worker.process.removeListener('exit', onExit);
        worker.process.removeListener('message', onMessage);
      };

      worker.process.on('exit', onExit);
      worker.process.on('message', onMessage);

      // Send init after listeners are registered so no messages are lost.
      worker.process.send({
        type: 'init',
        workerId: worker.id,
        deviceSerial: worker.deviceSerial,
        daemonPort: worker.daemonPort,
        config: serializedConfig,
        freshEmulator: opts.freshEmulator === true ? true : undefined,
      } satisfies MainToWorkerMessage);
    });

    return worker;
  } catch (err) {
    try {
      if (worker.process.connected) {
        worker.process.kill();
      }
    } catch { /* already dead */ }

    if (workerId !== 0) {
      try { daemonProcess?.kill(); } catch { /* already dead */ }
    }

    try {
      execFileSync('adb', ['-s', deviceSerial, 'forward', '--remove', `tcp:${agentPort}`], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch { /* forward may not exist */ }

    throw err;
  }
}

/**
 * Check whether a TCP port is available for binding.
 * Returns true if the port is free, false if already in use.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function warnUnhealthyDevices(devices: DeviceHealthResult[]): void {
  for (const device of devices) {
    const avd = device.serial.startsWith('emulator-') ? getRunningAvdName(device.serial) : undefined;
    const label = avd ? `${device.serial} (${avd})` : device.serial;
    process.stderr.write(
      `${YELLOW}Skipping unhealthy device ${label}: ${device.reason ?? 'unknown health check failure'}.${RESET}\n`,
    );
  }
}

function warnSkippedDevices(devices: Array<{ serial: string; reason: string }>): void {
  for (const device of devices) {
    process.stderr.write(
      `${YELLOW}Skipping device ${device.serial}: ${device.reason}.${RESET}\n`,
    );
  }
}
