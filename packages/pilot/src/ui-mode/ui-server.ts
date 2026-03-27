/**
 * UI mode server.
 *
 * HTTP server that serves the bundled Preact SPA and upgrades to WebSocket
 * for real-time communication. Manages test discovery, execution (via forked
 * child processes), device screen polling, and watch mode.
 *
 * Supports both single-worker (existing: forks ui-run.ts per file) and
 * multi-worker (new: persistent ui-worker.ts processes with work-stealing)
 * execution modes.
 *
 * @see PILOT-87
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PilotConfig } from '../config.js';
import { PilotGrpcClient } from '../grpc-client.js';
import type { Device } from '../device.js';
import type { ResolvedProject } from '../project.js';
import { collectTransitiveDeps } from '../project.js';
import type { LaunchedEmulator } from '../emulator.js';
import { preserveEmulatorsForReuse } from '../emulator.js';
import {
  deserializeTestResult,
  deserializeSuiteResult,
  type SerializedConfig,
  type RunFileUseOptions,
} from '../worker-protocol.js';
import type {
  ServerMessage,
  ClientMessage,
  TestTreeNode,
  UIRunMessage,
  UIRunChildMessage,
  UIDiscoverMessage,
  UIDiscoverChildMessage,
  UIWorkerChildMessage,
  UIWorkerMessage,
} from './ui-protocol.js';
import { encodeScreenFrame } from './ui-protocol.js';
import { RunQueue } from '../watch-queue.js';

// ─── SPA paths ───

const SPA_HTML_PATH = path.resolve(__dirname, 'index.html');

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// ─── Types ───

export interface UIServerContext {
  config: PilotConfig
  /** Single-worker mode device/client (required when workers <= 1). */
  device?: Device
  client?: PilotGrpcClient
  deviceSerial?: string
  daemonAddress?: string
  testFiles: string[]
  screenshotDir?: string
  launchedEmulators: LaunchedEmulator[]
  projects?: ResolvedProject[]
  /** Dependency-ordered project waves from topologicalSort(). */
  projectWaves?: ResolvedProject[][]
  /** Number of parallel workers. When > 1, uses multi-worker mode. */
  workers?: number
  /** Device serials for multi-worker mode. */
  deviceSerials?: string[]
}

export interface UIServerOptions {
  port?: number
}

interface TaggedFile {
  filePath: string
  projectUseOptions?: RunFileUseOptions
  projectName?: string
  testFilter?: string
}

interface UIWorkerHandle {
  id: number
  process: ChildProcess
  deviceSerial: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
  /** gRPC client for screen polling from this worker's daemon. */
  screenClient?: PilotGrpcClient
  busy: boolean
  currentFile?: TaggedFile
  currentTest?: string
  retired?: boolean
  passed: number
  failed: number
  skipped: number
}

// ─── UI Server ───

export async function startUIServer(
  ctx: UIServerContext,
  options: UIServerOptions = {},
): Promise<{ port: number; close: () => void }> {
  const clients = new Set<WebSocket>();
  let testTree: TestTreeNode[] = [];
  let isRunning = false;
  const failedFiles = new Set<string>();
  let activeChild: ChildProcess | null = null;
  let screenPollTimer: ReturnType<typeof setTimeout> | null = null;
  let screenSeq = 0;
  let screenPollActive = false;
  let watcher: FSWatcher | null = null;
  const watchedFiles = new Set<string>();

  // ─── Multi-worker state ───
  const multiWorker = (ctx.workers ?? 1) > 1 && (ctx.deviceSerials?.length ?? 0) > 1;
  const uiWorkers: UIWorkerHandle[] = [];
  let workersInitialized = false;
  /** Which worker's device to mirror. Defaults to 0. */
  let selectedWorkerId = 0;
  /** Screen view mode: 'all' polls all workers, number polls a specific worker. */
  let screenViewMode: 'all' | number = 'all';
  /** Set to true while a parallel run is in progress, to signal stop. */
  let parallelRunAborted = false;

  // Detect whether meaningful projects are configured (not just a synthetic 'default')
  const hasRealProjects = ctx.projects != null
    && ctx.projects.length > 0
    && !(ctx.projects.length === 1 && ctx.projects[0].name === 'default');

  // Build file → project lookup
  const fileToProject = new Map<string, ResolvedProject>();
  if (ctx.projects) {
    for (const project of ctx.projects) {
      for (const file of project.testFiles) {
        fileToProject.set(file, project);
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
      : 'on',
    platform: ctx.config.platform,
    app: ctx.config.app,
    iosXctestrun: ctx.config.iosXctestrun,
    simulator: ctx.config.simulator,
  };

  // Resolve tsx binary for forking TypeScript files
  const jsScript = path.resolve(__dirname, 'ui-run.js');
  const tsScript = path.resolve(__dirname, 'ui-run.ts');
  const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript);
  const resolvedRunScript = useTypeScript ? tsScript : jsScript;

  const jsWorkerScript = path.resolve(__dirname, 'ui-worker.js');
  const tsWorkerScript = path.resolve(__dirname, 'ui-worker.ts');
  const resolvedWorkerScript = !fs.existsSync(jsWorkerScript) && fs.existsSync(tsWorkerScript)
    ? tsWorkerScript
    : jsWorkerScript;

  const jsDiscoverScript = path.resolve(__dirname, 'ui-discover.js');
  const tsDiscoverScript = path.resolve(__dirname, 'ui-discover.ts');
  const resolvedDiscoverScript = !fs.existsSync(jsDiscoverScript) && fs.existsSync(tsDiscoverScript)
    ? tsDiscoverScript
    : jsDiscoverScript;

  let tsxBin: string | undefined;
  if (useTypeScript || resolvedDiscoverScript.endsWith('.ts') || resolvedWorkerScript.endsWith('.ts')) {
    const pilotPkgDir = path.resolve(__dirname, '..');
    const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx');
    tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';
  }

  // ─── Broadcast ───

  function broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Catch handler that broadcasts the error to connected clients. */
  function broadcastError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    broadcast({ type: 'error', message });
  }

  function broadcastBinary(data: Buffer): void {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  // ─── Test Discovery ───

  async function discoverFile(filePath: string): Promise<TestTreeNode | null> {
    return new Promise((resolve) => {
      const child = fork(resolvedDiscoverScript, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        ...(tsxBin ? { execPath: tsxBin } : {}),
        env: {
          ...process.env,
          NODE_PATH: path.resolve(__dirname, '..', '..'),
        },
      });

      let settled = false;

      child.on('message', (response: UIDiscoverChildMessage) => {
        if (settled) return;
        settled = true;

        if (response.type === 'discover-result') {
          resolve(response.tree);
        } else {
          console.error(`Discovery error for ${filePath}: ${response.error.message}`);
          resolve(null);
        }
      });

      child.on('exit', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });

      child.on('error', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });

      const msg: UIDiscoverMessage = { type: 'discover', filePath };
      child.send(msg);
    });
  }

  async function discoverAllFiles(): Promise<void> {
    // Discover all files first
    const fileNodes = new Map<string, TestTreeNode>();
    for (const file of ctx.testFiles) {
      const tree = await discoverFile(file);
      if (tree) {
        fileNodes.set(file, tree);
      }
    }

    // Group into project nodes when projects are configured
    if (hasRealProjects && ctx.projects) {
      const trees: TestTreeNode[] = [];
      for (const project of ctx.projects) {
        const projectFiles = project.testFiles
          .map((f) => fileNodes.get(f))
          .filter((n): n is TestTreeNode => n != null);

        if (projectFiles.length === 0) continue;

        trees.push({
          id: `project::${project.name}`,
          type: 'project',
          name: project.name,
          filePath: '',
          fullName: project.name,
          status: 'idle',
          children: projectFiles,
          dependencies: project.dependencies.length > 0 ? project.dependencies : undefined,
        });
      }
      testTree = trees;
    } else {
      // No meaningful projects — flat file list
      testTree = [...fileNodes.values()];
    }

    broadcast({ type: 'test-tree', files: testTree });
  }

  // ─── Test Execution (shared) ───

  function updateTestStatus(fullName: string, filePath: string, status: TestTreeNode['status'], duration?: number, error?: string, tracePath?: string, workerId?: number): void {
    if (status === 'failed') failedFiles.add(filePath);
    broadcast({
      type: 'test-status',
      fullName,
      filePath,
      status,
      duration,
      error,
      tracePath,
      workerId,
    });
  }

  /**
   * Walk the test tree and broadcast 'skipped' status for every test under
   * a project whose dependency failed, so the UI shows them correctly.
   */
  function markProjectTestsSkipped(projectName: string): void {
    function markChildren(nodes: TestTreeNode[]): void {
      for (const node of nodes) {
        if (node.type === 'test') {
          updateTestStatus(node.fullName, node.filePath, 'skipped');
        }
        if (node.children) markChildren(node.children);
      }
    }

    for (const node of testTree) {
      if (node.type === 'project' && node.name === projectName && node.children) {
        markChildren(node.children);
        return;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ─── Single-worker execution (existing — forks ui-run.ts per file)
  // ═══════════════════════════════════════════════════════════════════

  async function runFileSingle(filePath: string, testFilter?: string): Promise<void> {
    if (isRunning) return;

    isRunning = true;
    const project = fileToProject.get(filePath);
    const useOptions = project?.use as RunFileUseOptions | undefined;
    const projectName = project && project.name !== 'default' ? project.name : undefined;

    broadcast({ type: 'file-status', filePath, status: 'running' });
    broadcast({ type: 'run-start', fileCount: 1, filePath, testFilter });
    screenPollActive = true;

    try {
      const { results, suite } = await runFileInChild(filePath, useOptions, projectName, testFilter);

      const passed = results.filter((r) => r.status === 'passed').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      const duration = suite.durationMs;

      broadcast({ type: 'file-status', filePath, status: 'done' });
      broadcast({
        type: 'run-end',
        status: failed > 0 ? 'failed' : 'passed',
        duration,
        passed,
        failed,
        skipped,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${msg}` });
      broadcast({ type: 'file-status', filePath, status: 'done' });
      broadcast({ type: 'run-end', status: 'failed', duration: 0, passed: 0, failed: 1, skipped: 0 });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  async function runAllFilesSingle(): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    screenPollActive = true;

    broadcast({ type: 'run-start', fileCount: ctx.testFiles.length });

    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalDuration = 0;

    try {
      if (hasRealProjects && ctx.projectWaves) {
        const failedProjects = new Set<string>();

        for (const wave of ctx.projectWaves) {
          for (const project of wave) {
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(project.name);
              failedProjects.add(project.name);
              continue;
            }

            const { passed, failed, skipped, duration, anyFailed } = await runProjectFilesSingle(project);
            totalPassed += passed;
            totalFailed += failed;
            totalSkipped += skipped;
            totalDuration += duration;
            if (anyFailed) failedProjects.add(project.name);
          }
        }
      } else {
        for (const file of ctx.testFiles) {
          const project = fileToProject.get(file);
          const useOptions = project?.use as RunFileUseOptions | undefined;
          const projectName = project && project.name !== 'default' ? project.name : undefined;

          broadcast({ type: 'file-status', filePath: file, status: 'running' });

          try {
            const { results, suite } = await runFileInChild(file, useOptions, projectName);
            totalPassed += results.filter((r) => r.status === 'passed').length;
            totalFailed += results.filter((r) => r.status === 'failed').length;
            totalSkipped += results.filter((r) => r.status === 'skipped').length;
            totalDuration += suite.durationMs;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'error', message: `Error in ${path.basename(file)}: ${errMsg}` });
            totalFailed++;
          }

          broadcast({ type: 'file-status', filePath: file, status: 'done' });
        }
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  async function runProjectFilesSingle(project: ResolvedProject): Promise<{
    passed: number; failed: number; skipped: number; duration: number; anyFailed: boolean
  }> {
    let passed = 0, failed = 0, skipped = 0, duration = 0, anyFailed = false;
    const useOptions = project.use as RunFileUseOptions | undefined;
    const projectName = project.name !== 'default' ? project.name : undefined;

    for (const file of project.testFiles) {
      broadcast({ type: 'file-status', filePath: file, status: 'running' });

      try {
        const { results, suite } = await runFileInChild(file, useOptions, projectName);
        passed += results.filter((r) => r.status === 'passed').length;
        failed += results.filter((r) => r.status === 'failed').length;
        skipped += results.filter((r) => r.status === 'skipped').length;
        duration += suite.durationMs;
        if (results.some((r) => r.status === 'failed')) anyFailed = true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'error', message: `Error in ${path.basename(file)}: ${errMsg}` });
        failed++;
        anyFailed = true;
      }

      broadcast({ type: 'file-status', filePath: file, status: 'done' });
    }

    return { passed, failed, skipped, duration, anyFailed };
  }

  async function runProjectSingle(projectName: string): Promise<void> {
    if (isRunning) return;
    if (!ctx.projects || !ctx.projectWaves) return;

    const target = ctx.projects.find((p) => p.name === projectName);
    if (!target) return;

    isRunning = true;
    screenPollActive = true;

    const requiredNames = collectTransitiveDeps(new Set([projectName]), ctx.projects);
    const filteredWaves = ctx.projectWaves
      .map((wave) => wave.filter((p) => requiredNames.has(p.name)))
      .filter((wave) => wave.length > 0);

    const allFiles = filteredWaves.flatMap((w) => w.flatMap((p) => p.testFiles));
    broadcast({ type: 'run-start', fileCount: allFiles.length });

    let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
    const failedProjects = new Set<string>();

    try {
      for (const wave of filteredWaves) {
        for (const project of wave) {
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
          if (blockedBy) {
            broadcast({ type: 'error', message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed` });
            markProjectTestsSkipped(project.name);
            failedProjects.add(project.name);
            continue;
          }

          const { passed, failed, skipped, duration, anyFailed } = await runProjectFilesSingle(project);
          totalPassed += passed;
          totalFailed += failed;
          totalSkipped += skipped;
          totalDuration += duration;
          if (anyFailed) failedProjects.add(project.name);
        }
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  async function runProjectOnly(projectName: string): Promise<void> {
    if (!ctx.projects) return;
    const target = ctx.projects.find((p) => p.name === projectName);
    if (!target) return;

    if (useParallel()) {
      if (isRunning) return;
      isRunning = true;
      screenPollActive = true;
      parallelRunAborted = false;

      await ensureWorkersReady();

      const files: TaggedFile[] = target.testFiles.map((f) => ({
        filePath: f,
        projectUseOptions: target.use as RunFileUseOptions | undefined,
        projectName: target.name !== 'default' ? target.name : undefined,
      }));

      broadcast({ type: 'run-start', fileCount: files.length });

      try {
        const r = await dispatchFilesParallel(files);
        broadcast({
          type: 'run-end',
          status: r.anyFailed ? 'failed' : 'passed',
          duration: r.duration,
          passed: r.passed,
          failed: r.failed,
          skipped: r.skipped,
        });
      } finally {
        isRunning = false;
        screenPollActive = false;
      }
      return;
    }

    // Single-worker mode
    if (isRunning) return;
    isRunning = true;
    screenPollActive = true;

    broadcast({ type: 'run-start', fileCount: target.testFiles.length });

    try {
      const r = await runProjectFilesSingle(target);
      broadcast({
        type: 'run-end',
        status: r.anyFailed ? 'failed' : 'passed',
        duration: r.duration,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  function runFileInChild(
    filePath: string,
    projectUseOptions?: RunFileUseOptions,
    projectName?: string,
    testFilter?: string,
  ): Promise<{
    results: import('../runner.js').TestResult[]
    suite: import('../runner.js').SuiteResult
  }> {
    return new Promise((resolve, reject) => {
      const child = fork(resolvedRunScript, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        ...(tsxBin ? { execPath: tsxBin } : {}),
        env: {
          ...process.env,
          NODE_PATH: path.resolve(__dirname, '..', '..'),
        },
      });

      activeChild = child;
      let settled = false;
      let currentTestFullName = '';

      child.on('message', (response: UIRunChildMessage) => {
        if (settled) return;

        switch (response.type) {
          case 'test-start': {
            currentTestFullName = response.fullName;
            broadcast({
              type: 'test-start',
              fullName: response.fullName,
              filePath: response.filePath,
            });
            break;
          }
          case 'test-end': {
            const result = deserializeTestResult(response.result);
            if (testFilter && result.status === 'skipped' && result.fullName !== testFilter) {
              break;
            }
            updateTestStatus(
              result.fullName,
              filePath,
              result.status as TestTreeNode['status'],
              result.durationMs,
              result.error?.message,
              result.tracePath,
            );
            break;
          }
          case 'trace-event': {
            broadcast({
              type: 'trace-event',
              testFullName: currentTestFullName,
              event: response.event,
              screenshotBefore: response.screenshotBefore,
              screenshotAfter: response.screenshotAfter,
              hierarchyBefore: response.hierarchyBefore,
              hierarchyAfter: response.hierarchyAfter,
            });
            break;
          }
          case 'source': {
            broadcast({
              type: 'source',
              fileName: response.fileName,
              content: response.content,
            });
            break;
          }
          case 'network': {
            broadcast({
              type: 'network',
              testFullName: currentTestFullName,
              entries: response.entries,
            });
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
        activeChild = null;
        if (!settled) {
          settled = true;
          reject(new Error(`UI run worker exited with code ${code ?? 0} without sending results`));
        }
      });

      child.on('error', (err) => {
        activeChild = null;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      const msg: UIRunMessage = {
        type: 'run',
        daemonAddress: ctx.daemonAddress!,
        deviceSerial: ctx.deviceSerial!,
        filePath,
        config: serializedConfig,
        screenshotDir: ctx.screenshotDir,
        projectUseOptions,
        projectName,
        testFilter,
      };

      child.send(msg);
    });
  }

  async function runFileWithDepsSingle(filePath: string, testFilter?: string): Promise<void> {
    if (isRunning) return;

    const project = fileToProject.get(filePath);
    if (!project || project.dependencies.length === 0 || !ctx.projects || !ctx.projectWaves) {
      return runFileSingle(filePath, testFilter);
    }

    isRunning = true;
    screenPollActive = true;

    const depNames = collectTransitiveDeps(new Set(project.dependencies), ctx.projects);
    depNames.delete(project.name);

    const depWaves = ctx.projectWaves
      .map((wave) => wave.filter((p) => depNames.has(p.name)))
      .filter((wave) => wave.length > 0);

    const depFileCount = depWaves.reduce((n, w) => n + w.reduce((m, p) => m + p.testFiles.length, 0), 0);
    broadcast({ type: 'run-start', fileCount: depFileCount + 1, filePath, testFilter });

    let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
    const failedProjects = new Set<string>();

    try {
      for (const wave of depWaves) {
        for (const depProject of wave) {
          const blockedBy = depProject.dependencies.find((d) => failedProjects.has(d));
          if (blockedBy) {
            broadcast({ type: 'error', message: `Skipping project "${depProject.name}" — dependency "${blockedBy}" failed` });
            markProjectTestsSkipped(depProject.name);
            failedProjects.add(depProject.name);
            continue;
          }

          const r = await runProjectFilesSingle(depProject);
          totalPassed += r.passed;
          totalFailed += r.failed;
          totalSkipped += r.skipped;
          totalDuration += r.duration;
          if (r.anyFailed) failedProjects.add(depProject.name);
        }
      }

      const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
      if (blockedBy) {
        broadcast({ type: 'error', message: `Skipping "${path.basename(filePath)}" — dependency "${blockedBy}" failed` });
        broadcast({ type: 'file-status', filePath, status: 'done' });
      } else {
        const useOptions = project.use as RunFileUseOptions | undefined;
        const pName = project.name !== 'default' ? project.name : undefined;

        broadcast({ type: 'file-status', filePath, status: 'running' });

        try {
          const { results, suite } = await runFileInChild(filePath, useOptions, pName, testFilter);
          totalPassed += results.filter((r) => r.status === 'passed').length;
          totalFailed += results.filter((r) => r.status === 'failed').length;
          totalSkipped += results.filter((r) => r.status === 'skipped').length;
          totalDuration += suite.durationMs;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${errMsg}` });
          totalFailed++;
        }

        broadcast({ type: 'file-status', filePath, status: 'done' });
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ─── Multi-worker execution (persistent ui-worker.ts processes)
  // ═══════════════════════════════════════════════════════════════════

  /** Initialize persistent workers. Called once during server startup. */
  async function initializeWorkers(): Promise<void> {
    if (!ctx.deviceSerials || ctx.deviceSerials.length === 0) return;

    const baseDaemonPort = Number.parseInt(
      (ctx.daemonAddress ?? ctx.config.daemonAddress).split(':').pop() ?? '50051',
      10,
    );
    const baseAgentPort = 18700;
    const rawBin = process.env.PILOT_DAEMON_BIN ?? ctx.config.daemonBin ?? 'pilot-core';
    const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
      ? path.resolve(ctx.config.rootDir, rawBin)
      : rawBin;

    const numWorkers = Math.min(ctx.workers ?? 2, ctx.deviceSerials.length);

    console.log(`${DIM}Initializing ${numWorkers} UI worker(s)...${RESET}`);

    const initPromises: Promise<UIWorkerHandle | null>[] = [];

    for (let i = 0; i < numWorkers; i++) {
      const deviceSerial = ctx.deviceSerials[i];
      const daemonPort = baseDaemonPort + 100 + i;
      const agentPort = baseAgentPort + 100 + i;

      initPromises.push(
        initializeOneWorker(i, deviceSerial, daemonPort, agentPort, daemonBin),
      );
    }

    const results = await Promise.allSettled(initPromises);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value) {
        uiWorkers.push(result.value);
      } else {
        const reason = result.status === 'rejected' ? result.reason : 'null result';
        const serial = ctx.deviceSerials![i];
        console.error(
          `${YELLOW}Skipping device ${serial}: ${reason instanceof Error ? reason.message : reason}.${RESET}`,
        );
      }
    }

    if (uiWorkers.length === 0) {
      console.error(`${YELLOW}No workers initialized. Falling back to single-worker mode.${RESET}`);
      return;
    }

    workersInitialized = true;
    console.log(`${DIM}${uiWorkers.length} UI worker(s) ready.${RESET}`);
  }

  async function initializeOneWorker(
    id: number,
    deviceSerial: string,
    daemonPort: number,
    agentPort: number,
    daemonBin: string,
  ): Promise<UIWorkerHandle> {
    // Spawn daemon
    const daemonProcess = spawn(
      daemonBin,
      ['--port', String(daemonPort), '--agent-port', String(agentPort)],
      { detached: true, stdio: 'ignore' },
    );
    daemonProcess.on('error', () => { /* handled by waitForReady */ });

    const daemonClient = new PilotGrpcClient(`localhost:${daemonPort}`);
    const ready = await daemonClient.waitForReady(10_000);
    if (!ready) {
      try { daemonProcess.kill(); } catch { /* already dead */ }
      daemonClient.close();
      throw new Error(`daemon on port ${daemonPort} did not become ready`);
    }
    // Only detach after confirmed ready so kill() works during init failure
    daemonProcess.unref();

    // Fork ui-worker.ts
    const child = fork(resolvedWorkerScript, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      ...(tsxBin ? { execPath: tsxBin } : {}),
      env: {
        ...process.env,
        NODE_PATH: path.resolve(__dirname, '..', '..'),
        PILOT_WORKER_ID: String(id),
      },
    });
    child.setMaxListeners(20);

    const worker: UIWorkerHandle = {
      id,
      process: child,
      deviceSerial,
      daemonPort,
      agentPort,
      daemonProcess,
      screenClient: daemonClient,
      busy: false,
      passed: 0,
      failed: 0,
      skipped: 0,
    };

    // Wait for worker to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`worker ${id} timed out during initialization (90s)`));
      }, 90_000);

      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`worker ${id} exited with code ${code} during initialization`));
      };

      const onMessage = (msg: UIWorkerChildMessage) => {
        if (msg.type === 'ready' && msg.workerId === id) {
          clearTimeout(timeout);
          cleanup();
          resolve();
        } else if (msg.type === 'progress' && msg.workerId === id) {
          console.log(`${DIM}  Worker ${id} (${deviceSerial}): ${msg.message}${RESET}`);
          broadcastWorkerStatus(worker, 'initializing');
        } else if (msg.type === 'error' && msg.workerId === id) {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(msg.error.message));
        }
      };

      const cleanup = () => {
        child.removeListener('exit', onExit);
        child.removeListener('message', onMessage);
      };

      child.on('exit', onExit);
      child.on('message', onMessage);

      const initMsg: UIWorkerMessage = {
        type: 'init',
        workerId: id,
        deviceSerial,
        daemonPort,
        config: serializedConfig,
        screenshotDir: ctx.screenshotDir,
      };
      child.send(initMsg);
    });

    broadcastWorkerStatus(worker, 'idle');
    return worker;
  }

  function broadcastWorkerStatus(worker: UIWorkerHandle, status: 'idle' | 'running' | 'done' | 'initializing' | 'error'): void {
    broadcast({
      type: 'worker-status',
      workerId: worker.id,
      deviceSerial: worker.deviceSerial,
      currentFile: worker.currentFile?.filePath ? path.basename(worker.currentFile.filePath) : undefined,
      currentTest: worker.currentTest,
      status,
      passed: worker.passed,
      failed: worker.failed,
      skipped: worker.skipped,
    });
  }

  /**
   * Dispatch files across workers using work-stealing.
   * Returns aggregate counts.
   */
  async function dispatchFilesParallel(files: TaggedFile[]): Promise<{
    passed: number; failed: number; skipped: number; duration: number; anyFailed: boolean; failedProjectNames: Set<string>
  }> {
    const fileQueue = [...files];
    let passed = 0, failed = 0, skipped = 0, duration = 0, anyFailed = false;
    const failedProjectsInDispatch = new Set<string>();

    const activeWorkers = uiWorkers.filter((w) => !w.retired);
    if (activeWorkers.length === 0) {
      throw new Error('No active workers available');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const dispatchListeners: Array<{ worker: UIWorkerHandle; messageHandler: (msg: UIWorkerChildMessage) => void; exitHandler: (code: number | null) => void }> = [];

      function settleResolve(): void {
        if (settled) return;
        settled = true;
        // Clean up dispatch-specific listeners
        for (const { worker, messageHandler, exitHandler } of dispatchListeners) {
          worker.process.removeListener('message', messageHandler);
          worker.process.removeListener('exit', exitHandler);
        }
        resolve();
      }

      function maybeResolve(): void {
        if (settled) return;
        if (parallelRunAborted) {
          // Wait for all busy workers to finish their in-flight test
          if (activeWorkers.every((w) => w.retired || !w.busy)) {
            settleResolve();
          }
          return;
        }
        if (fileQueue.length > 0) return;
        if (activeWorkers.every((w) => w.retired || !w.busy)) {
          settleResolve();
        }
      }

      function dispatchNext(worker: UIWorkerHandle): void {
        if (worker.retired || parallelRunAborted) return;

        const next = fileQueue.shift();
        if (!next) {
          worker.busy = false;
          worker.currentFile = undefined;
          worker.currentTest = undefined;
          broadcastWorkerStatus(worker, 'idle');
          maybeResolve();
          return;
        }

        worker.busy = true;
        worker.currentFile = next;
        worker.currentTest = undefined;
        broadcastWorkerStatus(worker, 'running');
        broadcast({ type: 'file-status', filePath: next.filePath, status: 'running' });

        const msg: UIWorkerMessage = {
          type: 'run-file',
          filePath: next.filePath,
          projectUseOptions: next.projectUseOptions,
          projectName: next.projectName,
          testFilter: next.testFilter,
        };
        worker.process.send(msg);
      }

      function retireWorker(worker: UIWorkerHandle, reason: string): void {
        if (worker.retired) return;
        worker.retired = true;
        const inFlightFile = worker.currentFile;
        worker.currentFile = undefined;
        worker.busy = false;
        broadcastWorkerStatus(worker, 'error');

        if (inFlightFile) {
          fileQueue.unshift(inFlightFile);
          console.error(`${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) became unavailable: ${reason}. Requeueing ${path.basename(inFlightFile.filePath)}.${RESET}`);
        }

        const remaining = activeWorkers.filter((w) => !w.retired);
        if (remaining.length === 0) {
          settled = true;
          reject(new Error(`All workers became unavailable. Last failure: ${reason}`));
          return;
        }

        const idleWorker = remaining.find((w) => !w.busy);
        if (idleWorker) dispatchNext(idleWorker);
        maybeResolve();
      }

      // Attach listeners and dispatch
      for (const worker of activeWorkers) {
        const messageHandler = (msg: UIWorkerChildMessage): void => {
          if (settled || worker.retired) return;

          switch (msg.type) {
            case 'test-start': {
              worker.currentTest = msg.fullName;
              broadcastWorkerStatus(worker, 'running');
              broadcast({
                type: 'test-start',
                fullName: msg.fullName,
                filePath: msg.filePath,
                workerId: worker.id,
              });
              break;
            }
            case 'test-end': {
              const result = deserializeTestResult(msg.result);
              const tf = worker.currentFile?.testFilter;
              if (tf && result.status === 'skipped' && result.fullName !== tf) {
                break;
              }
              updateTestStatus(
                result.fullName,
                worker.currentFile?.filePath ?? '',
                result.status as TestTreeNode['status'],
                result.durationMs,
                result.error?.message,
                result.tracePath,
                worker.id,
              );
              if (result.status === 'passed') worker.passed++;
              else if (result.status === 'failed') worker.failed++;
              else if (result.status === 'skipped') worker.skipped++;
              break;
            }
            case 'trace-event': {
              broadcast({
                type: 'trace-event',
                testFullName: worker.currentTest ?? '',
                event: msg.event,
                screenshotBefore: msg.screenshotBefore,
                screenshotAfter: msg.screenshotAfter,
                hierarchyBefore: msg.hierarchyBefore,
                hierarchyAfter: msg.hierarchyAfter,
              });
              break;
            }
            case 'source': {
              broadcast({ type: 'source', fileName: msg.fileName, content: msg.content });
              break;
            }
            case 'network': {
              broadcast({ type: 'network', testFullName: worker.currentTest ?? '', entries: msg.entries });
              break;
            }
            case 'file-done': {
              const results = msg.results.map(deserializeTestResult);
              const suite = deserializeSuiteResult(msg.suite);

              passed += results.filter((r) => r.status === 'passed').length;
              failed += results.filter((r) => r.status === 'failed').length;
              skipped += results.filter((r) => r.status === 'skipped').length;
              duration += suite.durationMs;
              if (results.some((r) => r.status === 'failed')) {
                anyFailed = true;
                // Track which project this file belongs to
                if (worker.currentFile?.projectName) {
                  failedProjectsInDispatch.add(worker.currentFile.projectName);
                }
              }

              broadcast({ type: 'file-status', filePath: msg.filePath, status: 'done' });
              worker.currentFile = undefined;
              worker.currentTest = undefined;

              if (parallelRunAborted) {
                // Abort: mark worker idle without dispatching next file
                worker.busy = false;
                broadcastWorkerStatus(worker, 'idle');
                maybeResolve();
              } else {
                broadcastWorkerStatus(worker, 'running');
                dispatchNext(worker);
              }
              break;
            }
            case 'error': {
              retireWorker(worker, msg.error.message);
              break;
            }
          }
        };

        const exitHandler = (code: number | null): void => {
          if (settled) return;
          if (worker.retired) {
            maybeResolve();
            return;
          }
          retireWorker(worker, `exited unexpectedly with code ${code}`);
        };

        dispatchListeners.push({ worker, messageHandler, exitHandler });
        worker.process.on('message', messageHandler);
        worker.process.on('exit', exitHandler);

        dispatchNext(worker);
      }
    });

    return { passed, failed, skipped, duration, anyFailed, failedProjectNames: failedProjectsInDispatch };
  }

  async function runAllFilesParallel(): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    screenPollActive = true;
    parallelRunAborted = false;

    // Reset worker counters
    for (const w of uiWorkers) {
      w.passed = 0;
      w.failed = 0;
      w.skipped = 0;
    }

    broadcast({ type: 'run-start', fileCount: ctx.testFiles.length });

    let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;

    try {
      if (hasRealProjects && ctx.projectWaves) {
        const failedProjects = new Set<string>();

        for (const wave of ctx.projectWaves) {
          if (parallelRunAborted) break;

          const waveFiles: TaggedFile[] = [];
          for (const project of wave) {
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(project.name);
              failedProjects.add(project.name);
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
            const r = await dispatchFilesParallel(waveFiles);
            totalPassed += r.passed;
            totalFailed += r.failed;
            totalSkipped += r.skipped;
            totalDuration += r.duration;

            // Track per-project failures using actual per-file results
            if (r.anyFailed) {
              for (const project of wave) {
                if (failedProjects.has(project.name)) continue;
                if (r.failedProjectNames.has(project.name)) {
                  failedProjects.add(project.name);
                }
              }
            }
          }
        }
      } else {
        const allFiles: TaggedFile[] = ctx.testFiles.map((f) => {
          const project = fileToProject.get(f);
          return {
            filePath: f,
            projectUseOptions: project?.use as RunFileUseOptions | undefined,
            projectName: project && project.name !== 'default' ? project.name : undefined,
          };
        });

        const r = await dispatchFilesParallel(allFiles);
        totalPassed = r.passed;
        totalFailed = r.failed;
        totalSkipped = r.skipped;
        totalDuration = r.duration;
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 || parallelRunAborted ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message: errMsg });
      broadcast({
        type: 'run-end',
        status: 'failed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed + 1,
        skipped: totalSkipped,
      });
    } finally {
      isRunning = false;
      screenPollActive = false;
      for (const w of uiWorkers) {
        if (!w.retired) broadcastWorkerStatus(w, 'idle');
      }
    }
  }

  async function runFileParallel(filePath: string, testFilter?: string): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    screenPollActive = true;
    parallelRunAborted = false;

    broadcast({ type: 'run-start', fileCount: 1, filePath, testFilter });

    const project = fileToProject.get(filePath);
    const file: TaggedFile = {
      filePath,
      projectUseOptions: project?.use as RunFileUseOptions | undefined,
      projectName: project && project.name !== 'default' ? project.name : undefined,
      testFilter,
    };

    try {
      const r = await dispatchFilesParallel([file]);

      broadcast({
        type: 'run-end',
        status: r.failed > 0 ? 'failed' : 'passed',
        duration: r.duration,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${errMsg}` });
      broadcast({ type: 'file-status', filePath, status: 'done' });
      broadcast({ type: 'run-end', status: 'failed', duration: 0, passed: 0, failed: 1, skipped: 0 });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  /** Signal all busy workers to abort gracefully (finish current test, skip rest). */
  function stopParallelRun(): void {
    parallelRunAborted = true;

    for (const worker of uiWorkers) {
      if (worker.busy) {
        // Send graceful abort — worker stays alive, no respawn needed
        try { worker.process.send({ type: 'abort' } satisfies import('./ui-protocol.js').UIWorkerAbortMessage); } catch { /* IPC closed */ }
      }
    }

    // Don't force-resolve the dispatch promise — let file-done messages settle
    // naturally so workers transition to !busy and the promise resolves cleanly.
  }

  /** Respawn any retired workers before starting a new run. */
  async function ensureWorkersReady(): Promise<void> {
    if (!multiWorker || !ctx.deviceSerials) return;

    const baseDaemonPort = Number.parseInt(
      (ctx.daemonAddress ?? ctx.config.daemonAddress).split(':').pop() ?? '50051',
      10,
    );
    const baseAgentPort = 18700;
    const rawBin = process.env.PILOT_DAEMON_BIN ?? ctx.config.daemonBin ?? 'pilot-core';
    const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
      ? path.resolve(ctx.config.rootDir, rawBin)
      : rawBin;

    const respawnPromises: Promise<void>[] = [];

    for (let i = 0; i < uiWorkers.length; i++) {
      const worker = uiWorkers[i];
      if (!worker.retired) continue;

      const daemonPort = baseDaemonPort + 100 + worker.id;
      const agentPort = baseAgentPort + 100 + worker.id;

      respawnPromises.push((async () => {
        try {
          // Clean up old daemon
          try { worker.daemonProcess?.kill(); } catch { /* already dead */ }
          worker.screenClient?.close();

          const newWorker = await initializeOneWorker(
            worker.id, worker.deviceSerial, daemonPort, agentPort, daemonBin,
          );
          // Replace in array
          uiWorkers[i] = newWorker;
        } catch (err) {
          console.error(
            `${YELLOW}Failed to respawn worker ${worker.id}: ${err instanceof Error ? err.message : err}${RESET}`,
          );
        }
      })());
    }

    if (respawnPromises.length > 0) {
      console.log(`${DIM}Respawning ${respawnPromises.length} worker(s)...${RESET}`);
      await Promise.allSettled(respawnPromises);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ─── Dispatch (routes to single or parallel)
  // ═══════════════════════════════════════════════════════════════════

  const useParallel = () => multiWorker && workersInitialized && uiWorkers.length > 1;

  async function runFile(filePath: string, testFilter?: string): Promise<void> {
    if (useParallel()) {
      await ensureWorkersReady();
      return runFileParallel(filePath, testFilter);
    }
    return runFileSingle(filePath, testFilter);
  }

  async function runAllFiles(): Promise<void> {
    if (useParallel()) {
      await ensureWorkersReady();
      return runAllFilesParallel();
    }
    return runAllFilesSingle();
  }

  async function runProject(projectName: string): Promise<void> {
    // Project runs with deps use the same wave-based approach in parallel
    if (useParallel()) {
      if (!ctx.projects || !ctx.projectWaves) return;
      if (isRunning) return;

      const target = ctx.projects.find((p) => p.name === projectName);
      if (!target) return;

      isRunning = true;
      screenPollActive = true;
      parallelRunAborted = false;

      await ensureWorkersReady();

      const requiredNames = collectTransitiveDeps(new Set([projectName]), ctx.projects);
      const filteredWaves = ctx.projectWaves
        .map((wave) => wave.filter((p) => requiredNames.has(p.name)))
        .filter((wave) => wave.length > 0);

      const allFiles = filteredWaves.flatMap((w) => w.flatMap((p) => p.testFiles));
      broadcast({ type: 'run-start', fileCount: allFiles.length });

      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      const failedProjects = new Set<string>();

      try {
        for (const wave of filteredWaves) {
          if (parallelRunAborted) break;

          const waveFiles: TaggedFile[] = [];
          for (const project of wave) {
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(project.name);
              failedProjects.add(project.name);
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
            const r = await dispatchFilesParallel(waveFiles);
            totalPassed += r.passed;
            totalFailed += r.failed;
            totalSkipped += r.skipped;
            totalDuration += r.duration;
            if (r.anyFailed) {
              for (const project of wave) {
                if (!failedProjects.has(project.name)) failedProjects.add(project.name);
              }
            }
          }
        }

        broadcast({
          type: 'run-end',
          status: totalFailed > 0 ? 'failed' : 'passed',
          duration: totalDuration,
          passed: totalPassed,
          failed: totalFailed,
          skipped: totalSkipped,
        });
      } finally {
        isRunning = false;
        screenPollActive = false;
      }
      return;
    }
    return runProjectSingle(projectName);
  }

  async function runFileWithDeps(filePath: string, testFilter?: string): Promise<void> {
    if (useParallel()) {
      // In parallel mode, run deps as waves then target file
      const project = fileToProject.get(filePath);
      if (!project || project.dependencies.length === 0 || !ctx.projects || !ctx.projectWaves) {
        return runFile(filePath, testFilter);
      }

      if (isRunning) return;
      isRunning = true;
      screenPollActive = true;
      parallelRunAborted = false;

      await ensureWorkersReady();

      const depNames = collectTransitiveDeps(new Set(project.dependencies), ctx.projects);
      depNames.delete(project.name);
      const depWaves = ctx.projectWaves
        .map((wave) => wave.filter((p) => depNames.has(p.name)))
        .filter((wave) => wave.length > 0);

      const depFileCount = depWaves.reduce((n, w) => n + w.reduce((m, p) => m + p.testFiles.length, 0), 0);
      broadcast({ type: 'run-start', fileCount: depFileCount + 1, filePath, testFilter });

      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      const failedProjects = new Set<string>();

      try {
        for (const wave of depWaves) {
          if (parallelRunAborted) break;
          const waveFiles: TaggedFile[] = [];
          for (const depProject of wave) {
            const blockedBy = depProject.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              broadcast({ type: 'error', message: `Skipping project "${depProject.name}" — dependency "${blockedBy}" failed` });
              markProjectTestsSkipped(depProject.name);
              failedProjects.add(depProject.name);
              continue;
            }
            for (const f of depProject.testFiles) {
              waveFiles.push({
                filePath: f,
                projectUseOptions: depProject.use as RunFileUseOptions | undefined,
                projectName: depProject.name !== 'default' ? depProject.name : undefined,
              });
            }
          }
          if (waveFiles.length > 0) {
            const r = await dispatchFilesParallel(waveFiles);
            totalPassed += r.passed;
            totalFailed += r.failed;
            totalSkipped += r.skipped;
            totalDuration += r.duration;
            if (r.anyFailed) {
              for (const dp of wave) failedProjects.add(dp.name);
            }
          }
        }

        const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
        if (blockedBy) {
          broadcast({ type: 'error', message: `Skipping "${path.basename(filePath)}" — dependency "${blockedBy}" failed` });
          broadcast({ type: 'file-status', filePath, status: 'done' });
        } else {
          const targetFile: TaggedFile = {
            filePath,
            projectUseOptions: project.use as RunFileUseOptions | undefined,
            projectName: project.name !== 'default' ? project.name : undefined,
            testFilter,
          };
          const r = await dispatchFilesParallel([targetFile]);
          totalPassed += r.passed;
          totalFailed += r.failed;
          totalSkipped += r.skipped;
          totalDuration += r.duration;
        }

        broadcast({
          type: 'run-end',
          status: totalFailed > 0 ? 'failed' : 'passed',
          duration: totalDuration,
          passed: totalPassed,
          failed: totalFailed,
          skipped: totalSkipped,
        });
      } finally {
        isRunning = false;
        screenPollActive = false;
      }
      return;
    }
    return runFileWithDepsSingle(filePath, testFilter);
  }

  // ─── Screen Polling ───

  /** Poll a single device and broadcast its frame. */
  async function pollSingleWorker(workerId: number, client: import('../grpc-client.js').PilotGrpcClient): Promise<void> {
    const response = await client.takeScreenshot();
    if (response.success && response.data) {
      const data = Buffer.isBuffer(response.data)
        ? response.data
        : Buffer.from(response.data);
      // Read dimensions from the PNG IHDR chunk (bytes 16-23: width + height as big-endian uint32)
      const width = data.length >= 24 ? data.readUInt32BE(16) : 1080;
      const height = data.length >= 24 ? data.readUInt32BE(20) : 1920;
      const frame = encodeScreenFrame(screenSeq++, workerId, width, height, data);
      broadcastBinary(frame);
    }
  }

  async function pollScreen(): Promise<void> {
    if (clients.size === 0) {
      scheduleScreenPoll();
      return;
    }

    try {
      if (multiWorker && workersInitialized && screenViewMode === 'all') {
        // Poll ALL non-retired workers in parallel
        const activeWorkers = uiWorkers.filter((w) => !w.retired && w.screenClient);
        await Promise.allSettled(
          activeWorkers.map((w) => pollSingleWorker(w.id, w.screenClient!)),
        );
      } else {
        // Single-worker mode or specific worker selected
        const pollClient = multiWorker && workersInitialized
          ? uiWorkers.find((w) => w.id === selectedWorkerId && !w.retired)?.screenClient
          : ctx.client;

        if (!pollClient) {
          scheduleScreenPoll();
          return;
        }

        await pollSingleWorker(selectedWorkerId, pollClient);
      }
    } catch {
      // Device may be busy — skip frame
    }

    scheduleScreenPoll();
  }

  function scheduleScreenPoll(): void {
    if (screenPollTimer) clearTimeout(screenPollTimer);
    const interval = screenPollActive ? 150 : 500;
    screenPollTimer = setTimeout(pollScreen, interval);
  }

  // ─── Watch Mode ───

  function startWatching(filePath: string): void {
    if (watchedFiles.has(filePath)) return;
    watchedFiles.add(filePath);

    if (!watcher) {
      watcher = chokidarWatch([], { ignoreInitial: true });
      watcher.on('change', (changedPath) => {
        if (watchedFiles.has(changedPath)) {
          broadcast({ type: 'watch-event', filePath: changedPath, event: 'changed' });
          watchQueue.scheduleFiles([changedPath]);
        }
      });
    }

    watcher.add(filePath);
    broadcast({ type: 'watch-event', filePath, event: 'watch-enabled' });
  }

  function stopWatching(filePath: string): void {
    if (!watchedFiles.has(filePath)) return;
    watchedFiles.delete(filePath);
    watcher?.unwatch(filePath);
    broadcast({ type: 'watch-event', filePath, event: 'watch-disabled' });
  }

  const watchQueue = new RunQueue(300, (request) => {
    if (request.type === 'all') {
      runAllFiles().catch(broadcastError);
    } else {
      const file = request.files[0];
      if (file) runFile(file).catch(broadcastError);
    }
  });

  // ─── Command Handler ───

  function handleCommand(msg: ClientMessage): void {
    switch (msg.type) {
      case 'run-test':
        if (!ctx.testFiles.includes(msg.filePath)) break;
        if (msg.runDeps) runFileWithDeps(msg.filePath, msg.fullName).catch(broadcastError);
        else runFile(msg.filePath, msg.fullName).catch(broadcastError);
        break;
      case 'run-file':
        if (!ctx.testFiles.includes(msg.filePath)) break;
        if (msg.runDeps) runFileWithDeps(msg.filePath).catch(broadcastError);
        else runFile(msg.filePath).catch(broadcastError);
        break;
      case 'run-all':
        runAllFiles().catch(broadcastError);
        break;
      case 'run-failed': {
        const files = [...failedFiles];
        if (files.length > 0 && !isRunning) {
          failedFiles.clear();
          ;(async () => {
            if (useParallel() && files.length > 1) {
              isRunning = true;
              screenPollActive = true;
              parallelRunAborted = false;
              await ensureWorkersReady();

              broadcast({ type: 'run-start', fileCount: files.length });

              const taggedFiles: TaggedFile[] = files.map((f) => {
                const project = fileToProject.get(f);
                return {
                  filePath: f,
                  projectUseOptions: project?.use as RunFileUseOptions | undefined,
                  projectName: project && project.name !== 'default' ? project.name : undefined,
                };
              });

              try {
                const r = await dispatchFilesParallel(taggedFiles);
                broadcast({
                  type: 'run-end',
                  status: r.failed > 0 ? 'failed' : 'passed',
                  duration: r.duration,
                  passed: r.passed,
                  failed: r.failed,
                  skipped: r.skipped,
                });
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                broadcast({ type: 'error', message: `Failed to run failed tests: ${errMsg}` });
                broadcast({ type: 'run-end', status: 'failed', duration: 0, passed: 0, failed: 1, skipped: 0 });
              } finally {
                isRunning = false;
                screenPollActive = false;
              }
            } else {
              // Single-worker: run files sequentially via runFile (each manages isRunning)
              for (const f of files) await runFile(f);
            }
          })().catch(broadcastError);
        }
        break;
      }
      case 'run-project':
        if (msg.runDeps) runProject(msg.projectName).catch(broadcastError);
        else runProjectOnly(msg.projectName).catch(broadcastError);
        break;
      case 'stop-run':
        if (useParallel()) {
          stopParallelRun();
        } else if (activeChild) {
          try { activeChild.kill(); } catch { /* already dead */ }
        }
        break;
      case 'toggle-watch':
        if (msg.filePath === 'all') {
          const allWatched = ctx.testFiles.every((f) => watchedFiles.has(f));
          for (const f of ctx.testFiles) {
            if (allWatched) stopWatching(f);
            else startWatching(f);
          }
        } else {
          if (watchedFiles.has(msg.filePath)) stopWatching(msg.filePath);
          else startWatching(msg.filePath);
        }
        break;
      case 'request-hierarchy': {
        const hierClient = multiWorker && workersInitialized
          ? uiWorkers.find((w) => w.id === selectedWorkerId && !w.retired)?.screenClient
          : ctx.client;
        hierClient?.getUiHierarchy().then((response) => {
          if (response.hierarchyXml) {
            broadcast({ type: 'hierarchy-update', xml: response.hierarchyXml });
          }
        }).catch(() => {});
        break;
      }
      case 'tap-coordinates':
        console.log(`[Pilot UI] Tap at (${msg.x.toFixed(2)}, ${msg.y.toFixed(2)}) — coordinate tap not yet implemented`);
        break;
      case 'select-worker':
        selectedWorkerId = msg.workerId;
        screenViewMode = msg.workerId;
        // Send device info for the new selection
        {
          const worker = uiWorkers.find((w) => w.id === msg.workerId);
          if (worker) {
            broadcast({
              type: 'device-info',
              serial: worker.deviceSerial,
              model: undefined,
              isEmulator: worker.deviceSerial.startsWith('emulator-'),
            });
          }
        }
        break;
      case 'select-worker-view':
        screenViewMode = msg.mode;
        if (typeof msg.mode === 'number') {
          selectedWorkerId = msg.mode;
          const worker = uiWorkers.find((w) => w.id === msg.mode);
          if (worker) {
            broadcast({
              type: 'device-info',
              serial: worker.deviceSerial,
              model: undefined,
              isEmulator: worker.deviceSerial.startsWith('emulator-'),
            });
          }
        }
        break;
      case 'respawn-worker': {
        const worker = uiWorkers.find((w) => w.id === msg.workerId);
        if (worker && !worker.retired) {
          worker.retired = true;
          worker.busy = false;
          try { if (worker.process.connected) worker.process.send({ type: 'shutdown' }); } catch { /* dead */ }
          console.log(`${DIM}Worker ${worker.id} marked for respawn by user${RESET}`);
          broadcastWorkerStatus(worker, 'error');
          ensureWorkersReady().then(() => {
            const respawned = uiWorkers.find((w) => w.id === msg.workerId);
            if (respawned && !respawned.retired) {
              broadcastWorkerStatus(respawned, 'idle');
            }
          }).catch(() => {});
        }
        break;
      }
      case 'set-filter':
        // Filtering is client-side — no action needed
        break;
    }
  }

  // ─── HTTP Server ───

  let spaHtml: string;
  try {
    spaHtml = fs.readFileSync(SPA_HTML_PATH, 'utf-8');
  } catch {
    spaHtml = buildFallbackHtml();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(spaHtml);
      return;
    }

    // Serve trace ZIP files for download.
    // Security: only serve .zip files that reside within the project's output directory.
    if (url.pathname.startsWith('/trace/')) {
      const tracePath = decodeURIComponent(url.pathname.slice('/trace/'.length));
      if (!tracePath.endsWith('.zip')) {
        res.writeHead(404);
        res.end('Trace not found');
        return;
      }
      // tracePath may be absolute (from packageTrace) or relative
      const resolvedTrace = path.resolve(tracePath);
      const resolvedOutputDir = path.resolve(ctx.config.rootDir, ctx.config.outputDir);
      const relative = path.relative(resolvedOutputDir, resolvedTrace);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolvedTrace)) {
        res.writeHead(404);
        res.end('Trace not found');
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolvedTrace);
      } catch {
        res.writeHead(404);
        res.end('Trace not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(resolvedTrace)}"`,
      });
      fs.createReadStream(resolvedTrace)
        .on('error', () => { res.end(); })
        .pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // ─── WebSocket Server ───

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send current state to new client
    ws.send(JSON.stringify({ type: 'test-tree', files: testTree } satisfies ServerMessage));

    if (multiWorker && workersInitialized) {
      // Send workers info
      ws.send(JSON.stringify({
        type: 'workers-info',
        workers: uiWorkers.map((w) => ({ workerId: w.id, deviceSerial: w.deviceSerial })),
      } satisfies ServerMessage));

      // Send device info for selected worker
      const selectedWorker = uiWorkers.find((w) => w.id === selectedWorkerId);
      if (selectedWorker) {
        ws.send(JSON.stringify({
          type: 'device-info',
          serial: selectedWorker.deviceSerial,
          model: undefined,
          isEmulator: selectedWorker.deviceSerial.startsWith('emulator-'),
        } satisfies ServerMessage));
      }

      // Send current worker statuses
      for (const w of uiWorkers) {
        ws.send(JSON.stringify({
          type: 'worker-status',
          workerId: w.id,
          deviceSerial: w.deviceSerial,
          status: w.retired ? 'error' : w.busy ? 'running' : 'idle',
          passed: w.passed,
          failed: w.failed,
          skipped: w.skipped,
        } satisfies ServerMessage));
      }
    } else if (ctx.deviceSerial) {
      ws.send(JSON.stringify({
        type: 'device-info',
        serial: ctx.deviceSerial,
        model: undefined,
        isEmulator: ctx.deviceSerial.startsWith('emulator-'),
      } satisfies ServerMessage));
    }

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        handleCommand(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  // ─── Start ───

  const actualPort = await new Promise<number>((resolve, reject) => {
    const tryPort = options.port ?? 0;
    server.listen(tryPort, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to bind UI server'));
      }
    });
    server.on('error', reject);
  });

  // Discover tests
  await discoverAllFiles();

  // Initialize multi-worker if configured
  if (multiWorker) {
    await initializeWorkers();
  }

  // Start screen polling
  scheduleScreenPoll();

  // Open browser
  const viewerUrl = `http://127.0.0.1:${actualPort}/`;
  try {
    const open = await import('open');
    await open.default(viewerUrl);
  } catch {
    console.log(`Pilot UI: ${viewerUrl}`);
  }

  const workerLabel = multiWorker && workersInitialized
    ? `${uiWorkers.length} worker(s) across ${uiWorkers.map((w) => w.deviceSerial).join(', ')}`
    : `Device: ${ctx.deviceSerial ?? 'unknown'}`;

  console.log(`\x1b[2m${workerLabel} | ${ctx.testFiles.length} test file(s)\x1b[0m`);
  console.log(`\x1b[1mPilot UI mode running at ${viewerUrl}\x1b[0m`);

  // Send device info (single-worker)
  if (!multiWorker && ctx.deviceSerial) {
    broadcast({
      type: 'device-info',
      serial: ctx.deviceSerial,
      model: undefined,
      isEmulator: ctx.deviceSerial.startsWith('emulator-'),
    });
  }

  return {
    port: actualPort,
    close: () => {
      if (screenPollTimer) clearTimeout(screenPollTimer);

      // Clean up workers
      if (multiWorker) {
        for (const worker of uiWorkers) {
          try {
            if (worker.process.connected) {
              worker.process.send({ type: 'shutdown' } satisfies UIWorkerMessage);
              setTimeout(() => {
                try { worker.process.kill(); } catch { /* already dead */ }
              }, 3_000);
            }
          } catch { /* already dead */ }
          try { worker.daemonProcess?.kill(); } catch { /* already dead */ }
          worker.screenClient?.close();
        }
      } else {
        if (activeChild) {
          try { activeChild.kill(); } catch { /* already dead */ }
        }
        ctx.device?.close();
        ctx.client?.close();
      }

      if (watcher) watcher.close();
      for (const ws of clients) ws.close();
      wss.close();
      server.close();

      preserveEmulatorsForReuse(ctx.launchedEmulators);
    },
  };
}

// ─── Fallback HTML ───

function buildFallbackHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Pilot UI Mode</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 40px; background: #1e1e1e; color: #e0e0e0; }
    h1 { color: #fff; }
    .info { color: #888; }
  </style>
</head>
<body>
  <h1>Pilot UI Mode</h1>
  <p class="info">The UI mode bundle was not found. Run <code>npm run build:ui-mode</code> to build it.</p>
  <p class="info">In development, run <code>npx vite --config vite.config.ui-mode.ts</code> for hot-reload.</p>
</body>
</html>`;
}
