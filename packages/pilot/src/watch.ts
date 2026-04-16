/**
 * Watch mode coordinator.
 *
 * Watches test files for changes and re-runs them automatically. Keeps
 * the daemon, emulator, and agent alive across re-runs so only the app
 * reset + test execution cost is paid (~1-2s per run).
 *
 * Each re-run forks a child process (`watch-run.ts`) to get a fresh ESM
 * module cache, ensuring all file changes (tests, helpers, page objects)
 * are picked up.
 *
 * @see PILOT-120
 */

import { fork, spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { minimatch } from 'minimatch';
import type { PilotConfig } from './config.js';
import type { Device } from './device.js';
import { PilotGrpcClient } from './grpc-client.js';
import { createReporters, ReporterDispatcher, type FullResult, type PilotReporter } from './reporter.js';
import type { TestResult, SuiteResult } from './runner.js';
import type { ResolvedProject } from './project.js';
import {
  deserializeTestResult,
  deserializeSuiteResult,
  type SerializedConfig,
  type RunFileUseOptions,
} from './worker-protocol.js';
import type { WatchRunMessage, WatchRunChildMessage } from './watch-run.js';
import type {
  UIWorkerMessage,
  UIWorkerChildMessage,
} from './ui-mode/ui-protocol.js';
import { RunQueue, mapKeyToAction } from './watch-queue.js';
import { preserveEmulatorsForReuse, type LaunchedEmulator } from './emulator.js';

// ─── ANSI helpers ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// ─── Types ───

export interface WatchModeContext {
  config: PilotConfig
  device: Device
  client: PilotGrpcClient
  deviceSerial: string
  daemonAddress: string
  testFiles: string[]
  screenshotDir?: string
  launchedEmulators: LaunchedEmulator[]
  /** Resolved projects with test files populated. */
  projects?: ResolvedProject[]
  /** Dependency-ordered project waves from topologicalSort(). */
  projectWaves?: ResolvedProject[][]
  /** Number of parallel workers. When > 1, uses multi-worker mode. */
  workers?: number
  /** Device serials for multi-worker mode. */
  deviceSerials?: string[]
  /**
   * Per-bucket maps for multi-device-target projects. When set, each
   * device serial is paired with its bucket's serialized config and
   * worker dispatch routes files to workers in the matching bucket.
   */
  configByDevice?: Map<string, SerializedConfig>
  bucketByDevice?: Map<string, string>
  bucketByProject?: Map<string, string>
}

/**
 * Update `failedFiles` from the files that actually ran in a single watch-run
 * and the subset that failed. Exported for unit testing — used by
 * `executeWaveRunParallel` after all waves complete.
 *
 * Invariant: a file that was **not** in `ranFiles` is untouched. This matters
 * for two cases:
 *   (a) a file that got skipped because its project's dependency failed — its
 *       prior failed-state must persist until it actually re-runs;
 *   (b) a file that isn't part of the current subset at all (e.g. a single
 *       changed file re-run) — unrelated files' fail state is preserved.
 *
 * Cross-wave semantics: when the same file runs in multiple projects in the
 * same overall run (e.g. Android + iOS), a fail in either wave is sticky —
 * the call site passes the union of failed paths across all waves, so a pass
 * on one platform cannot clear a fail on another.
 */
export function reconcileFailedFiles(
  failedFiles: Set<string>,
  ranFiles: Iterable<string>,
  failedFilePaths: ReadonlySet<string>,
): void {
  for (const f of ranFiles) {
    if (failedFilePaths.has(f)) failedFiles.add(f);
    else failedFiles.delete(f);
  }
}

// ─── Watch mode coordinator ───

export async function runWatchMode(ctx: WatchModeContext): Promise<void> {
  const state = {
    knownFiles: new Set(ctx.testFiles),
    failedFiles: new Set<string>(),
    lastRunFiles: [] as string[],
    watcher: null as FSWatcher | null,
    activeChild: null as ChildProcess | null,
  };

  // Build file → projects lookup for re-runs. A file can belong to multiple
  // projects (e.g. Android + iOS sharing `**/*.test.ts`), so we collect all
  // matching projects per file.
  const fileToProjects = new Map<string, ResolvedProject[]>();
  if (ctx.projects) {
    for (const project of ctx.projects) {
      for (const file of project.testFiles) {
        const existing = fileToProjects.get(file);
        if (existing) existing.push(project);
        else fileToProjects.set(file, [project]);
      }
    }
  }


  const serializedConfig: SerializedConfig = {
    timeout: ctx.config.timeout,
    retries: ctx.config.retries,
    screenshot: ctx.config.screenshot,
    rootDir: ctx.config.rootDir,
    outputDir: ctx.config.outputDir,
    apk: ctx.config.apk,
    activity: ctx.config.activity,
    package: ctx.config.package,
    agentApk: ctx.config.agentApk,
    agentTestApk: ctx.config.agentTestApk,
    trace: typeof ctx.config.trace === 'string' || typeof ctx.config.trace === 'object'
      ? ctx.config.trace
      : undefined,
    platform: ctx.config.platform,
    app: ctx.config.app,
    iosXctestrun: ctx.config.iosXctestrun,
    simulator: ctx.config.simulator,
    baseURL: ctx.config.baseURL,
    extraHTTPHeaders: ctx.config.extraHTTPHeaders,
  };

  // Resolve tsx binary for forking TypeScript files
  const jsScript = path.resolve(__dirname, 'watch-run.js');
  const tsScript = path.resolve(__dirname, 'watch-run.ts');
  const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript);
  const resolvedScript = useTypeScript ? tsScript : jsScript;

  const jsWorkerScript = path.resolve(__dirname, 'ui-mode', 'ui-worker.js');
  const tsWorkerScript = path.resolve(__dirname, 'ui-mode', 'ui-worker.ts');
  const resolvedWorkerScript = !fs.existsSync(jsWorkerScript) && fs.existsSync(tsWorkerScript)
    ? tsWorkerScript
    : jsWorkerScript;

  let tsxBin: string | undefined;
  if (useTypeScript || resolvedWorkerScript.endsWith('.ts')) {
    const pilotPkgDir = path.resolve(__dirname, '..');
    const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx');
    tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';
  }

  // ─── Multi-worker state ───

  interface WatchWorkerHandle {
    id: number
    process: ChildProcess
    deviceSerial: string
    daemonPort: number
    agentPort: number
    daemonProcess?: ChildProcess
    busy: boolean
    retired?: boolean
    bucketSignature?: string
  }

  const multiWorker = (ctx.workers ?? 1) > 1 && (ctx.deviceSerials?.length ?? 0) > 1;
  const watchWorkers: WatchWorkerHandle[] = [];
  let workersReady = false;

  async function initializeWatchWorkers(): Promise<void> {
    if (!ctx.deviceSerials || ctx.deviceSerials.length === 0) return;

    const baseDaemonPort = Number.parseInt(ctx.daemonAddress.split(':').pop() ?? '50051', 10);
    const baseAgentPort = 18700;
    const rawBin = process.env.PILOT_DAEMON_BIN ?? ctx.config.daemonBin ?? 'pilot-core';
    const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
      ? path.resolve(ctx.config.rootDir, rawBin)
      : rawBin;

    const numWorkers = Math.min(ctx.workers ?? 2, ctx.deviceSerials.length);
    process.stderr.write(`${DIM}Initializing ${numWorkers} watch worker(s)...${RESET}\n`);

    // Kill stale daemons from a previous watch session that may still be
    // listening on the worker ports. Without this, waitForReady connects to
    // the old daemon instead of the freshly spawned one, which means daemon
    // binary updates (e.g. bug fixes) don't take effect until the user
    // manually kills the old processes.
    const daemonPorts = Array.from({ length: numWorkers }, (_, i) => baseDaemonPort + 100 + i);
    for (const port of daemonPorts) {
      try {
        const { execFileSync } = await import('node:child_process');
        const out = execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf-8' }).trim();
        for (const pid of out.split('\n').filter(Boolean)) {
          try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
        }
        if (out) await new Promise((r) => setTimeout(r, 500));
      } catch { /* no listener — nothing to kill */ }
    }

    for (let i = 0; i < numWorkers; i++) {
      const deviceSerial = ctx.deviceSerials[i];
      const daemonPort = baseDaemonPort + 100 + i;
      const agentPort = baseAgentPort + 100 + i;
      try {
        const worker = await initOneWatchWorker(i, deviceSerial, daemonPort, agentPort, daemonBin);
        watchWorkers.push(worker);
      } catch (err) {
        process.stderr.write(
          `${YELLOW}Skipping device ${deviceSerial}: ${err instanceof Error ? err.message : err}.${RESET}\n`,
        );
      }
    }

    if (watchWorkers.length > 1) {
      workersReady = true;
      process.stderr.write(`${DIM}${watchWorkers.length} watch worker(s) ready.${RESET}\n`);
    } else if (watchWorkers.length === 1) {
      // One worker isn't useful for parallelism — clean it up and fall back
      process.stderr.write(`${YELLOW}Only 1 worker initialized. Using single-worker mode.${RESET}\n`);
      cleanupWatchWorkers();
    }
  }

  async function initOneWatchWorker(
    id: number,
    deviceSerial: string,
    daemonPort: number,
    agentPort: number,
    daemonBin: string,
  ): Promise<WatchWorkerHandle> {
    const workerConfig = ctx.configByDevice?.get(deviceSerial) ?? serializedConfig;
    const workerBucketSig = ctx.bucketByDevice?.get(deviceSerial);
    const daemonProcess = spawn(
      daemonBin,
      ['--port', String(daemonPort), '--agent-port', String(agentPort),
        ...(workerConfig.platform ? ['--platform', workerConfig.platform] : [])],
      { stdio: 'ignore' },
    );
    daemonProcess.on('error', () => { /* handled by waitForReady */ });

    const daemonClient = new PilotGrpcClient(`localhost:${daemonPort}`);
    const ready = await daemonClient.waitForReady(10_000);
    daemonClient.close();
    if (!ready) {
      try { daemonProcess.kill(); } catch { /* already dead */ }
      throw new Error(`daemon on port ${daemonPort} did not become ready`);
    }
    // Only detach after confirmed ready so kill() works during init failure
    daemonProcess.unref();

    const child = fork(resolvedWorkerScript, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      ...(tsxBin ? { execPath: tsxBin } : {}),
      env: { ...process.env, NODE_PATH: path.resolve(__dirname, '..'), PILOT_WORKER_ID: String(id) },
    });
    child.setMaxListeners(20);

    const worker: WatchWorkerHandle = {
      id, process: child, deviceSerial, daemonPort, agentPort, daemonProcess, busy: false,
      bucketSignature: workerBucketSig,
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`worker ${id} init timed out`)), 90_000);

      const onMessage = (msg: UIWorkerChildMessage) => {
        if (msg.type === 'ready' && msg.workerId === id) {
          clearTimeout(timeout);
          child.removeListener('message', onMessage);
          child.removeListener('exit', onExit);
          resolve();
        } else if (msg.type === 'progress' && msg.workerId === id) {
          process.stderr.write(`${DIM}  Worker ${id} (${deviceSerial}): ${msg.message}${RESET}\n`);
        } else if (msg.type === 'error' && msg.workerId === id) {
          clearTimeout(timeout);
          child.removeListener('message', onMessage);
          child.removeListener('exit', onExit);
          reject(new Error(msg.error.message));
        }
      };
      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        child.removeListener('message', onMessage);
        reject(new Error(`worker ${id} exited with code ${code} during init`));
      };

      child.on('message', onMessage);
      child.on('exit', onExit);

      child.send({
        type: 'init',
        workerId: id,
        deviceSerial,
        daemonPort,
        config: workerConfig,
        screenshotDir: ctx.screenshotDir,
      } satisfies UIWorkerMessage);
    });

    return worker;
  }

  interface TaggedFile {
    filePath: string
    projectUseOptions?: RunFileUseOptions
    projectName?: string
  }

  /**
   * Dispatch files across persistent workers using work-stealing.
   * Each worker reports results back via IPC.
   */
  async function dispatchParallel(
    files: TaggedFile[],
    reporter: PilotReporter,
  ): Promise<{ results: TestResult[]; suites: SuiteResult[]; failedFilePaths: Set<string> }> {
    const fileQueue = [...files];
    const allResults: TestResult[] = [];
    const allSuites: SuiteResult[] = [];
    const failedFilePaths = new Set<string>();
    const activeWorkers = watchWorkers.filter((w) => !w.retired);

    // Track per-dispatch listeners so we can remove them without
    // clobbering unrelated listeners from other dispatch rounds.
    const cleanups: Array<() => void> = [];

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        function settle(): void {
          if (settled) return;
          settled = true;
          resolve();
        }

        function maybeResolve(): void {
          if (settled) return;
          if (fileQueue.length > 0) return;
          if (activeWorkers.every((w) => w.retired || !w.busy)) settle();
        }

        function dispatchNext(worker: WatchWorkerHandle): void {
          if (worker.retired) return;
          // Multi-bucket: only take a file whose project's bucket matches this worker.
          let next: TaggedFile | undefined;
          if (worker.bucketSignature && ctx.bucketByProject) {
            const matchIdx = fileQueue.findIndex((f) => {
              if (!f.projectName) return true;
              const sig = ctx.bucketByProject!.get(f.projectName);
              return !sig || sig === worker.bucketSignature;
            });
            if (matchIdx >= 0) {
              next = fileQueue.splice(matchIdx, 1)[0];
            }
          } else {
            next = fileQueue.shift();
          }
          if (!next) {
            worker.busy = false;
            maybeResolve();
            return;
          }
          worker.busy = true;
          reporter.onTestFileStart?.(next.filePath);
          worker.process.send({
            type: 'run-file',
            filePath: next.filePath,
            projectUseOptions: next.projectUseOptions,
            projectName: next.projectName,
          } satisfies UIWorkerMessage);
        }

        function retireWorker(worker: WatchWorkerHandle, reason: string): void {
          if (worker.retired) return;
          worker.retired = true;
          worker.busy = false;
          process.stderr.write(`${YELLOW}Worker ${worker.id} (${worker.deviceSerial}): ${reason}${RESET}\n`);

          const remaining = activeWorkers.filter((w) => !w.retired);
          if (remaining.length === 0) {
            settled = true;
            reject(new Error(`All workers became unavailable. Last: ${reason}`));
            return;
          }
          const idle = remaining.find((w) => !w.busy);
          if (idle) dispatchNext(idle);
          maybeResolve();
        }

        for (const worker of activeWorkers) {
          const onMessage = (msg: UIWorkerChildMessage) => {
            if (settled || worker.retired) return;

            switch (msg.type) {
              case 'test-end': {
                const result = deserializeTestResult(msg.result);
                reporter.onTestEnd?.(result);
                break;
              }
              case 'file-done': {
                const results = msg.results.map(deserializeTestResult);
                const suite = deserializeSuiteResult(msg.suite);
                allResults.push(...results);
                allSuites.push(suite);
                if (results.some((r) => r.status === 'failed')) {
                  failedFilePaths.add(msg.filePath);
                }
                reporter.onTestFileEnd?.(msg.filePath, results);
                dispatchNext(worker);
                break;
              }
              case 'error':
                retireWorker(worker, msg.error.message);
                break;
            }
          };

          const onExit = (code: number | null) => {
            if (!settled && !worker.retired) {
              retireWorker(worker, `exited with code ${code}`);
            } else if (!settled) {
              maybeResolve();
            }
          };

          worker.process.on('message', onMessage);
          worker.process.on('exit', onExit);
          cleanups.push(
            () => worker.process.removeListener('message', onMessage),
            () => worker.process.removeListener('exit', onExit),
          );

          dispatchNext(worker);
        }
      });
    } finally {
      // Remove dispatch-scoped listeners to prevent stale handlers from
      // dropping messages if a new dispatch starts while one is winding down.
      for (const fn of cleanups) fn();
    }

    return { results: allResults, suites: allSuites, failedFilePaths };
  }

  function cleanupWatchWorkers(): void {
    for (const worker of watchWorkers) {
      try {
        if (worker.process.connected) {
          worker.process.send({ type: 'shutdown' } satisfies UIWorkerMessage);
          setTimeout(() => { try { worker.process.kill(); } catch { /* dead */ } }, 3_000);
        }
      } catch { /* dead */ }
      try { worker.daemonProcess?.kill(); } catch { /* dead */ }
    }
    watchWorkers.length = 0;
    workersReady = false;
  }

  const useParallel = () => multiWorker && workersReady && watchWorkers.length > 1;

  // ─── Run queue ───

  const queue = new RunQueue(300, (request) => {
    const run = request.type === 'all'
      ? executeWaveRun()
      : executeFileRun(request.files);
    run.catch((err) => {
      process.stderr.write(`${RED}Watch run error: ${err instanceof Error ? err.message : err}${RESET}\n`);
      queue.notifyRunFinished();
    });
  });

  // ─── Run execution ───

  /** Run files respecting project wave ordering (used for initial run and run-all). */
  async function executeWaveRun(): Promise<void> {
    queue.notifyRunStarted();
    state.lastRunFiles = [...state.knownFiles];

    process.stdout.write('\x1b[H\x1b[2J\x1b[3J'); // clear screen + scroll-back, cursor to top

    const runStart = Date.now();
    const allResults: TestResult[] = [];
    const allSuites: SuiteResult[] = [];

    const reporters = await createReporters(ctx.config.reporter);
    const reporter = new ReporterDispatcher(reporters);

    const totalFiles = [...state.knownFiles].length;
    // Pass the actual worker count to the reporter so it shows worker/project
    // tags and suppresses file headers when running in parallel.
    const reporterConfig = useParallel()
      ? { ...ctx.config, workers: watchWorkers.length }
      : ctx.config;
    reporter.onRunStart(reporterConfig, totalFiles);

    if (useParallel()) {
      // Parallel wave-based execution across workers
      await executeWaveRunParallel(reporter, allResults, allSuites);
    } else if (ctx.projectWaves && ctx.projects) {
      // Sequential wave-based execution respecting project dependencies
      const failedProjects = new Set<string>();

      for (const wave of ctx.projectWaves) {
        for (const project of wave) {
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
          if (blockedBy) {
            process.stdout.write(`${DIM}Skipping project "${project.name}" — dependency "${blockedBy}" failed${RESET}\n`);
            for (const file of project.testFiles) {
              const { result, suite } = makeSkippedResult(file, project.name);
              allResults.push(result);
              allSuites.push(suite);
              reporter.onTestEnd?.(result);
            }
            failedProjects.add(project.name);
            continue;
          }

          let projectFailed = false;

          for (const file of project.testFiles) {
            reporter.onTestFileStart?.(file);

            try {
              const { results, suite } = await runFileInChild(
                file,
                reporter,
                project.use as RunFileUseOptions | undefined,
                project.name !== 'default' ? project.name : undefined,
              );
              allResults.push(...results);
              allSuites.push(suite);
              reporter.onTestFileEnd?.(file, results);

              if (results.some((r) => r.status === 'failed')) {
                state.failedFiles.add(file);
                projectFailed = true;
              } else {
                state.failedFiles.delete(file);
              }
            } catch (err) {
              const { result, suite } = makeErrorResult(file, err, project.name);
              allResults.push(result);
              allSuites.push(suite);
              reporter.onTestEnd?.(result);
              reporter.onTestFileEnd?.(file, [result]);
              state.failedFiles.add(file);
              projectFailed = true;
            }
          }

          if (projectFailed) {
            failedProjects.add(project.name);
          }
        }
      }
    } else {
      // No projects — run files sequentially
      for (const file of state.knownFiles) {
        reporter.onTestFileStart?.(file);

        try {
          const { results, suite } = await runFileInChild(file, reporter);
          allResults.push(...results);
          allSuites.push(suite);
          reporter.onTestFileEnd?.(file, results);

          if (results.some((r) => r.status === 'failed')) {
            state.failedFiles.add(file);
          } else {
            state.failedFiles.delete(file);
          }
        } catch (err) {
          const { result, suite } = makeErrorResult(file, err);
          allResults.push(result);
          allSuites.push(suite);
          reporter.onTestEnd?.(result);
          reporter.onTestFileEnd?.(file, [result]);
          state.failedFiles.add(file);
        }
      }
    }

    await finishRun(reporter, allResults, allSuites, runStart);
  }

  /** Parallel wave execution helper — dispatches each wave across workers. */
  async function executeWaveRunParallel(
    reporter: ReporterDispatcher,
    allResults: TestResult[],
    allSuites: SuiteResult[],
  ): Promise<void> {
    if (ctx.projectWaves && ctx.projects) {
      const failedProjects = new Set<string>();
      // Files that ran (across all waves) and files that failed (across all
      // waves). Used to reconcile state.failedFiles once at the end so a
      // pass in wave A cannot clobber a fail in wave B.
      const filesRanThisRun = new Set<string>();
      const filesFailedThisRun = new Set<string>();

      for (const wave of ctx.projectWaves) {
        const waveFiles: TaggedFile[] = [];
        for (const project of wave) {
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
          if (blockedBy) {
            process.stdout.write(`${DIM}Skipping project "${project.name}" — dependency "${blockedBy}" failed${RESET}\n`);
            for (const file of project.testFiles) {
              const { result, suite } = makeSkippedResult(file, project.name);
              allResults.push(result);
              allSuites.push(suite);
              reporter.onTestEnd?.(result);
            }
            failedProjects.add(project.name);
            // Intentionally not adding these files to `filesRanThisRun`: they
            // were skipped because their dependency failed, not because they
            // passed. We must not reconcile their `state.failedFiles` entry.
            // A file that was already marked failed stays marked failed until
            // it actually re-runs and we have fresh signal on it.
            continue;
          }
          for (const file of project.testFiles) {
            waveFiles.push({
              filePath: file,
              projectUseOptions: project.use as RunFileUseOptions | undefined,
              projectName: project.name !== 'default' ? project.name : undefined,
            });
          }
        }

        if (waveFiles.length > 0) {
          const { results, suites, failedFilePaths } = await dispatchParallel(waveFiles, reporter);
          allResults.push(...results);
          allSuites.push(...suites);
          for (const entry of waveFiles) filesRanThisRun.add(entry.filePath);
          for (const f of failedFilePaths) filesFailedThisRun.add(f);
          // Track project-level failures
          for (const project of wave) {
            if (failedProjects.has(project.name)) continue;
            if (results.some((r) => r.status === 'failed' && r.project === project.name)) {
              failedProjects.add(project.name);
            }
          }
        }
      }

      reconcileFailedFiles(state.failedFiles, filesRanThisRun, filesFailedThisRun);
    } else {
      // No projects — dispatch all files at once
      const files: TaggedFile[] = [...state.knownFiles].map((f) => ({ filePath: f }));
      const { results, suites, failedFilePaths } = await dispatchParallel(files, reporter);
      allResults.push(...results);
      allSuites.push(...suites);
      for (const f of state.knownFiles) {
        if (failedFilePaths.has(f)) state.failedFiles.add(f);
        else state.failedFiles.delete(f);
      }
    }
  }

  /** Run specific files (used for file-change re-runs and run-failed). */
  async function executeFileRun(files: string[]): Promise<void> {
    if (files.length === 0) return;
    queue.notifyRunStarted();
    state.lastRunFiles = files;

    process.stdout.write('\x1b[H\x1b[2J\x1b[3J'); // clear screen + scroll-back, cursor to top

    const runStart = Date.now();
    const allResults: TestResult[] = [];
    const allSuites: SuiteResult[] = [];

    const reporters = await createReporters(ctx.config.reporter);
    const reporter = new ReporterDispatcher(reporters);

    // Expand each file into one TaggedFile per matching project. A single
    // changed file may belong to both Android and iOS projects and needs to
    // re-run on both devices.
    const tagged: TaggedFile[] = [];
    for (const f of files) {
      const projects = fileToProjects.get(f);
      if (projects && projects.length > 0) {
        for (const project of projects) {
          tagged.push({
            filePath: f,
            projectUseOptions: project.use as RunFileUseOptions | undefined,
            projectName: project.name !== 'default' ? project.name : undefined,
          });
        }
      } else {
        tagged.push({ filePath: f });
      }
    }

    const reporterConfig = useParallel()
      ? { ...ctx.config, workers: watchWorkers.length }
      : ctx.config;
    reporter.onRunStart(reporterConfig, files.length);

    if (useParallel() && tagged.length > 1) {
      // Dispatch across persistent workers (parallel)
      const { results, suites, failedFilePaths } = await dispatchParallel(tagged, reporter);
      allResults.push(...results);
      allSuites.push(...suites);
      for (const f of files) {
        if (failedFilePaths.has(f)) state.failedFiles.add(f);
        else state.failedFiles.delete(f);
      }
    } else {
      // Single entry or single-worker — sequential
      for (const entry of tagged) {
        reporter.onTestFileStart?.(entry.filePath);

        try {
          const { results, suite } = await runFileInChild(entry.filePath, reporter, entry.projectUseOptions, entry.projectName);
          allResults.push(...results);
          allSuites.push(suite);
          reporter.onTestFileEnd?.(entry.filePath, results);

          if (results.some((r) => r.status === 'failed')) {
            state.failedFiles.add(entry.filePath);
          } else {
            state.failedFiles.delete(entry.filePath);
          }
        } catch (err) {
          const { result, suite } = makeErrorResult(entry.filePath, err, entry.projectName);
          allResults.push(result);
          allSuites.push(suite);
          reporter.onTestEnd?.(result);
          reporter.onTestFileEnd?.(entry.filePath, [result]);
          state.failedFiles.add(entry.filePath);
        }
      }
    }

    await finishRun(reporter, allResults, allSuites, runStart);
  }

  async function finishRun(
    reporter: ReporterDispatcher,
    allResults: TestResult[],
    allSuites: SuiteResult[],
    runStart: number,
  ): Promise<void> {
    const totalDuration = Date.now() - runStart;
    const fullResult: FullResult = {
      status: allResults.some((r) => r.status === 'failed') ? 'failed' : 'passed',
      duration: totalDuration,
      tests: allResults,
      suites: allSuites,
    };

    await reporter.onRunEnd(fullResult);
    printStatusLine(allResults, totalDuration);

    queue.notifyRunFinished();
  }

  function makeErrorResult(file: string, err: unknown, projectName?: string): { result: TestResult; suite: SuiteResult } {
    const testResult: TestResult = {
      name: path.basename(file),
      fullName: path.basename(file),
      status: 'failed',
      durationMs: 0,
      error: err instanceof Error ? err : new Error(String(err)),
      project: projectName,
    };
    return {
      result: testResult,
      suite: { name: path.basename(file), tests: [testResult], suites: [], durationMs: 0 },
    };
  }

  function makeSkippedResult(file: string, projectName: string): { result: TestResult; suite: SuiteResult } {
    const testResult: TestResult = {
      name: path.basename(file),
      fullName: path.basename(file),
      status: 'skipped',
      durationMs: 0,
      project: projectName,
    };
    return {
      result: testResult,
      suite: { name: path.basename(file), tests: [testResult], suites: [], durationMs: 0 },
    };
  }

  function runFileInChild(
    filePath: string,
    reporter: PilotReporter,
    projectUseOptions?: RunFileUseOptions,
    projectName?: string,
  ): Promise<{ results: TestResult[]; suite: SuiteResult }> {
    return new Promise((resolve, reject) => {
      const child = fork(resolvedScript, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        ...(tsxBin ? { execPath: tsxBin } : {}),
        env: {
          ...process.env,
          NODE_PATH: path.resolve(__dirname, '..', '..'),
        },
      });

      state.activeChild = child;
      let settled = false;

      const msg: WatchRunMessage = {
        type: 'run',
        daemonAddress: ctx.daemonAddress,
        deviceSerial: ctx.deviceSerial,
        filePath,
        config: serializedConfig,
        screenshotDir: ctx.screenshotDir,
        projectUseOptions,
        projectName,
      };

      child.on('message', (response: WatchRunChildMessage) => {
        if (settled) return;

        switch (response.type) {
          case 'test-end': {
            // Forward to reporter for live output
            const result = deserializeTestResult(response.result);
            reporter.onTestEnd?.(result);
            break;
          }
          case 'file-done': {
            settled = true;
            const results = response.results.map(deserializeTestResult);
            const suite = deserializeSuiteResult(response.suite);
            resolve({ results, suite });
            break;
          }
          case 'error':
            settled = true;
            reject(new Error(response.error.message));
            break;
        }
      });

      child.on('exit', (code) => {
        state.activeChild = null;
        if (!settled) {
          settled = true;
          reject(new Error(`Watch worker exited with code ${code ?? 0} without sending results`));
        }
      });

      child.on('error', (err) => {
        state.activeChild = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.send(msg);
    });
  }

  // ─── File watching ───
  // Chokidar v4 does not support glob patterns (it has no picomatch/glob
  // dependency). We watch:
  //   1. The discovered test files directly (for change/unlink)
  //   2. The directories containing test files (for new file detection)
  //   3. The config file (for change notification)

  /** Check if a file path matches any of the configured test patterns. */
  function matchesTestPatterns(filePath: string): boolean {
    const relative = filePath.startsWith(ctx.config.rootDir)
      ? filePath.slice(ctx.config.rootDir.length).replace(/^\//, '')
      : filePath;
    const patterns = ctx.projects
      ? ctx.projects.flatMap((p) => p.testMatch)
      : ctx.config.testMatch;
    return patterns.some((pattern) => minimatch(relative, pattern));
  }

  function startWatcher(): FSWatcher {
    const filesToWatch: string[] = [...state.knownFiles];

    // Watch directories that contain test files so we detect new files
    const testDirs = new Set<string>();
    for (const file of state.knownFiles) {
      testDirs.add(path.dirname(file));
    }
    filesToWatch.push(...testDirs);

    // Also watch the config file for change notification
    const configCandidates = ['pilot.config.ts', 'pilot.config.js', 'pilot.config.mjs'];
    const configPath = configCandidates
      .map((name) => path.resolve(ctx.config.rootDir, name))
      .find((p) => fs.existsSync(p));
    if (configPath) {
      filesToWatch.push(configPath);
    }

    const watcher = chokidarWatch(filesToWatch, { ignoreInitial: true });

    watcher.on('change', (filePath) => {
      if (configPath && filePath === configPath) {
        process.stdout.write(
          `\n${YELLOW}Config file changed. Restart watch mode to pick up changes.${RESET}\n`,
        );
        printStatusLine();
        return;
      }
      if (state.knownFiles.has(filePath)) {
        queue.scheduleFiles([filePath]);
      }
    });

    watcher.on('add', (filePath) => {
      if (!state.knownFiles.has(filePath) && matchesTestPatterns(filePath)) {
        state.knownFiles.add(filePath);
        // Also start watching the new file itself for changes
        watcher.add(filePath);
        queue.scheduleFiles([filePath]);
      }
    });

    watcher.on('unlink', (filePath) => {
      state.knownFiles.delete(filePath);
      state.failedFiles.delete(filePath);
    });

    return watcher;
  }

  // ─── Keyboard input ───

  function setupKeyboardInput(): void {
    if (!process.stdin.isTTY) return;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      const action = mapKeyToAction(key);
      if (!action) return;

      switch (action) {
        case 'run-all':
          queue.scheduleAll();
          break;
        case 'run-failed': {
          const failedList = [...state.failedFiles].filter((f) => state.knownFiles.has(f));
          if (failedList.length === 0) {
            process.stdout.write(`${DIM}No failed tests to re-run.${RESET}\n`);
          } else {
            queue.scheduleImmediate(failedList);
          }
          break;
        }
        case 'rerun': {
          const validFiles = state.lastRunFiles.filter((f) => state.knownFiles.has(f));
          if (validFiles.length > 0) {
            queue.scheduleImmediate(validFiles);
          }
          break;
        }
        case 'quit':
          cleanup();
          break;
      }
    });
  }

  // ─── Status line ───

  function printStatusLine(results?: TestResult[], durationMs?: number): void {
    process.stdout.write('\n');

    if (results && durationMs !== undefined) {
      const passed = results.filter((r) => r.status === 'passed').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      const duration = (durationMs / 1000).toFixed(1);
      const parts: string[] = [];
      if (passed > 0) parts.push(`${GREEN}${passed} passed${RESET}`);
      if (failed > 0) parts.push(`${RED}${failed} failed${RESET}`);
      if (skipped > 0) parts.push(`${DIM}${skipped} skipped${RESET}`);
      process.stdout.write(`  ${parts.join(', ')} ${DIM}(${duration}s)${RESET}\n\n`);
    }

    process.stdout.write(`${BOLD}Watch Usage${RESET}\n`);
    process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}a${RESET}${DIM} to run all tests${RESET}\n`);
    process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}f${RESET}${DIM} to run only failed tests${RESET}\n`);
    if (state.lastRunFiles.length > 0) {
      const fileNames = state.lastRunFiles.map((f) => path.basename(f)).join(', ');
      process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}Enter${RESET}${DIM} to re-run ${fileNames}${RESET}\n`);
    }
    process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}q${RESET}${DIM} to quit${RESET}\n`);
  }

  // ─── Cleanup ───

  function cleanup(): void {
    if (state.activeChild) {
      try { state.activeChild.kill(); } catch { /* already dead */ }
    }

    cleanupWatchWorkers();

    if (state.watcher) {
      state.watcher.close();
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    ctx.device.close();
    ctx.client.close();

    preserveEmulatorsForReuse(ctx.launchedEmulators);

    process.exit(0);
  }

  // ─── Start watch mode ───

  // Initialize parallel workers if multiple devices available
  if (multiWorker) {
    await initializeWatchWorkers();
  }

  const workerLabel = useParallel()
    ? `${watchWorkers.length} worker(s) across ${watchWorkers.map((w) => w.deviceSerial).join(', ')}`
    : `Using device: ${ctx.deviceSerial}`;

  process.stdout.write(`${BOLD}Watch mode started.${RESET} Watching ${state.knownFiles.size} test file(s).\n`);
  process.stdout.write(`${DIM}${workerLabel}${RESET}\n\n`);

  state.watcher = startWatcher();

  setupKeyboardInput();

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Don't run tests on startup — wait for a file change or keypress.
  printStatusLine();

  // Keep alive forever — cleaned up via `cleanup()` on quit/signal.
  await new Promise<void>(() => { /* never resolves */ });
}
