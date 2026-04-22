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
import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { WebSocketServer, type WebSocket } from 'ws';
import { createMcpServer } from '../mcp/index.js';
import { McpEventEmitter } from '../mcp/events.js';
import type { TestDispatcher, TestRunResult, TestResultEntry, TestTreeEntry, SessionInfo } from '../mcp/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { PilotConfig } from '../config.js';
import { PilotGrpcClient } from '../grpc-client.js';
import type { Device } from '../device.js';
import type { ResolvedProject } from '../project.js';
import { collectTransitiveDeps } from '../project.js';
import type { LaunchedEmulator } from '../emulator.js';
import { preserveEmulatorsForReuse, getRunningAvdName } from '../emulator.js';
import { listSimulators, getSimulatorScreenScale } from '../ios-simulator.js';
import { listPhysicalDevices } from '../ios-devicectl.js';
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

const PILOT_VERSION = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return (pkg.version as string) ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** Cached screen-scale lookup keyed by UDID — avoids repeated simctl calls. */
const dprCache = new Map<string, number>();
function cachedScreenScale(udid: string, platform?: 'android' | 'ios'): number | undefined {
  if (platform !== 'ios') return undefined;
  let dpr = dprCache.get(udid);
  if (dpr == null) {
    dpr = getSimulatorScreenScale(udid);
    dprCache.set(udid, dpr);
  }
  return dpr;
}

/**
 * Resolve a worker's actual platform. In multi-bucket mode the root config's
 * platform may not match a worker's device (e.g. an iOS worker in a config
 * whose top-level platform is android), so prefer the per-device config.
 */
function resolveDevicePlatform(ctx: UIServerContext, udid: string): 'android' | 'ios' | undefined {
  return ctx.configByDevice?.get(udid)?.platform ?? ctx.config.platform;
}

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
  /**
   * Per-bucket maps for multi-device-target projects. When set, each
   * device serial is paired with its bucket's serialized config and
   * worker dispatch routes files to workers in the matching bucket.
   */
  configByDevice?: Map<string, SerializedConfig>
  bucketByDevice?: Map<string, string>
  bucketByProject?: Map<string, string>
}

export interface UIServerOptions {
  port?: number
  /**
   * When set, the UI server serves a thin HTML shell that loads the Preact
   * SPA from a running Vite dev server at this URL (e.g. `http://localhost:5174`)
   * instead of the bundled single-file HTML. Enables Preact Fast Refresh so
   * frontend edits hot-swap without a full rebuild + CLI restart.
   */
  devUrl?: string
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
  /** Friendly display name, e.g. "iPhone 16 #1" for iOS or the serial for Android. */
  displayName: string
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
  /** Bucket signature this worker is bound to (when multi-bucket UI is in use). */
  bucketSignature?: string
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
  const testResults = new Map<string, TestResultEntry>();
  let activeChild: ChildProcess | null = null;
  let screenPollTimer: ReturnType<typeof setTimeout> | null = null;
  let screenSeq = 0;
  let screenPollActive = false;
  let watcher: FSWatcher | null = null;
  /** A single watched entry: optional project scope + optional test filter.
   * testFilter = undefined means "whole file"; projectName = undefined means
   * "whichever project this file resolves to" (non-multi-project configs). */
  interface WatchedEntry { projectName?: string; testFilter?: string }
  /** filePath → list of watched entries. chokidar adds the file when the
   * first entry appears and removes it when the last entry is cleared. */
  const watchedEntries = new Map<string, WatchedEntry[]>();
  function entryKey(e: WatchedEntry): string {
    // JSON-encode both fields so a test name containing '::' (or any other
    // delimiter) can't collide with a project-name / filter pair that
    // happens to produce the same concatenated string.
    return JSON.stringify([e.projectName ?? null, e.testFilter ?? null]);
  }
  function findEntry(filePath: string, projectName: string | undefined, testFilter: string | undefined): number {
    const list = watchedEntries.get(filePath);
    if (!list) return -1;
    const key = entryKey({ projectName, testFilter });
    return list.findIndex((e) => entryKey(e) === key);
  }

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

  // Build file → project lookup. Note: when the same file matches multiple
  // projects (e.g. an Android and an iOS project both using `**\/*.test.ts`),
  // the last project wins here. Callers that need the project explicitly —
  // for example because the user clicked a test under a specific project tree
  // node — should pass `projectName` and use `projectForFile()` instead.
  const fileToProject = new Map<string, ResolvedProject>();
  if (ctx.projects) {
    for (const project of ctx.projects) {
      for (const file of project.testFiles) {
        fileToProject.set(file, project);
      }
    }
  }

  /** Resolve a project for a file, preferring an explicit project name when
   * supplied. This is the right call when the same file may live under
   * multiple projects (multi-device configs). */
  function projectForFile(filePath: string, projectName?: string): ResolvedProject | undefined {
    if (projectName && ctx.projects) {
      const byName = ctx.projects.find((p) => p.name === projectName);
      if (byName) return byName;
    }
    return fileToProject.get(filePath);
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
    baseURL: ctx.config.baseURL,
    extraHTTPHeaders: ctx.config.extraHTTPHeaders,
  };

  // Resolve a friendly display name for single-worker mode (e.g. UUID → "iPhone 17").
  // Multi-worker resolves names inside initializeWorkers().
  const singleWorkerDisplayName = (() => {
    const serial = ctx.deviceSerial;
    if (!serial) return undefined;
    if (ctx.config.platform === 'ios') {
      const simName = listSimulators().find((s) => s.udid === serial)?.name;
      if (simName) return simName;
      // Physical devices aren't in simctl — check devicectl. This is what
      // surfaces "Sam's iPhone" instead of a raw UDID in the UI header.
      const physName = listPhysicalDevices().find((d) => d.udid === serial)?.name;
      if (physName) return physName;
      return serial;
    }
    if (serial.startsWith('emulator-')) {
      return getRunningAvdName(serial) ?? serial;
    }
    return serial;
  })();

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
    // __dirname is packages/pilot/{src,dist}/ui-mode — the package root
    // (where node_modules lives) is two levels up in both cases.
    const pilotPkgDir = path.resolve(__dirname, '..', '..');
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

  // ─── MCP Server (SSE) ───

  function collectFailures(): import('../mcp/test-dispatcher.js').TestFailureDetail[] {
    return [...testResults.values()]
      .filter((r) => r.status === 'failed' && r.error)
      .map((r) => ({
        fullName: r.fullName,
        filePath: r.filePath,
        error: r.error!,
        tracePath: r.tracePath,
        projectName: r.projectName,
      }));
  }

  function withFailures(result: TestRunResult): TestRunResult {
    if (result.failed > 0) result.failures = collectFailures();
    return result;
  }

  function toTreeEntry(node: TestTreeNode): TestTreeEntry {
    const entry: TestTreeEntry = {
      type: node.type,
      name: node.name,
      fullName: node.fullName,
      filePath: node.filePath,
      status: node.status,
    };
    if (node.children && node.children.length > 0) {
      entry.children = node.children.map(toTreeEntry);
    }
    return entry;
  }

  const testDispatcher: TestDispatcher = {
    async runFiles(files, options) {
      if (multiWorker) await ensureWorkersReady();
      const { testFilter, project } = options ?? {};
      const validFiles = files.filter((f) => ctx.testFiles.includes(f));
      if (validFiles.length === 0) {
        return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
      }
      if (validFiles.length === 1) return withFailures(await runFile(validFiles[0], testFilter, project));
      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      for (const f of validFiles) {
        const r = await runFile(f, undefined, project);
        totalPassed += r.passed;
        totalFailed += r.failed;
        totalSkipped += r.skipped;
        totalDuration += r.duration;
      }
      return withFailures({
        status: totalFailed > 0 ? 'failed' : 'passed',
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        duration: totalDuration,
      });
    },
    async runAll() {
      if (multiWorker) await ensureWorkersReady();
      return withFailures(await runAllFiles());
    },
    stop() {
      if (useParallel()) stopParallelRun();
      else if (activeChild) { try { activeChild.kill(); } catch { /* already dead */ } }
    },
    isRunning: () => isRunning,
    getResults: () => [...testResults.values()],
    getTestFiles: () => ctx.testFiles,
    getProjects: () => {
      if (!ctx.projects) return [];
      return ctx.projects.filter((p) => p.name !== 'default').map((p) => p.name);
    },
    getTestTree: () => testTree.map(toTreeEntry),
    getSessionInfo: (): SessionInfo => {
      const projects = (ctx.projects ?? [])
        .filter((p) => p.name !== 'default')
        .map((p) => ({
          name: p.name,
          platform: p.effectiveConfig.platform,
          package: p.effectiveConfig.package,
          testFiles: p.testFiles,
          dependencies: p.dependencies,
        }));
      return {
        platform: ctx.config.platform,
        package: ctx.config.package,
        device: singleWorkerDisplayName ?? ctx.deviceSerial,
        timeout: ctx.config.timeout,
        retries: ctx.config.retries,
        projects,
      };
    },
    toggleWatch(filePath, options) {
      const { testFilter, project } = options ?? {};
      const isWatched = findEntry(filePath, project, testFilter) >= 0;
      if (isWatched) {
        stopWatching(filePath, project, testFilter);
        return { enabled: false };
      }
      startWatching(filePath, project, testFilter);
      return { enabled: true };
    },
  };

  const mcpEvents = new McpEventEmitter();
  const mcpServer = createMcpServer({ events: mcpEvents, dispatcher: testDispatcher });
  let mcpTransport: SSEServerTransport | null = null;
  let mcpClientName: string | undefined;
  let mcpClientVersion: string | undefined;
  let mcpPort = 0;

  function getMcpStatus(): ServerMessage {
    return {
      type: 'mcp-status' as const,
      running: true,
      sseUrl: mcpPort ? `http://localhost:${mcpPort}/mcp` : undefined,
      clientName: mcpClientName,
      clientVersion: mcpClientVersion,
    };
  }

  mcpEvents.onToolCall((event) => {
    broadcast({ type: 'mcp-tool-call', ...event });
  });

  mcpEvents.onClientChange((info) => {
    mcpClientName = info?.name;
    mcpClientVersion = info?.version;
    broadcast(getMcpStatus());
  });

  // Intercept MCP client connection info from the initialize request
  const origConnect = mcpServer.server.connect.bind(mcpServer.server);
  mcpServer.server.connect = async function (transport) {
    const origOnMessage = transport.onmessage;
    transport.onmessage = (msg, extra) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspecting raw JSON-RPC
      const rpc = msg as any;
      if (rpc.method === 'initialize' && rpc.params?.clientInfo) {
        mcpEvents.emitClientChange({
          name: rpc.params.clientInfo.name ?? 'Unknown',
          version: rpc.params.clientInfo.version ?? '',
        });
      }
      origOnMessage?.(msg, extra);
    };
    transport.onclose = () => {
      mcpEvents.emitClientChange(null);
      mcpTransport = null;
    };
    return origConnect(transport);
  };

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

  /** Deep-clone a discovered tree node, prefixing every id so the same file
   * appearing under multiple projects gets independent expansion / status
   * state on the client. */
  function cloneNodeWithIdPrefix(node: TestTreeNode, prefix: string): TestTreeNode {
    return {
      ...node,
      id: `${prefix}${node.id}`,
      children: node.children?.map((c) => cloneNodeWithIdPrefix(c, prefix)),
    };
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
        const idPrefix = `project::${project.name}::`;
        const projectFiles = project.testFiles
          .map((f) => fileNodes.get(f))
          .filter((n): n is TestTreeNode => n != null)
          // Deep-clone so each project owns its own nodes (unique ids,
          // independent expansion state, scoped status updates).
          .map((n) => cloneNodeWithIdPrefix(n, idPrefix));

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

  function updateTestStatus(
    fullName: string,
    filePath: string,
    status: TestTreeNode['status'],
    duration?: number,
    error?: string,
    tracePath?: string,
    workerId?: number,
    projectName?: string,
  ): void {
    if (status === 'failed') failedFiles.add(filePath);

    const key = projectName ? `${projectName}::${fullName}` : fullName;
    testResults.set(key, { fullName, filePath, status, duration, error, tracePath, projectName });

    broadcast({
      type: 'test-status',
      fullName,
      filePath,
      status,
      duration,
      error,
      tracePath,
      workerId,
      projectName,
    });
  }

  /** Broadcast a file-status update, optionally scoped to a project so the
   * client only updates that project's copy of the file node (multi-device
   * configs share the same file across projects). */
  function broadcastFileStatus(filePath: string, status: 'running' | 'done', projectName?: string): void {
    broadcast({ type: 'file-status', filePath, status, projectName });
  }

  /**
   * Walk the test tree and broadcast 'skipped' status for every test under
   * a project whose dependency failed, so the UI shows them correctly.
   */
  function markProjectTestsSkipped(projectName: string): void {
    function markChildren(nodes: TestTreeNode[]): void {
      for (const node of nodes) {
        if (node.type === 'test') {
          updateTestStatus(node.fullName, node.filePath, 'skipped', undefined, undefined, undefined, undefined, projectName);
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

  async function runFileSingle(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<TestRunResult> {
    if (isRunning) return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };

    isRunning = true;
    testResults.clear();
    const project = projectForFile(filePath, explicitProjectName);
    const useOptions = project?.use as RunFileUseOptions | undefined;
    const projectName = project && project.name !== 'default' ? project.name : undefined;

    broadcastFileStatus(filePath, 'running', projectName);
    broadcast({ type: 'run-start', fileCount: 1, filePath, testFilter, projectName });
    screenPollActive = true;

    try {
      const { results, suite } = await runFileInChild(filePath, useOptions, projectName, testFilter);

      const passed = results.filter((r) => r.status === 'passed').length;
      const failed = results.filter((r) => r.status === 'failed').length;
      const skipped = results.filter((r) => r.status === 'skipped').length;
      const duration = suite.durationMs;

      broadcastFileStatus(filePath, 'done', projectName);
      const runResult: TestRunResult = { status: failed > 0 ? 'failed' : 'passed', passed, failed, skipped, duration };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${msg}` });
      broadcastFileStatus(filePath, 'done', projectName);
      const runResult: TestRunResult = { status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 0 };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  async function runAllFilesSingle(): Promise<TestRunResult> {
    if (isRunning) return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    isRunning = true;
    testResults.clear();
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

          broadcastFileStatus(file, 'running', projectName);

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

          broadcastFileStatus(file, 'done', projectName);
        }
      }

      const runResult: TestRunResult = {
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
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
      broadcastFileStatus(file, 'running', projectName);

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

      broadcastFileStatus(file, 'done', projectName);
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
              projectName,
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
              undefined,
              projectName,
            );
            break;
          }
          case 'trace-event': {
            broadcast({
              type: 'trace-event',
              testFullName: currentTestFullName,
              projectName,
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
              projectName,
              entries: response.entries,
              bodies: response.bodies,
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

  async function runFileWithDepsSingle(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<void> {
    if (isRunning) return;

    const project = projectForFile(filePath, explicitProjectName);
    if (!project || project.dependencies.length === 0 || !ctx.projects || !ctx.projectWaves) {
      await runFileSingle(filePath, testFilter, explicitProjectName);
      return;
    }

    isRunning = true;
    screenPollActive = true;

    const depNames = collectTransitiveDeps(new Set(project.dependencies), ctx.projects);
    depNames.delete(project.name);

    const depWaves = ctx.projectWaves
      .map((wave) => wave.filter((p) => depNames.has(p.name)))
      .filter((wave) => wave.length > 0);

    const depFileCount = depWaves.reduce((n, w) => n + w.reduce((m, p) => m + p.testFiles.length, 0), 0);
    broadcast({
      type: 'run-start',
      fileCount: depFileCount + 1,
      filePath,
      testFilter,
      projectName: project.name !== 'default' ? project.name : undefined,
    });

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

      const pName = project.name !== 'default' ? project.name : undefined;
      const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
      if (blockedBy) {
        broadcast({ type: 'error', message: `Skipping "${path.basename(filePath)}" — dependency "${blockedBy}" failed` });
        broadcastFileStatus(filePath, 'done', pName);
      } else {
        const useOptions = project.use as RunFileUseOptions | undefined;

        broadcastFileStatus(filePath, 'running', pName);

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

        broadcastFileStatus(filePath, 'done', pName);
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

  /**
   * Run a single `lsof` call to find PIDs listening on any of the given ports.
   * Returns a Map from port number to the list of PIDs on that port.
   */
  function collectListeningPids(ports: number[]): Map<number, number[]> {
    const result = new Map<number, number[]>();
    if (ports.length === 0) return result;
    try {
      // Use -F (field mode) to get PID + port associations from a single call.
      const fullArgs = ['-P', '-sTCP:LISTEN', '-F', 'pn', ...ports.map((p) => `-iTCP:${p}`)];
      const out = execFileSync('lsof', fullArgs, { encoding: 'utf-8' }).trim();
      let currentPid = 0;
      for (const line of out.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('n') && currentPid > 0) {
          // Lines look like "n*:50151" or "n127.0.0.1:50151"
          const colonIdx = line.lastIndexOf(':');
          if (colonIdx >= 0) {
            const port = Number(line.slice(colonIdx + 1));
            if (ports.includes(port)) {
              const existing = result.get(port) ?? [];
              if (!existing.includes(currentPid)) existing.push(currentPid);
              result.set(port, existing);
            }
          }
        }
      }
    } catch {
      // lsof failed or no matching processes — fine
    }
    return result;
  }

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

    // Collect PIDs listening on all daemon ports in a single lsof call
    // so each worker doesn't need to shell out individually.
    const daemonPorts = Array.from({ length: numWorkers }, (_, i) => baseDaemonPort + 100 + i);
    const stalePidsByPort = collectListeningPids(daemonPorts);

    for (let i = 0; i < numWorkers; i++) {
      const deviceSerial = ctx.deviceSerials[i];
      const daemonPort = daemonPorts[i];
      const agentPort = baseAgentPort + 100 + i;

      initPromises.push(
        initializeOneWorker(i, deviceSerial, daemonPort, agentPort, daemonBin, stalePidsByPort.get(daemonPort)),
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

    // Resolve friendly display names for workers.
    // iOS: UUID → simulator name (e.g. "iPhone 16 #1")
    // Android: serial → AVD name (e.g. "Pixel_7_Pro #1")
    {
      // Cache simulator list — listSimulators() forks `xcrun simctl` which is
      // slow; we only need it once per init.
      let simulatorsCache: ReturnType<typeof listSimulators> | undefined;
      let physicalDevicesCache: ReturnType<typeof listPhysicalDevices> | undefined;
      const resolveSerialToName = (serial: string): string => {
        // In multi-bucket mode the root config's platform may not match this
        // worker's actual device, so prefer the per-worker config when set.
        const workerPlatform =
          ctx.configByDevice?.get(serial)?.platform ?? ctx.config.platform;
        if (workerPlatform === 'ios') {
          if (!simulatorsCache) simulatorsCache = listSimulators();
          const simName = simulatorsCache.find((s) => s.udid === serial)?.name;
          if (simName) return simName;
          if (!physicalDevicesCache) physicalDevicesCache = listPhysicalDevices();
          return physicalDevicesCache.find((d) => d.udid === serial)?.name ?? serial;
        }
        if (serial.startsWith('emulator-')) {
          return getRunningAvdName(serial) ?? serial;
        }
        return serial;
      };

      // Resolve names for all workers.
      const resolvedNames = uiWorkers.map((w) => resolveSerialToName(w.deviceSerial));

      // Count occurrences of each name to decide whether to append #N.
      const nameCounts = new Map<string, number>();
      for (const name of resolvedNames) {
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const nameIndex = new Map<string, number>();
      for (let i = 0; i < uiWorkers.length; i++) {
        const name = resolvedNames[i];
        const count = nameCounts.get(name) ?? 1;
        if (count > 1) {
          const idx = (nameIndex.get(name) ?? 0) + 1;
          nameIndex.set(name, idx);
          uiWorkers[i].displayName = `${name} #${idx}`;
        } else {
          uiWorkers[i].displayName = name;
        }
      }
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
    stalePids?: number[],
  ): Promise<UIWorkerHandle> {
    // Kill any stale daemon on this port from a previous run or another
    // Pilot instance so we always get a fresh daemon with the correct
    // --platform flag. Without this, waitForReady succeeds by connecting
    // to the old daemon, causing cross-instance interference.
    // PIDs were pre-collected via a single batched lsof call.
    if (stalePids && stalePids.length > 0) {
      for (const pid of stalePids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Remove stale ADB port forwards whose HOST side is this worker's agent
    // port. A previous Android instance may have set up `adb forward
    // tcp:<agentPort>` which hijacks traffic meant for the iOS XCUITest
    // agent. Match `local === tcp:<agentPort>` exactly so we don't try to
    // remove forwards whose remote side merely happens to be the same port
    // (which would print "listener 'tcp:<port>' not found").
    try {
      const fwdList = execFileSync('adb', ['forward', '--list'], { encoding: 'utf-8' }).trim();
      for (const line of fwdList.split('\n')) {
        const [serial, local] = line.split(/\s+/);
        if (!serial || local !== `tcp:${agentPort}`) continue;
        try {
          execFileSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${agentPort}`]);
        } catch { /* already gone */ }
      }
    } catch {
      // ADB not available or no forwards — safe to ignore
    }

    // Resolve per-worker config (multi-bucket) or fall back to the
    // server-wide serializedConfig built from ctx.config.
    const workerConfig = ctx.configByDevice?.get(deviceSerial) ?? serializedConfig;
    const workerBucketSig = ctx.bucketByDevice?.get(deviceSerial);

    // Spawn daemon
    const daemonProcess = spawn(
      daemonBin,
      ['--port', String(daemonPort), '--agent-port', String(agentPort),
        ...(workerConfig.platform ? ['--platform', workerConfig.platform] : [])],
      { stdio: 'ignore' },
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
    child.on('error', (err) => {
      console.error(`${YELLOW}Worker ${id} process error: ${err.message}${RESET}`);
    });

    const worker: UIWorkerHandle = {
      id,
      process: child,
      deviceSerial,
      displayName: deviceSerial,
      daemonPort,
      agentPort,
      daemonProcess,
      screenClient: daemonClient,
      busy: false,
      passed: 0,
      failed: 0,
      skipped: 0,
      bucketSignature: workerBucketSig,
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
        config: workerConfig,
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

        // Multi-bucket: take the first file in the queue whose project's
        // bucket matches this worker. Files for other buckets are skipped
        // and remain in the queue for sibling workers to claim.
        //
        // Deliberate leniency: untagged files (!f.projectName) and files
        // whose project isn't in the bucketByProject map fall through to
        // any worker. In multi-bucket runs the CLI always tags files with
        // their project, so these cases shouldn't happen — but if they did,
        // dropping them entirely would leave the queue stuck forever. Better
        // to run on a possibly-wrong worker than to hang. If this ever turns
        // into a real bug we can tighten to an explicit error.
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
        broadcastFileStatus(next.filePath, 'running', next.projectName);

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
                projectName: worker.currentFile?.projectName,
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
                worker.currentFile?.projectName,
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
                projectName: worker.currentFile?.projectName,
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
              broadcast({ type: 'network', testFullName: worker.currentTest ?? '', projectName: worker.currentFile?.projectName, entries: msg.entries, bodies: msg.bodies });
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

              broadcastFileStatus(msg.filePath, 'done', worker.currentFile?.projectName);
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

  async function runAllFilesParallel(): Promise<TestRunResult> {
    if (isRunning) return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    isRunning = true;
    testResults.clear();
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

      const runResult: TestRunResult = {
        status: totalFailed > 0 || parallelRunAborted ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message: errMsg });
      const runResult: TestRunResult = {
        status: 'failed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed + 1,
        skipped: totalSkipped,
      };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
    } finally {
      isRunning = false;
      screenPollActive = false;
      for (const w of uiWorkers) {
        if (!w.retired) broadcastWorkerStatus(w, 'idle');
      }
    }
  }

  async function runFileParallel(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<TestRunResult> {
    if (isRunning) return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    isRunning = true;
    testResults.clear();
    screenPollActive = true;
    parallelRunAborted = false;

    const project = projectForFile(filePath, explicitProjectName);
    const projectName = project && project.name !== 'default' ? project.name : undefined;
    broadcast({ type: 'run-start', fileCount: 1, filePath, testFilter, projectName });

    const file: TaggedFile = {
      filePath,
      projectUseOptions: project?.use as RunFileUseOptions | undefined,
      projectName,
      testFilter,
    };

    try {
      const r = await dispatchFilesParallel([file]);
      const runResult: TestRunResult = { status: r.failed > 0 ? 'failed' : 'passed', duration: r.duration, passed: r.passed, failed: r.failed, skipped: r.skipped };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${errMsg}` });
      broadcastFileStatus(filePath, 'done', file.projectName);
      const runResult: TestRunResult = { status: 'failed', passed: 0, failed: 1, skipped: 0, duration: 0 };
      broadcast({ type: 'run-end', ...runResult });
      return runResult;
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  /** Stop a parallel run: signal each busy worker to abort. The worker's
   * poll loops bail out immediately via getActiveAbortSignal(), so the
   * in-flight assertion/action doesn't finish its own timeout; the worker
   * itself stays alive and ready for the next run. */
  function stopParallelRun(): void {
    parallelRunAborted = true;

    for (const worker of uiWorkers) {
      if (!worker.busy) continue;
      try {
        worker.process.send({ type: 'abort' } satisfies import('./ui-protocol.js').UIWorkerAbortMessage);
      } catch { /* IPC closed */ }
    }
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
          // Preserve the friendly display name from before respawn.
          newWorker.displayName = worker.displayName;
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

  async function runFile(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<TestRunResult> {
    if (useParallel()) {
      await ensureWorkersReady();
      return runFileParallel(filePath, testFilter, explicitProjectName);
    }
    return runFileSingle(filePath, testFilter, explicitProjectName);
  }

  /** Parallel-mode batch dispatch: send multiple TaggedFile entries to
   * `dispatchFilesParallel` under a single run-start/run-end envelope so
   * sibling projects' workers run concurrently. Used by the watch queue
   * when one file change implicates multiple projects (e.g. watching a
   * test under Android and a different test under iOS in a multi-device
   * config). Caller is responsible for ensuring parallel mode is active. */
  async function runBatchParallel(files: TaggedFile[]): Promise<void> {
    if (files.length === 0 || isRunning) return;
    isRunning = true;
    screenPollActive = true;
    parallelRunAborted = false;

    broadcast({ type: 'run-start', fileCount: files.length });

    try {
      const r = await dispatchFilesParallel(files);
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
      broadcast({ type: 'error', message: errMsg });
      broadcast({ type: 'run-end', status: 'failed', duration: 0, passed: 0, failed: files.length, skipped: 0 });
    } finally {
      isRunning = false;
      screenPollActive = false;
    }
  }

  async function runAllFiles(): Promise<TestRunResult> {
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

  async function runFileWithDeps(filePath: string, testFilter?: string, explicitProjectName?: string): Promise<void> {
    if (useParallel()) {
      // In parallel mode, run deps as waves then target file
      const project = projectForFile(filePath, explicitProjectName);
      if (!project || project.dependencies.length === 0 || !ctx.projects || !ctx.projectWaves) {
        await runFile(filePath, testFilter, explicitProjectName);
        return;
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
      broadcast({
        type: 'run-start',
        fileCount: depFileCount + 1,
        filePath,
        testFilter,
        projectName: project.name !== 'default' ? project.name : undefined,
      });

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
        const projectNameForBroadcast = project.name !== 'default' ? project.name : undefined;
        if (blockedBy) {
          broadcast({ type: 'error', message: `Skipping "${path.basename(filePath)}" — dependency "${blockedBy}" failed` });
          broadcastFileStatus(filePath, 'done', projectNameForBroadcast);
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
    return runFileWithDepsSingle(filePath, testFilter, explicitProjectName);
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

  function startWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined, emitEvent = true): void {
    let list = watchedEntries.get(filePath);
    const isNewFile = !list;
    if (!list) {
      list = [];
      watchedEntries.set(filePath, list);
    }
    if (findEntry(filePath, projectName, testFilter) >= 0) return;
    list.push({ projectName, testFilter });

    if (!watcher) {
      watcher = chokidarWatch([], { ignoreInitial: true });
      watcher.on('change', (changedPath) => {
        if (watchedEntries.has(changedPath)) {
          broadcast({ type: 'watch-event', filePath: changedPath, event: 'changed' });
          watchQueue.scheduleFiles([changedPath]);
        }
      });
    }

    if (isNewFile) watcher.add(filePath);
    if (emitEvent) {
      broadcast({ type: 'watch-event', filePath, testFilter, projectName, event: 'watch-enabled' });
    }
  }

  function stopWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined, emitEvent = true): void {
    const list = watchedEntries.get(filePath);
    const idx = findEntry(filePath, projectName, testFilter);
    if (!list || idx < 0) return;
    list.splice(idx, 1);
    if (list.length === 0) {
      watchedEntries.delete(filePath);
      watcher?.unwatch(filePath);
    }
    if (emitEvent) {
      broadcast({ type: 'watch-event', filePath, testFilter, projectName, event: 'watch-disabled' });
    }
  }

  /** Expand the watched entries for a file into concrete runs. Within a
   * project, a whole-file watch supersedes per-test watches (running the
   * file covers them). */
  function expandWatchedRuns(entries: WatchedEntry[]): Array<{ projectName: string | undefined; testFilter: string | undefined }> {
    const byProject = new Map<string, WatchedEntry[]>();
    for (const e of entries) {
      const key = e.projectName ?? '';
      let arr = byProject.get(key);
      if (!arr) { arr = []; byProject.set(key, arr); }
      arr.push(e);
    }
    const runs: Array<{ projectName: string | undefined; testFilter: string | undefined }> = [];
    for (const [, group] of byProject) {
      const wholeFile = group.find((e) => e.testFilter === undefined);
      if (wholeFile) {
        runs.push({ projectName: wholeFile.projectName, testFilter: undefined });
      } else {
        for (const e of group) runs.push({ projectName: e.projectName, testFilter: e.testFilter });
      }
    }
    return runs;
  }

  const watchQueue = new RunQueue(300, async (request) => {
    try {
      if (request.type === 'all') {
        await runAllFiles();
        return;
      }
      const file = request.files[0];
      if (!file) return;
      const entries = watchedEntries.get(file);
      if (!entries || entries.length === 0) {
        await runFile(file);
        return;
      }
      const runs = expandWatchedRuns(entries);
      // Parallel mode with multiple runs: dispatch as one batch so sibling
      // projects' workers can execute concurrently. The global `isRunning`
      // lock makes back-to-back `runFile` calls serialize — batching is
      // the only way to reach the parallelism the worker pool can offer.
      // Single-worker (or single-run) paths keep the simple sequential
      // shape since one device can only run one thing at a time.
      if (runs.length > 1 && useParallel()) {
        await ensureWorkersReady();
        const files: TaggedFile[] = runs.map((r) => {
          const project = projectForFile(file, r.projectName);
          return {
            filePath: file,
            projectUseOptions: project?.use as RunFileUseOptions | undefined,
            projectName: project && project.name !== 'default' ? project.name : undefined,
            testFilter: r.testFilter,
          };
        });
        await runBatchParallel(files);
        return;
      }
      for (const r of runs) {
        await runFile(file, r.testFilter, r.projectName);
      }
    } catch (err) {
      broadcastError(err);
    }
  });

  // ─── Command Handler ───

  function handleCommand(msg: ClientMessage): void {
    switch (msg.type) {
      case 'run-test':
        if (!ctx.testFiles.includes(msg.filePath)) break;
        if (msg.runDeps) runFileWithDeps(msg.filePath, msg.fullName, msg.projectName).catch(broadcastError);
        else runFile(msg.filePath, msg.fullName, msg.projectName).catch(broadcastError);
        break;
      case 'run-file':
        if (!ctx.testFiles.includes(msg.filePath)) break;
        if (msg.runDeps) runFileWithDeps(msg.filePath, undefined, msg.projectName).catch(broadcastError);
        else runFile(msg.filePath, undefined, msg.projectName).catch(broadcastError);
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
          // The 'all' toggle watches every file at whole-file scope,
          // unscoped by project (applies across all projects that include
          // the file).
          const allWhole = ctx.testFiles.every((f) => findEntry(f, undefined, undefined) >= 0);
          for (const f of ctx.testFiles) {
            if (allWhole) stopWatching(f, undefined, undefined);
            else startWatching(f, undefined, undefined);
          }
        } else if (msg.filePath === 'project' && msg.projectName) {
          // Watch every file within a specific project at whole-file scope.
          // Per-file events are suppressed so only the project-level icon
          // lights up in the UI — the child file icons stay dark. A single
          // project-scoped event is broadcast to flip the project node.
          const project = ctx.projects?.find((p) => p.name === msg.projectName);
          if (!project) break;
          const allWatched = project.testFiles.every((f) => findEntry(f, msg.projectName, undefined) >= 0);
          for (const f of project.testFiles) {
            if (allWatched) stopWatching(f, msg.projectName, undefined, false);
            else startWatching(f, msg.projectName, undefined, false);
          }
          broadcast({
            type: 'watch-event',
            filePath: 'project',
            projectName: msg.projectName,
            event: allWatched ? 'watch-disabled' : 'watch-enabled',
          });
        } else {
          const exists = findEntry(msg.filePath, msg.projectName, msg.testFilter) >= 0;
          if (exists) {
            stopWatching(msg.filePath, msg.projectName, msg.testFilter);
          } else {
            startWatching(msg.filePath, msg.projectName, msg.testFilter);
          }
        }
        break;
      case 'request-hierarchy': {
        const hierClient = multiWorker && workersInitialized
          ? uiWorkers.find((w) => w.id === selectedWorkerId && !w.retired)?.screenClient
          : ctx.client;
        hierClient?.getUiHierarchy().then(async (response) => {
          let xml = response.hierarchyXml;
          if (xml) {
            // Append WebView DOM hierarchy if a WebView is active (single-worker mode)
            const activeWebView = ctx.device?._activeWebView;
            if (activeWebView) {
              try {
                const webviewDom = await activeWebView._dumpDomHierarchy();
                if (webviewDom) {
                  const lastClose = xml.lastIndexOf('</');
                  if (lastClose !== -1) {
                    xml = xml.slice(0, lastClose) + webviewDom + '\n' + xml.slice(lastClose);
                  }
                }
              } catch { /* best-effort */ }
            }
            broadcast({ type: 'hierarchy-update', xml });
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
              serial: worker.displayName || worker.deviceSerial,
              model: undefined,
              isEmulator: worker.deviceSerial.startsWith('emulator-'),
              platform: resolveDevicePlatform(ctx, worker.deviceSerial),
              pilotVersion: PILOT_VERSION,
              devicePixelRatio: cachedScreenScale(worker.deviceSerial, resolveDevicePlatform(ctx, worker.deviceSerial)),
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
              serial: worker.displayName || worker.deviceSerial,
              model: undefined,
              isEmulator: worker.deviceSerial.startsWith('emulator-'),
              platform: resolveDevicePlatform(ctx, worker.deviceSerial),
              pilotVersion: PILOT_VERSION,
              devicePixelRatio: cachedScreenScale(worker.deviceSerial, resolveDevicePlatform(ctx, worker.deviceSerial)),
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
  if (options.devUrl) {
    spaHtml = buildDevShellHtml(options.devUrl);
    console.log(`${YELLOW}UI mode dev shell — loading SPA from ${options.devUrl} (HMR enabled)${RESET}`);
  } else {
    try {
      spaHtml = fs.readFileSync(SPA_HTML_PATH, 'utf-8');
    } catch {
      spaHtml = buildFallbackHtml();
    }
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
    ws.send(JSON.stringify(getMcpStatus()));

    if (multiWorker && workersInitialized) {
      // Send workers info
      ws.send(JSON.stringify({
        type: 'workers-info',
        workers: uiWorkers.map((w) => {
          const platform = resolveDevicePlatform(ctx, w.deviceSerial);
          return {
            workerId: w.id,
            deviceSerial: w.deviceSerial,
            displayName: w.displayName,
            platform,
            devicePixelRatio: cachedScreenScale(w.deviceSerial, platform),
          };
        }),
      } satisfies ServerMessage));

      // Send device info for selected worker
      const selectedWorker = uiWorkers.find((w) => w.id === selectedWorkerId);
      if (selectedWorker) {
        ws.send(JSON.stringify({
          type: 'device-info',
          serial: selectedWorker.displayName || selectedWorker.deviceSerial,
          model: undefined,
          isEmulator: selectedWorker.deviceSerial.startsWith('emulator-'),
          platform: resolveDevicePlatform(ctx, selectedWorker.deviceSerial),
          pilotVersion: PILOT_VERSION,
          devicePixelRatio: cachedScreenScale(selectedWorker.deviceSerial, resolveDevicePlatform(ctx, selectedWorker.deviceSerial)),
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
        serial: singleWorkerDisplayName ?? ctx.deviceSerial,
        model: undefined,
        isEmulator: ctx.deviceSerial.startsWith('emulator-'),
        platform: ctx.config.platform,
        pilotVersion: PILOT_VERSION,
        devicePixelRatio: cachedScreenScale(ctx.deviceSerial, ctx.config.platform),
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
  // ─── MCP Server (separate fixed port) ───

  const MCP_DEFAULT_PORT = 9274;
  const mcpHttpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // SSE endpoint — GET establishes SSE stream
    if (url.pathname === '/mcp' && req.method === 'GET') {
      if (mcpTransport) {
        // Close old session so the new client can connect
        mcpTransport.close();
        mcpTransport = null;
      }
      mcpTransport = new SSEServerTransport('/mcp/message', res);
      mcpServer.connect(mcpTransport).catch(() => {
        mcpTransport = null;
      });
      return;
    }

    // Message endpoint — POST sends JSON-RPC messages
    if (url.pathname === '/mcp/message' && req.method === 'POST') {
      if (!mcpTransport) {
        res.writeHead(400);
        res.end('No active MCP session');
        return;
      }
      mcpTransport.handlePostMessage(req, res);
      return;
    }

    // Event ingest from standalone `pilot mcp-server`
    if (url.pathname === '/mcp-events' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          broadcast({ type: 'mcp-tool-call', ...event });
        } catch { /* ignore malformed */ }
        res.writeHead(200);
        res.end('OK');
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  mcpPort = MCP_DEFAULT_PORT;
  try {
    await new Promise<void>((resolve, reject) => {
      mcpHttpServer.listen(MCP_DEFAULT_PORT, '127.0.0.1', resolve);
      mcpHttpServer.on('error', reject);
    });
  } catch {
    // Port in use — fall back to a random port
    mcpPort = await new Promise<number>((resolve, reject) => {
      mcpHttpServer.listen(0, '127.0.0.1', () => {
        const addr = mcpHttpServer.address();
        if (typeof addr === 'object' && addr) resolve(addr.port);
        else reject(new Error('Failed to bind MCP server'));
      });
      mcpHttpServer.on('error', reject);
    });
  }

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
  console.log(`\x1b[2mMCP server available at http://127.0.0.1:${mcpPort}/mcp\x1b[0m`);

  // Write port file for standalone MCP server discovery
  const { uiPortFilePath } = await import('../mcp/port-file.js');
  const portFilePath = uiPortFilePath();
  try {
    fs.writeFileSync(portFilePath, String(mcpPort));
  } catch {
    // Non-fatal
  }

  // Send device info (single-worker)
  if (!multiWorker && ctx.deviceSerial) {
    broadcast({
      type: 'device-info',
      serial: singleWorkerDisplayName ?? ctx.deviceSerial,
      model: undefined,
      isEmulator: ctx.deviceSerial.startsWith('emulator-'),
      platform: ctx.config.platform,
      pilotVersion: PILOT_VERSION,
      devicePixelRatio: cachedScreenScale(ctx.deviceSerial, ctx.config.platform),
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

      if (mcpTransport) mcpTransport.close();
      mcpServer.close();
      mcpHttpServer.close();
      try { fs.unlinkSync(portFilePath); } catch { /* already gone */ }
      if (watcher) watcher.close();
      for (const ws of clients) ws.close();
      wss.close();
      server.close();

      preserveEmulatorsForReuse(ctx.launchedEmulators);
    },
  };
}

// ─── Dev-shell HTML ───

/**
 * HTML shell used in dev mode: points the browser at a running Vite dev
 * server for the SPA modules while the WebSocket still talks to this server.
 */
function buildDevShellHtml(devUrl: string): string {
  // Validate as a URL (fail loudly on garbage) and escape for an attribute
  // context before interpolation. The value comes from a CLI flag / env var
  // and isn't attacker-controlled in any realistic threat model, but an
  // unescaped interpolation would trip future linters and make this
  // function unsafe if anyone ever wires in untrusted input.
  let base: string;
  try {
    const u = new URL(devUrl);
    base = u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid --ui-dev-url: ${devUrl}`);
  }
  // Covers both attribute-context delimiters (double + single quote) so the
  // helper stays safe if the template below ever switches to single quotes.
  const attr = (s: string) => s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pilot UI Mode (dev)</title>
  <script type="module" src="${attr(base)}/@vite/client"></script>
  <script type="module" src="${attr(base)}/main.tsx"></script>
</head>
<body>
  <div id="app"></div>
</body>
</html>`;
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
