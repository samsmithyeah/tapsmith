import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { resolveChildLoader } from '../child-scripts.js';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { minimatch } from 'minimatch';
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
import { ensurePlatformTarget, type PlatformTarget } from './connection.js';
import type { TapsmithConfig } from '../config.js';
import { matchesTestFilter } from '../test-filter.js';
import type {
  TestDispatcher,
  TestRunResult,
  TestResultEntry,
  TestTreeEntry,
  SessionInfo,
  TestFailureDetail,
  DiscoveryError,
  DeviceTarget,
} from './test-dispatcher.js';
import { loadMcpConfig } from './config-loader.js';
import type { TestTreeNode, UIDiscoverMessage, UIDiscoverChildMessage } from '../ui-mode/ui-protocol.js';

/** Key for a session with no platform of its own (single-platform configs). */
const DEFAULT_PLATFORM_KEY = 'default';

function platformKey(platform?: string): string {
  return platform ?? DEFAULT_PLATFORM_KEY;
}

/**
 * Which platform's device a run belongs on.
 *
 * A project's own platform wins: in a multi-platform config the root has none,
 * which is exactly the case that used to leave every run pointing at whichever
 * device the session picked first.
 *
 * @internal — exported for unit testing.
 */
export function platformKeyForProject(
  projects: Array<{ name: string; effectiveConfig: { platform?: string } }>,
  projectName: string | undefined,
  rootPlatform: string | undefined,
): string {
  const project = projectName ? projects.find((p) => p.name === projectName) : undefined;
  return platformKey(project?.effectiveConfig.platform ?? rootPlatform);
}

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
  private _deviceSerial: string | null = null;
  private _serializedConfig: SerializedConfig | null = null;
  private _watcher: FSWatcher | null = null;
  private _watchedEntries = new Map<string, WatchedEntry[]>();
  private _watchQueue: RunQueue;
  private _scripts: ResolvedScripts | null = null;
  private _discoveryErrors = new Map<string, string>();
  private _configPath: string | null = null;
  private _configWarning: string | null = null;
  /** Daemon + device per platform, keyed by platform (or DEFAULT_PLATFORM_KEY). */
  private _targets = new Map<string, PlatformTarget>();
  /** Why a platform has no target, kept so a run for it can say so. */
  private _targetErrors = new Map<string, string>();
  /** Per-project serialized configs handed to workers, built on first use. */
  private _projectConfigs = new Map<string, SerializedConfig>();

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
    const validFiles = this.resolveRequestedFiles(files);
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
        const projectName = this._realProjectName(proj);
        try {
          const { results, suite } = await this._runFileInChild(
            f, useOptions, projectName, testFilter,
          );
          totalPassed += results.filter((r) => r.status === 'passed').length;
          totalFailed += results.filter((r) => r.status === 'failed').length;
          totalSkipped += results.filter((r) => r.status === 'skipped').length;
          totalDuration += suite.durationMs;
        } catch (err) {
          totalFailed++;
          this._recordFileError(f, projectName, err);
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
            const projectName = this._realProjectName(project);
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
                this._recordFileError(file, projectName, err);
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
            this._recordFileError(file, undefined, err);
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
      const waiter = (r: TestRunResult): void => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        // Drop the stale waiter so repeated polls of a wedged run don't
        // accumulate closures until the run finally ends.
        const idx = this._runEndWaiters.indexOf(waiter);
        if (idx >= 0) this._runEndWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this._runEndWaiters.push(waiter);
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

  /** Run-state teardown; resolves any waiters left by an exception path.
   * Always a fresh synthetic result — falling back to _lastRunEnd would
   * report the PREVIOUS run's outcome. */
  private _endRunState(): void {
    this._isRunning = false;
    this._stopRequested = false;
    if (this._runEndWaiters.length > 0) {
      const fallback: TestRunResult = { status: 'stopped', passed: 0, failed: 0, skipped: 0, duration: 0 };
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

  /**
   * Map the caller's `files` onto discovered test files.
   *
   * Callers reasonably pass a path relative to the project, or a glob — both
   * used to match nothing and surface as "no tests executed", which reads
   * exactly like a suite that ran and found nothing to do.
   */
  resolveRequestedFiles(files: string[]): string[] {
    const roots = [this._config?.rootDir, process.cwd()].filter((r): r is string => Boolean(r));
    return matchRequestedFiles(files, this._testFiles, roots);
  }

  getDiscoveryErrors(): DiscoveryError[] {
    return [...this._discoveryErrors].map(([filePath, error]) => ({ filePath, error }));
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
      deviceTargets: this._deviceTargets(),
      configPath: this._configPath ?? undefined,
      configWarning: this._configWarning ?? undefined,
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

    await this._resolvePlatformTargets(config);

    if (config) {
      this._serializedConfig = serializeConfig(config);
    }

    this._scripts = resolveScripts(this._testFiles);

    // Discover test tree
    if (this._testFiles.length > 0 && this._scripts) {
      await this._discoverTestTree();
    }

    this._initialized = true;
    log(`Initialized: ${this._testFiles.length} test file(s), device=${this._deviceSerial ?? 'none'}`);
  }

  // ─── Device targets ───

  /**
   * Resolve a daemon + device + agent for every platform the session runs on.
   *
   * A multi-platform config carries its platforms on the projects, not at the
   * top level, so a single session-wide device was both arbitrary (whichever
   * device a daemon happened to list first) and unusable for iOS, whose agent
   * needs platform-specific artifacts. One target per platform fixes both.
   *
   * A platform that cannot be satisfied (no emulator running, say) is recorded
   * rather than thrown: the other platform's tests still run, and a request for
   * the missing one fails with the reason.
   */
  private async _resolvePlatformTargets(config: TapsmithConfig | null): Promise<void> {
    this._targets.clear();
    this._targetErrors.clear();
    if (!config) return;

    const wanted = this._hasRealProjects()
      ? [...new Map(this._projects.map((p) => [platformKey(p.effectiveConfig.platform), p.effectiveConfig])).values()]
      : [config];

    for (const effective of wanted) {
      const key = platformKey(effective.platform);
      try {
        const target = await ensurePlatformTarget(effective);
        this._targets.set(key, target);
        log(`Using ${key === DEFAULT_PLATFORM_KEY ? 'device' : `${key} device`} ${target.deviceSerial} via ${target.address}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this._targetErrors.set(key, message);
        log(`Warning: ${key === DEFAULT_PLATFORM_KEY ? 'device' : key} setup failed: ${message}`);
      }
    }

    this._deviceSerial = [...this._targets.values()][0]?.deviceSerial ?? null;
  }

  /**
   * The config a project's worker runs under.
   *
   * The worker's session preflight (app launch, agent checks) reads the config
   * it is handed, so handing it the *root* config left a project's platform,
   * app bundle and agent artifacts behind — everything a multi-platform config
   * keeps in `use`. The project's effective config carries all of it.
   */
  private _configForProject(projectName?: string): SerializedConfig {
    if (!projectName) return this._serializedConfig!;
    const cached = this._projectConfigs.get(projectName);
    if (cached) return cached;

    const project = this._projects.find((p) => p.name === projectName);
    const serialized = project ? serializeConfig(project.effectiveConfig) : this._serializedConfig!;
    this._projectConfigs.set(projectName, serialized);
    return serialized;
  }

  /**
   * A project's name, or `undefined` for the synthetic project `resolveProjects`
   * invents when a config declares none.
   *
   * Testing the name alone would also swallow a project a user actually named
   * "default" — which then routes to no platform target and no per-project
   * config, so every one of its files fails with "No device is configured"
   * despite a healthy device.
   */
  private _realProjectName(project?: ResolvedProject): string | undefined {
    if (!project || !this._hasRealProjects()) return undefined;
    return project.name;
  }

  /** Every platform this session runs on, with its device or its failure. */
  private _deviceTargets(): DeviceTarget[] {
    const toPlatform = (key: string): string | undefined =>
      key === DEFAULT_PLATFORM_KEY ? undefined : key;
    return [
      ...[...this._targets].map(([key, t]) => ({ platform: toPlatform(key), device: t.deviceSerial })),
      ...[...this._targetErrors].map(([key, error]) => ({ platform: toPlatform(key), error })),
    ];
  }

  /**
   * The daemon/device a project's tests must run against.
   *
   * Never substitutes another platform's target. A missing iOS device must
   * surface as "boot a simulator", not quietly run the iOS suite against an
   * Android emulator, where every assertion fails for reasons that look
   * nothing like the actual problem.
   */
  private _targetForProject(projectName?: string): PlatformTarget {
    const key = platformKeyForProject(this._projects, projectName, this._config?.platform);
    return selectPlatformTarget(key, this._targets, this._targetErrors);
  }

  // ─── Test tree discovery ───

  private async _discoverTestTree(): Promise<void> {
    const scripts = this._scripts!;
    const fileNodes = new Map<string, TestTreeNode>();
    this._discoveryErrors.clear();

    const discovered = await mapWithConcurrency(this._testFiles, DISCOVERY_CONCURRENCY, async (file) => {
      const { tree, error } = await discoverFile(file, scripts);
      return { file, tree, error };
    });
    for (const { file, tree, error } of discovered) {
      if (tree) fileNodes.set(file, tree);
      // A file that fails to load has no tests to show, so it would otherwise
      // vanish from the tree with nothing to distinguish it from a file that
      // genuinely holds no tests. Keep the reason for the caller.
      else this._discoveryErrors.set(file, error ?? 'Discovery failed (no result returned)');
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
    if (!this._serializedConfig) {
      return Promise.reject(new Error('No Tapsmith config is loaded, so there is nothing to run against.'));
    }

    let target: PlatformTarget;
    let serializedConfig: SerializedConfig;
    try {
      target = this._targetForProject(projectName);
      serializedConfig = this._configForProject(projectName);
    } catch (err) {
      return Promise.reject(err);
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
            if (testFilter && result.status === 'skipped' && !matchesTestFilter(result.fullName, testFilter)) break;
            const key = resultEntryKey(projectName, filePath, result.fullName);
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

      // One address, not the pool: a multi-platform session runs several
      // daemons, and the child connects to exactly one.
      const msg: WatchRunMessage = {
        type: 'run',
        daemonAddress: target.address,
        deviceSerial: target.deviceSerial,
        filePath,
        config: serializedConfig,
        screenshotDir: undefined,
        projectUseOptions,
        projectName,
        testFilter,
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
        this._configPath = result.configPath ?? null;
        // Kept for every tool that reports session state: a synthesized config
        // looks exactly like a real one in the tool output, so the session must
        // carry the reason it has none rather than logging it once to stderr
        // that no MCP client ever reads.
        this._configWarning = result.warning ?? null;
        if (result.configPath) log(`Using config: ${path.relative(process.cwd(), result.configPath) || result.configPath}`);
        if (result.warning) log(`Warning: ${result.warning}`);
        return result.config;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this._configPath = null;
        this._configWarning = `Failed to load the Tapsmith config: ${message}`;
        log(`Warning: failed to load config: ${message}`);
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

  /**
   * Record a failure that killed a whole file before any test could report —
   * an import error, a missing module, a crashed or timed-out worker.
   *
   * The message used to go to stderr only, which an MCP client never sees: the
   * caller got `0 passed, 1 failed` with no cause, and `tapsmith_list_results`
   * showed nothing at all. Storing it as a result entry puts it in front of
   * every consumer — the run's failure details, the results list, and the
   * accumulated suite board.
   */
  private _recordFileError(filePath: string, projectName: string | undefined, err: unknown): void {
    const entry = fileFailureEntry(filePath, projectName, err);
    this._testResults.set(resultEntryKey(projectName, filePath, entry.fullName), entry);
    log(`Error running ${path.basename(filePath)}: ${entry.error}`);
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

/**
 * Key for the per-test result map. A test's `fullName` is only unique within a
 * single file (it's the `describe > test` chain), so the file path must be part
 * of the key — otherwise same-named tests in different files collide and earlier
 * files' results are silently overwritten in a multi-file run.
 */
/**
 * The device target for a platform key.
 *
 * Never substitutes another platform's target: a missing iOS device must
 * surface as "boot a simulator", not quietly run the iOS suite against an
 * Android emulator, where every assertion then fails for reasons that look
 * nothing like the actual problem.
 *
 * @internal — exported for unit testing.
 */
export function selectPlatformTarget(
  key: string,
  targets: Map<string, PlatformTarget>,
  errors: Map<string, string>,
): PlatformTarget {
  const exact = targets.get(key);
  if (exact) return exact;

  const reason = errors.get(key);
  if (reason) throw new Error(reason);

  // The run declares no platform of its own, so a single session target is
  // unambiguous — but several are not.
  if (key === DEFAULT_PLATFORM_KEY) {
    const all = [...targets.values()];
    if (all.length === 1) return all[0];
    if (all.length > 1) {
      throw new Error(
        `This session runs on ${all.length} platforms (${[...targets.keys()].join(', ')}) `
        + 'but the requested tests declare none. Pass a project name so the run targets one of them.',
      );
    }
    const anyReason = [...errors.values()][0];
    if (anyReason) throw new Error(anyReason);
  }

  throw new Error(`No device is configured for ${key === DEFAULT_PLATFORM_KEY ? 'this session' : key}.`);
}

/**
 * Match caller-supplied file arguments against the discovered test files.
 *
 * Accepts an absolute path, a path relative to any of `roots`, or a glob
 * (matched against the absolute path and against the path relative to each
 * root). Returns only files that exist in `testFiles`, so an argument that
 * matches nothing is distinguishable from one that matches an empty file.
 *
 * @internal — exported for unit testing.
 */
export function matchRequestedFiles(
  requested: string[],
  testFiles: string[],
  roots: string[],
): string[] {
  const uniqueRoots = [...new Set(roots)];
  const matched = new Set<string>();

  for (const request of requested) {
    if (testFiles.includes(request)) {
      matched.add(request);
      continue;
    }

    const relativeMatch = uniqueRoots
      .map((root) => path.resolve(root, request))
      .find((resolved) => testFiles.includes(resolved));
    if (relativeMatch) {
      matched.add(relativeMatch);
      continue;
    }

    for (const candidate of testFiles) {
      if (minimatch(candidate, request)) {
        matched.add(candidate);
        continue;
      }
      for (const root of uniqueRoots) {
        const relative = path.relative(root, candidate);
        if (!relative.startsWith('..') && minimatch(relative, request)) {
          matched.add(candidate);
          break;
        }
      }
    }
  }

  return [...matched];
}

/**
 * A whole-file failure as a result entry, so it reaches every consumer that
 * reads results rather than living only in the server's stderr.
 *
 * @internal — exported for unit testing.
 */
export function fileFailureEntry(
  filePath: string,
  projectName: string | undefined,
  err: unknown,
): TestResultEntry {
  return {
    fullName: `${path.basename(filePath)} — file failed to run`,
    filePath,
    status: 'failed',
    duration: 0,
    error: err instanceof Error ? err.message : String(err),
    projectName,
  };
}

export function resultEntryKey(
  projectName: string | undefined,
  filePath: string,
  fullName: string,
): string {
  return `${projectName ?? ''}::${filePath}::${fullName}`;
}

interface WatchedEntry {
  projectName?: string
  testFilter?: string
}

interface DiscoverFileResult {
  tree: TestTreeNode | null
  /** Why the file produced no tree. Absent on success. */
  error?: string
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

/**
 * Locate the scripts the discovery/run children run, and the loader they need.
 *
 * `testFiles` decides the loader: the children `import()` the project's test
 * files, so TypeScript tests need tsx regardless of whether *our* scripts are
 * compiled. Deciding from our own scripts alone (as this used to) meant a
 * published install — which ships only `.js` — always forked bare node, whose
 * native type stripping resolves `.ts` files but does not remap a `./x.js`
 * specifier to `x.ts`. Every test file importing a sibling module the ESM way
 * then failed to load: silently dropped from the test tree during discovery,
 * and failing with a bare count at run time.
 *
 * @internal — exported for unit testing.
 */
export function resolveScripts(testFiles: string[] = []): ResolvedScripts {
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

  const tsxBin = resolveChildLoader(
    [watchRunScript, discoverScript],
    testFiles,
    path.resolve(baseDir, '..'),
    (message) => log(`Warning: ${message}`),
  );

  return { watchRunScript, discoverScript, tsxBin, baseDir };
}

function discoverFile(filePath: string, scripts: ResolvedScripts): Promise<DiscoverFileResult> {
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
      resolve({ tree: null, error: `Discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms` });
    }, DISCOVERY_TIMEOUT_MS);
    timeout.unref?.();
    const settle = (result: DiscoverFileResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.on('message', (response: UIDiscoverChildMessage) => {
      if (settled) return;

      if (response.type === 'discover-result') {
        settle({ tree: response.tree });
      } else {
        log(`Discovery error for ${filePath}: ${response.error.message}`);
        settle({ tree: null, error: response.error.message });
      }
    });

    child.on('exit', (code, signal) => {
      settle({ tree: null, error: `Discovery process exited without a result (code ${code ?? 'null'}, signal ${signal ?? 'none'})` });
    });

    child.on('error', (err) => {
      settle({ tree: null, error: `Discovery process failed to start: ${err.message}` });
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
