import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { resolveProjects, topologicalSort, type ResolvedProject } from '../project.js';
import { discoverTestFiles } from '../test-file-discovery.js';
import {
  deserializeTestResult,
  deserializeSuiteResult,
  serializeConfig,
  type SerializedConfig,
  type RunFileUseOptions,
} from '../worker-protocol.js';
import type { WatchRunMessage, WatchRunChildMessage } from '../watch-run.js';
import { RunQueue } from '../watch-queue.js';
import { ensureConnected, getAllDaemonAddresses, listAllDevices } from './connection.js';
import type {
  TestDispatcher,
  TestRunResult,
  TestResultEntry,
  TestTreeEntry,
  SessionInfo,
  TestFailureDetail,
} from './test-dispatcher.js';
import { loadMcpConfig } from './config-loader.js';
import type { TestTreeNode, UIDiscoverMessage, UIDiscoverChildMessage } from '../ui-mode/ui-protocol.js';

const DISCOVERY_CONCURRENCY = 4;
const DISCOVERY_TIMEOUT_MS = 30_000;
const RUN_CHILD_TIMEOUT_MS = 60 * 60 * 1000;

// ─── HeadlessTestDispatcher ───

export class HeadlessTestDispatcher implements TestDispatcher {
  private readonly _configFile?: string;
  private _config: import('../config.js').TapsmithConfig | null = null;
  private _projects: ResolvedProject[] = [];
  private _projectWaves: ResolvedProject[][] = [];
  private _testFiles: string[] = [];
  private _testTree: TestTreeEntry[] = [];
  private _testResults = new Map<string, TestResultEntry>();
  private _isRunning = false;
  private _stopRequested = false;
  private _lastRunEnd: TestRunResult | null = null;
  private readonly _runEndWaiters: Array<(r: TestRunResult) => void> = [];
  private _activeChild: ChildProcess | null = null;
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _daemonAddress: string | null = null;
  private _deviceSerial: string | null = null;
  private _serializedConfig: SerializedConfig | null = null;
  private _watcher: FSWatcher | null = null;
  private _watchedEntries = new Map<string, WatchedEntry[]>();
  private _watchQueue: RunQueue;
  private _scripts: ResolvedScripts | null = null;

  constructor(options?: { configFile?: string }) {
    this._configFile = options?.configFile;
    this._watchQueue = new RunQueue(300, (request) => {
      const run = request.type === 'all'
        ? this.runAll()
        : this.runFiles(request.files);
      run.catch((err) => {
        log(`Watch run error: ${err instanceof Error ? err.message : err}`);
      }).finally(() => {
        this._watchQueue.notifyRunFinished();
      });
    });
  }

  // ─── TestDispatcher interface ───

  async ensureInitialized(): Promise<void> {
    await this._ensureInitialized();
  }

  async runFiles(files: string[], options?: { testFilter?: string; project?: string }): Promise<TestRunResult> {
    await this._ensureInitialized();
    if (this._isRunning) {
      return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    }

    const { testFilter, project } = options ?? {};
    const validFiles = files.filter((f) => this._testFiles.includes(f));
    if (validFiles.length === 0) {
      return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    }

    this._isRunning = true;
    this._stopRequested = false;
    this._testResults.clear();
    try {
      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;
      for (const f of validFiles) {
        if (this._stopRequested) break;
        const proj = this._projectForFile(f, project);
        const useOptions = proj?.use as RunFileUseOptions | undefined;
        const projectName = proj && proj.name !== 'default' ? proj.name : undefined;
        try {
          const { results, suite } = await this._runFileInChild(
            f, useOptions, projectName, validFiles.length === 1 ? testFilter : undefined,
          );
          totalPassed += results.filter((r) => r.status === 'passed').length;
          totalFailed += results.filter((r) => r.status === 'failed').length;
          totalSkipped += results.filter((r) => r.status === 'skipped').length;
          totalDuration += suite.durationMs;
        } catch (err) {
          totalFailed++;
          log(`Error running ${path.basename(f)}: ${err instanceof Error ? err.message : err}`);
        }
      }
      return this._finishRun(this._withFailures({
        status: this._stopRequested ? 'stopped' : totalFailed > 0 ? 'failed' : 'passed',
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        duration: totalDuration,
      }));
    } finally {
      this._endRunState();
    }
  }

  async runAll(): Promise<TestRunResult> {
    await this._ensureInitialized();
    if (this._isRunning) {
      return { status: 'failed', passed: 0, failed: 0, skipped: 0, duration: 0 };
    }

    this._isRunning = true;
    this._stopRequested = false;
    this._testResults.clear();
    try {
      let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0;

      if (this._hasRealProjects() && this._projectWaves.length > 0) {
        const failedProjects = new Set<string>();

        for (const wave of this._projectWaves) {
          if (this._stopRequested) break;
          for (const project of wave) {
            if (this._stopRequested) break;
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d));
            if (blockedBy) {
              failedProjects.add(project.name);
              continue;
            }

            const useOptions = project.use as RunFileUseOptions | undefined;
            const projectName = project.name !== 'default' ? project.name : undefined;
            let projectFailed = false;

            for (const file of project.testFiles) {
              if (this._stopRequested) break;
              try {
                const { results, suite } = await this._runFileInChild(file, useOptions, projectName);
                totalPassed += results.filter((r) => r.status === 'passed').length;
                totalFailed += results.filter((r) => r.status === 'failed').length;
                totalSkipped += results.filter((r) => r.status === 'skipped').length;
                totalDuration += suite.durationMs;
                if (results.some((r) => r.status === 'failed')) projectFailed = true;
              } catch (err) {
                totalFailed++;
                projectFailed = true;
                log(`Error running ${path.basename(file)}: ${err instanceof Error ? err.message : err}`);
              }
            }

            if (projectFailed) failedProjects.add(project.name);
          }
        }
      } else {
        for (const file of this._testFiles) {
          if (this._stopRequested) break;
          try {
            const { results, suite } = await this._runFileInChild(file);
            totalPassed += results.filter((r) => r.status === 'passed').length;
            totalFailed += results.filter((r) => r.status === 'failed').length;
            totalSkipped += results.filter((r) => r.status === 'skipped').length;
            totalDuration += suite.durationMs;
          } catch (err) {
            totalFailed++;
            log(`Error running ${path.basename(file)}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      return this._finishRun(this._withFailures({
        status: this._stopRequested ? 'stopped' : totalFailed > 0 ? 'failed' : 'passed',
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
        duration: totalDuration,
      }));
    } finally {
      this._endRunState();
    }
  }

  stop(): void {
    if (!this._isRunning) return;
    this._stopRequested = true;
    if (this._activeChild) {
      try { this._activeChild.kill(); } catch { /* already dead */ }
    }
  }

  waitForRunEnd(timeoutMs: number): Promise<TestRunResult | null> {
    if (!this._isRunning) return Promise.resolve(this._lastRunEnd);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this._runEndWaiters.push((r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  isRunning(): boolean {
    return this._isRunning;
  }

  /** Record the final result and wake waitForRunEnd callers. */
  private _finishRun(result: TestRunResult): TestRunResult {
    this._lastRunEnd = result;
    for (const w of this._runEndWaiters.splice(0)) w(result);
    return result;
  }

  /** Run-state teardown; resolves any waiters left by an exception path. */
  private _endRunState(): void {
    this._isRunning = false;
    this._stopRequested = false;
    if (this._runEndWaiters.length > 0) {
      const fallback = this._lastRunEnd ?? { status: 'stopped' as const, passed: 0, failed: 0, skipped: 0, duration: 0 };
      for (const w of this._runEndWaiters.splice(0)) w(fallback);
    }
  }

  getResults(): TestResultEntry[] {
    return [...this._testResults.values()];
  }

  getTestFiles(): string[] {
    return this._testFiles;
  }

  getProjects(): string[] {
    return this._projects
      .filter((p) => p.name !== 'default')
      .map((p) => p.name);
  }

  getTestTree(): TestTreeEntry[] {
    return this._testTree;
  }

  getSessionInfo(): SessionInfo {
    const projects = this._projects
      .filter((p) => p.name !== 'default')
      .map((p) => ({
        name: p.name,
        platform: p.effectiveConfig.platform,
        package: p.effectiveConfig.package,
        testFiles: p.testFiles,
        dependencies: p.dependencies,
      }));
    return {
      platform: this._config?.platform,
      package: this._config?.package,
      device: this._deviceSerial ?? undefined,
      timeout: this._config?.timeout ?? 30_000,
      retries: this._config?.retries ?? 0,
      projects,
    };
  }

  toggleWatch(filePath: string, options?: { testFilter?: string; project?: string }): { enabled: boolean } {
    const { testFilter, project: projectName } = options ?? {};
    const existing = this._findWatchEntry(filePath, projectName, testFilter);
    if (existing >= 0) {
      this._stopWatching(filePath, projectName, testFilter);
      return { enabled: false };
    }
    this._startWatching(filePath, projectName, testFilter);
    return { enabled: true };
  }

  dispose(): void {
    if (this._activeChild) {
      try { this._activeChild.kill(); } catch { /* already dead */ }
    }
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    this._watchedEntries.clear();
  }

  // ─── Lazy initialization ───

  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    if (this._initPromise) {
      await this._initPromise;
      return;
    }
    this._initPromise = this._initialize();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  private async _initialize(): Promise<void> {
    log('Initializing test dispatcher...');

    const config = await this._loadConfigWithFallback();
    this._config = config;

    if (config) {
      try {
        this._projects = resolveProjects(config);
        this._projectWaves = topologicalSort(this._projects);
      } catch {
        this._projects = [];
        this._projectWaves = [];
      }

      if (this._hasRealProjects()) {
        const seen = new Set<string>();
        for (const project of this._projects) {
          const files = await discoverTestFiles(
            project.testMatch,
            config.rootDir,
            undefined,
            project.testIgnore,
          );
          project.testFiles = files;
          for (const f of files) {
            if (!seen.has(f)) {
              seen.add(f);
              this._testFiles.push(f);
            }
          }
        }
      } else {
        this._testFiles = await discoverTestFiles(config.testMatch, config.rootDir);
      }
    }

    // Resolve daemon/device connection
    try {
      await ensureConnected(config?.device);
      this._daemonAddress = getAllDaemonAddresses();
      if (config?.device) {
        this._deviceSerial = config.device;
      } else {
        const devices = await listAllDevices();
        const active = devices.find((d) => d.state === 'Active' || d.state === 'online')
          ?? devices.find((d) => d.state === 'Discovered');
        this._deviceSerial = active?.serial ?? devices[0]?.serial ?? null;
      }
    } catch (err) {
      log(`Warning: daemon/device setup failed: ${err instanceof Error ? err.message : err}`);
    }

    if (config) {
      this._serializedConfig = serializeConfig(config);
    }

    this._scripts = resolveScripts();

    // Discover test tree
    if (this._testFiles.length > 0 && this._scripts) {
      await this._discoverTestTree();
    }

    this._initialized = true;
    log(`Initialized: ${this._testFiles.length} test file(s), device=${this._deviceSerial ?? 'none'}`);
  }

  // ─── Test tree discovery ───

  private async _discoverTestTree(): Promise<void> {
    const scripts = this._scripts!;
    const fileNodes = new Map<string, TestTreeNode>();

    const discovered = await mapWithConcurrency(this._testFiles, DISCOVERY_CONCURRENCY, async (file) => {
      const tree = await discoverFile(file, scripts);
      return { file, tree };
    });
    for (const { file, tree } of discovered) {
      if (tree) fileNodes.set(file, tree);
    }

    if (this._hasRealProjects()) {
      const trees: TestTreeEntry[] = [];
      for (const project of this._projects) {
        const children: TestTreeEntry[] = [];
        for (const file of project.testFiles) {
          const node = fileNodes.get(file);
          if (node) children.push(toTreeEntry(node));
        }
        if (children.length > 0) {
          trees.push({
            type: 'project',
            name: project.name,
            fullName: project.name,
            filePath: '',
            status: 'idle',
            children,
          });
        }
      }
      this._testTree = trees;
    } else {
      this._testTree = [...fileNodes.values()].map(toTreeEntry);
    }
  }

  // ─── Test execution ───

  private _runFileInChild(
    filePath: string,
    projectUseOptions?: RunFileUseOptions,
    projectName?: string,
    testFilter?: string,
  ): Promise<RunFileChildResult> {
    if (!this._daemonAddress || !this._deviceSerial || !this._serializedConfig) {
      return Promise.reject(new Error('No device connected. Ensure a device/emulator is available and a daemon is running.'));
    }

    const scripts = this._scripts!;
    return new Promise((resolve, reject) => {
      const child = fork(scripts.watchRunScript, [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        ...(scripts.tsxBin ? { execPath: scripts.tsxBin } : {}),
        env: {
          ...process.env,
          NODE_PATH: path.resolve(scripts.baseDir, '..'),
        },
      });

      this._activeChild = child;
      let settled = false;
      const clearActiveChild = (): void => {
        if (this._activeChild === child) this._activeChild = null;
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearActiveChild();
        try { child.kill(); } catch { /* already dead */ }
        reject(new Error(`Watch worker timed out after ${RUN_CHILD_TIMEOUT_MS}ms`));
      }, RUN_CHILD_TIMEOUT_MS);
      timeout.unref?.();
      const resolveOnce = (value: RunFileChildResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const rejectOnce = (err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearActiveChild();
        reject(err);
      };

      child.on('message', (response: WatchRunChildMessage) => {
        if (settled) return;

        switch (response.type) {
          case 'test-end': {
            const result = deserializeTestResult(response.result);
            if (testFilter && result.status === 'skipped' && result.fullName !== testFilter) break;
            const key = projectName ? `${projectName}::${result.fullName}` : result.fullName;
            this._testResults.set(key, {
              fullName: result.fullName,
              filePath,
              status: result.status,
              duration: result.durationMs,
              error: result.error?.message,
              tracePath: result.tracePath,
              videoPath: result.videoPath,
              projectName,
            });
            break;
          }
          case 'file-done': {
            const results = response.results.map(deserializeTestResult);
            const suite = deserializeSuiteResult(response.suite);
            resolveOnce({ results, suite });
            break;
          }
          case 'error':
            rejectOnce(new Error(response.error.message));
            break;
        }
      });

      child.on('exit', (code) => {
        if (!settled) {
          rejectOnce(new Error(`Watch worker exited with code ${code ?? 0} without sending results`));
        } else {
          clearActiveChild();
        }
      });

      child.on('error', (err) => {
        rejectOnce(err);
      });

      // Non-null safe: validated at top of _runFileInChild before the fork
      const msg: WatchRunMessage = {
        type: 'run',
        daemonAddress: this._daemonAddress!,
        deviceSerial: this._deviceSerial!,
        filePath,
        config: this._serializedConfig!,
        screenshotDir: undefined,
        projectUseOptions,
        projectName,
      };

      child.send(msg);
    });
  }

  // ─── Watch mode ───

  private _startWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined): void {
    let list = this._watchedEntries.get(filePath);
    const isNewFile = !list;
    if (!list) {
      list = [];
      this._watchedEntries.set(filePath, list);
    }
    if (this._findWatchEntry(filePath, projectName, testFilter) >= 0) return;
    list.push({ projectName, testFilter });

    if (!this._watcher) {
      this._watcher = chokidarWatch([], { ignoreInitial: true });
      this._watcher.on('change', (changedPath) => {
        if (this._watchedEntries.has(changedPath)) {
          this._watchQueue.scheduleFiles([changedPath]);
        }
      });
    }

    if (isNewFile) this._watcher.add(filePath);
  }

  private _stopWatching(filePath: string, projectName: string | undefined, testFilter: string | undefined): void {
    const list = this._watchedEntries.get(filePath);
    const idx = this._findWatchEntry(filePath, projectName, testFilter);
    if (!list || idx < 0) return;
    list.splice(idx, 1);
    if (list.length === 0) {
      this._watchedEntries.delete(filePath);
      this._watcher?.unwatch(filePath);
    }
  }

  private _findWatchEntry(filePath: string, projectName: string | undefined, testFilter: string | undefined): number {
    const list = this._watchedEntries.get(filePath);
    if (!list) return -1;
    return list.findIndex((e) =>
      (e.projectName ?? null) === (projectName ?? null) &&
      (e.testFilter ?? null) === (testFilter ?? null),
    );
  }

  // ─── Config discovery ───

  private async _loadConfigWithFallback(): Promise<import('../config.js').TapsmithConfig | null> {
    return loadMcpConfig(this._configFile)
      .then((result) => {
        if (result.configPath) log(`Using config: ${path.relative(process.cwd(), result.configPath) || result.configPath}`);
        return result.config;
      })
      .catch((err) => {
        log(`Warning: failed to load config: ${err instanceof Error ? err.message : err}`);
        return null;
      });
  }

  // ─── Helpers ───

  private _hasRealProjects(): boolean {
    return this._projects.length > 0
      && !(this._projects.length === 1 && this._projects[0].name === 'default');
  }

  private _projectForFile(filePath: string, explicitProjectName?: string): ResolvedProject | undefined {
    if (explicitProjectName) {
      const byName = this._projects.find((p) => p.name === explicitProjectName);
      if (byName) return byName;
    }
    return this._projects.find((p) => p.testFiles.includes(filePath));
  }

  private _collectFailures(): TestFailureDetail[] {
    return [...this._testResults.values()]
      .filter((r) => r.status === 'failed' && r.error)
      .map((r) => ({
        fullName: r.fullName,
        filePath: r.filePath,
        error: r.error!,
        tracePath: r.tracePath,
        projectName: r.projectName,
      }));
  }

  private _withFailures(result: TestRunResult): TestRunResult {
    if (result.failed > 0) result.failures = this._collectFailures();
    return result;
  }
}

// ─── Shared utilities ───

interface WatchedEntry {
  projectName?: string
  testFilter?: string
}

interface ResolvedScripts {
  watchRunScript: string
  discoverScript: string
  tsxBin?: string
  baseDir: string
}

type RunFileChildResult = {
  results: import('../runner.js').TestResult[]
  suite: import('../runner.js').SuiteResult
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

function resolveScripts(): ResolvedScripts {
  // import.meta.dirname is either src/mcp/ or dist/mcp/
  // watch-run is at src/watch-run.ts or dist/watch-run.js
  // ui-discover is at src/ui-mode/ui-discover.ts or dist/ui-mode/ui-discover.js
  const baseDir = path.resolve(import.meta.dirname, '..');

  const jsWatchRun = path.resolve(baseDir, 'watch-run.js');
  const tsWatchRun = path.resolve(baseDir, 'watch-run.ts');
  const watchRunScript = !fs.existsSync(jsWatchRun) && fs.existsSync(tsWatchRun)
    ? tsWatchRun
    : jsWatchRun;

  const jsDiscover = path.resolve(baseDir, 'ui-mode', 'ui-discover.js');
  const tsDiscover = path.resolve(baseDir, 'ui-mode', 'ui-discover.ts');
  const discoverScript = !fs.existsSync(jsDiscover) && fs.existsSync(tsDiscover)
    ? tsDiscover
    : jsDiscover;

  let tsxBin: string | undefined;
  if (watchRunScript.endsWith('.ts') || discoverScript.endsWith('.ts')) {
    const tapsmithPkgDir = path.resolve(baseDir, '..');
    const localTsx = path.join(tapsmithPkgDir, 'node_modules', '.bin', 'tsx');
    tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';
  }

  return { watchRunScript, discoverScript, tsxBin, baseDir };
}

function discoverFile(filePath: string, scripts: ResolvedScripts): Promise<TestTreeNode | null> {
  return new Promise((resolve) => {
    const child = fork(scripts.discoverScript, [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      ...(scripts.tsxBin ? { execPath: scripts.tsxBin } : {}),
      env: {
        ...process.env,
        NODE_PATH: path.resolve(scripts.baseDir, '..'),
      },
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`Discovery timed out for ${filePath} after ${DISCOVERY_TIMEOUT_MS}ms`);
      try { child.kill(); } catch { /* already dead */ }
      resolve(null);
    }, DISCOVERY_TIMEOUT_MS);
    timeout.unref?.();
    const settle = (tree: TestTreeNode | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(tree);
    };

    child.on('message', (response: UIDiscoverChildMessage) => {
      if (settled) return;

      if (response.type === 'discover-result') {
        settle(response.tree);
      } else {
        log(`Discovery error for ${filePath}: ${response.error.message}`);
        settle(null);
      }
    });

    child.on('exit', () => {
      if (!settled) {
        settle(null);
      }
    });

    child.on('error', () => {
      if (!settled) {
        settle(null);
      }
    });

    const msg: UIDiscoverMessage = { type: 'discover', filePath };
    child.send(msg);
  });
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

function log(msg: string): void {
  process.stderr.write(`[tapsmith-mcp] ${msg}\n`);
}
