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

import { fork, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { minimatch } from 'minimatch'
import type { PilotConfig } from './config.js'
import type { Device } from './device.js'
import type { PilotGrpcClient } from './grpc-client.js'
import { createReporters, ReporterDispatcher, type FullResult, type PilotReporter } from './reporter.js'
import type { TestResult, SuiteResult } from './runner.js'
import type { ResolvedProject } from './project.js'
import {
  deserializeTestResult,
  deserializeSuiteResult,
  type SerializedConfig,
  type RunFileUseOptions,
} from './worker-protocol.js'
import type { WatchRunMessage, WatchRunChildMessage } from './watch-run.js'
import { preserveEmulatorsForReuse, type LaunchedEmulator } from './emulator.js'

// ─── ANSI helpers ───

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

// ─── Keypress mapping ───

export type WatchAction = 'run-all' | 'run-failed' | 'rerun' | 'quit'

export function mapKeyToAction(key: string): WatchAction | null {
  switch (key) {
    case 'a': return 'run-all'
    case 'f': return 'run-failed'
    case '\r': // Enter
    case '\n': return 'rerun'
    case 'q':
    case '\x03': return 'quit' // Ctrl+C
    default: return null
  }
}

// ─── Run queue ───

export type RunRequest = { type: 'files'; files: string[] } | { type: 'all' }

/**
 * Manages debounce and queuing for watch mode re-runs.
 *
 * - Debounces rapid file changes, accumulating files across calls
 * - Queues runs while another is in progress
 * - 'run-all' supersedes individual pending files
 */
export class RunQueue {
  private _debounceFiles = new Set<string>()
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null
  private _pendingFiles: Set<string> | 'all' | null = null
  private _isRunning = false
  private _debounceMs: number
  private _onRun: (request: RunRequest) => void

  constructor(debounceMs: number, onRun: (request: RunRequest) => void) {
    this._debounceMs = debounceMs
    this._onRun = onRun
  }

  get isRunning(): boolean { return this._isRunning }

  /** Schedule specific files with debounce accumulation. */
  scheduleFiles(files: string[]): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
    }

    if (this._isRunning) {
      if (this._pendingFiles === 'all') return
      if (this._pendingFiles) {
        for (const f of files) this._pendingFiles.add(f)
      } else {
        this._pendingFiles = new Set(files)
      }
      return
    }

    for (const f of files) this._debounceFiles.add(f)

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null
      const batch = [...this._debounceFiles]
      this._debounceFiles.clear()
      this._onRun({ type: 'files', files: batch })
    }, this._debounceMs)
  }

  /** Schedule a full run (immediate, no debounce). */
  scheduleAll(): void {
    if (this._isRunning) {
      this._pendingFiles = 'all'
      return
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }
    this._onRun({ type: 'all' })
  }

  /** Schedule specific files immediately (no debounce). */
  scheduleImmediate(files: string[]): void {
    if (this._isRunning) {
      this._pendingFiles = new Set(files)
      return
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer)
      this._debounceTimer = null
    }
    this._onRun({ type: 'files', files })
  }

  /** Mark that a run has started. */
  notifyRunStarted(): void {
    this._isRunning = true
  }

  /** Mark that a run has finished and drain any queued work. */
  notifyRunFinished(): void {
    this._isRunning = false
    if (this._pendingFiles) {
      const pending = this._pendingFiles
      this._pendingFiles = null
      if (pending === 'all') {
        this._onRun({ type: 'all' })
      } else {
        this._onRun({ type: 'files', files: [...pending] })
      }
    }
  }
}

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
}

// ─── Watch mode coordinator ───

export async function runWatchMode(ctx: WatchModeContext): Promise<void> {
  const state = {
    knownFiles: new Set(ctx.testFiles),
    failedFiles: new Set<string>(),
    lastRunFiles: [] as string[],
    isInitialRun: true,
    watcher: null as FSWatcher | null,
    activeChild: null as ChildProcess | null,
  }

  // Build file → project lookup for re-runs
  const fileToProject = new Map<string, ResolvedProject>()
  if (ctx.projects) {
    for (const project of ctx.projects) {
      for (const file of project.testFiles) {
        fileToProject.set(file, project)
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
  }

  // Resolve tsx binary for forking TypeScript files
  const jsScript = path.resolve(__dirname, 'watch-run.js')
  const tsScript = path.resolve(__dirname, 'watch-run.ts')
  const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript)
  const resolvedScript = useTypeScript ? tsScript : jsScript

  let tsxBin: string | undefined
  if (useTypeScript) {
    const pilotPkgDir = path.resolve(__dirname, '..')
    const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx')
    tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx'
  }

  // ─── Run queue ───

  const queue = new RunQueue(300, (request) => {
    const run = request.type === 'all'
      ? executeWaveRun()
      : executeFileRun(request.files)
    run.catch((err) => {
      process.stderr.write(`${RED}Watch run error: ${err instanceof Error ? err.message : err}${RESET}\n`)
      queue.notifyRunFinished()
    })
  })

  // ─── Run execution ───

  /** Run files respecting project wave ordering (used for initial run and run-all). */
  async function executeWaveRun(): Promise<void> {
    queue.notifyRunStarted()
    state.lastRunFiles = [...state.knownFiles]

    if (!state.isInitialRun) {
      process.stdout.write('\x1b[2J\x1b[H') // clear visible area, cursor to top
    }

    const runStart = Date.now()
    const allResults: TestResult[] = []
    const allSuites: SuiteResult[] = []

    const reporters = await createReporters(ctx.config.reporter)
    const reporter = new ReporterDispatcher(reporters)

    const totalFiles = [...state.knownFiles].length
    reporter.onRunStart(ctx.config, totalFiles)

    if (ctx.projectWaves && ctx.projects) {
      // Wave-based execution respecting project dependencies
      const failedProjects = new Set<string>()

      for (const wave of ctx.projectWaves) {
        for (const project of wave) {
          // Skip projects whose dependencies failed
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d))
          if (blockedBy) {
            process.stdout.write(`${DIM}Skipping project "${project.name}" — dependency "${blockedBy}" failed${RESET}\n`)
            for (const file of project.testFiles) {
              const skippedResult: TestResult = {
                name: path.basename(file),
                fullName: path.basename(file),
                status: 'skipped',
                durationMs: 0,
                project: project.name,
              }
              allResults.push(skippedResult)
              reporter.onTestEnd?.(skippedResult)
            }
            failedProjects.add(project.name)
            continue
          }

          let projectFailed = false

          for (const file of project.testFiles) {
            reporter.onTestFileStart?.(file)

            try {
              const { results, suite } = await runFileInChild(
                file,
                reporter,
                project.use as RunFileUseOptions | undefined,
                project.name !== 'default' ? project.name : undefined,
              )
              allResults.push(...results)
              allSuites.push(suite)
              reporter.onTestFileEnd?.(file, results)

              if (results.some((r) => r.status === 'failed')) {
                state.failedFiles.add(file)
                projectFailed = true
              } else {
                state.failedFiles.delete(file)
              }
            } catch (err) {
              const errorResult = makeErrorResult(file, err, project.name)
              allResults.push(errorResult)
              reporter.onTestEnd?.(errorResult)
              reporter.onTestFileEnd?.(file, [errorResult])
              state.failedFiles.add(file)
              projectFailed = true
            }
          }

          if (projectFailed) {
            failedProjects.add(project.name)
          }
        }
      }
    } else {
      // No projects — run files sequentially
      for (const file of state.knownFiles) {
        reporter.onTestFileStart?.(file)

        try {
          const { results, suite } = await runFileInChild(file, reporter)
          allResults.push(...results)
          allSuites.push(suite)
          reporter.onTestFileEnd?.(file, results)

          if (results.some((r) => r.status === 'failed')) {
            state.failedFiles.add(file)
          } else {
            state.failedFiles.delete(file)
          }
        } catch (err) {
          const errorResult = makeErrorResult(file, err)
          allResults.push(errorResult)
          reporter.onTestEnd?.(errorResult)
          reporter.onTestFileEnd?.(file, [errorResult])
          state.failedFiles.add(file)
        }
      }
    }

    await finishRun(reporter, allResults, allSuites, runStart)
  }

  /** Run specific files (used for file-change re-runs and run-failed). */
  async function executeFileRun(files: string[]): Promise<void> {
    if (files.length === 0) return
    queue.notifyRunStarted()
    state.lastRunFiles = files

    process.stdout.write('\x1b[2J\x1b[H') // clear visible area, cursor to top

    const runStart = Date.now()
    const allResults: TestResult[] = []
    const allSuites: SuiteResult[] = []

    const reporters = await createReporters(ctx.config.reporter)
    const reporter = new ReporterDispatcher(reporters)

    reporter.onRunStart(ctx.config, files.length)

    for (const file of files) {
      const project = fileToProject.get(file)
      const useOptions = project?.use as RunFileUseOptions | undefined
      const projectName = project && project.name !== 'default' ? project.name : undefined

      reporter.onTestFileStart?.(file)

      try {
        const { results, suite } = await runFileInChild(file, reporter, useOptions, projectName)
        allResults.push(...results)
        allSuites.push(suite)
        reporter.onTestFileEnd?.(file, results)

        if (results.some((r) => r.status === 'failed')) {
          state.failedFiles.add(file)
        } else {
          state.failedFiles.delete(file)
        }
      } catch (err) {
        const errorResult = makeErrorResult(file, err, projectName)
        allResults.push(errorResult)
        reporter.onTestEnd?.(errorResult)
        reporter.onTestFileEnd?.(file, [errorResult])
        state.failedFiles.add(file)
      }
    }

    await finishRun(reporter, allResults, allSuites, runStart)
  }

  async function finishRun(
    reporter: ReporterDispatcher,
    allResults: TestResult[],
    allSuites: SuiteResult[],
    runStart: number,
  ): Promise<void> {
    const totalDuration = Date.now() - runStart
    const fullResult: FullResult = {
      status: allResults.some((r) => r.status === 'failed') ? 'failed' : 'passed',
      duration: totalDuration,
      tests: allResults,
      suites: allSuites,
    }

    await reporter.onRunEnd(fullResult)
    printStatusLine(allResults, totalDuration)

    state.isInitialRun = false
    queue.notifyRunFinished()
  }

  function makeErrorResult(file: string, err: unknown, projectName?: string): TestResult {
    return {
      name: path.basename(file),
      fullName: path.basename(file),
      status: 'failed',
      durationMs: 0,
      error: err instanceof Error ? err : new Error(String(err)),
      project: projectName,
    }
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
      })

      state.activeChild = child
      let settled = false

      const msg: WatchRunMessage = {
        type: 'run',
        daemonAddress: ctx.daemonAddress,
        deviceSerial: ctx.deviceSerial,
        filePath,
        config: serializedConfig,
        screenshotDir: ctx.screenshotDir,
        projectUseOptions,
        projectName,
      }

      child.on('message', (response: WatchRunChildMessage) => {
        if (settled) return

        switch (response.type) {
          case 'test-end': {
            // Forward to reporter for live output
            const result = deserializeTestResult(response.result)
            reporter.onTestEnd?.(result)
            break
          }
          case 'file-done': {
            settled = true
            const results = response.results.map(deserializeTestResult)
            const suite = deserializeSuiteResult(response.suite)
            resolve({ results, suite })
            break
          }
          case 'error':
            settled = true
            reject(new Error(response.error.message))
            break
        }
      })

      child.on('exit', (code) => {
        state.activeChild = null
        if (!settled) {
          settled = true
          reject(new Error(`Watch worker exited with code ${code ?? 0} without sending results`))
        }
      })

      child.on('error', (err) => {
        state.activeChild = null
        if (!settled) {
          settled = true
          reject(err)
        }
      })

      child.send(msg)
    })
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
      : filePath
    const patterns = ctx.projects
      ? ctx.projects.flatMap((p) => p.testMatch)
      : ctx.config.testMatch
    return patterns.some((pattern) => minimatch(relative, pattern))
  }

  function startWatcher(): FSWatcher {
    const filesToWatch: string[] = [...state.knownFiles]

    // Watch directories that contain test files so we detect new files
    const testDirs = new Set<string>()
    for (const file of state.knownFiles) {
      testDirs.add(path.dirname(file))
    }
    filesToWatch.push(...testDirs)

    // Also watch the config file for change notification
    const configCandidates = ['pilot.config.ts', 'pilot.config.js', 'pilot.config.mjs']
    const configPath = configCandidates
      .map((name) => path.resolve(ctx.config.rootDir, name))
      .find((p) => fs.existsSync(p))
    if (configPath) {
      filesToWatch.push(configPath)
    }

    const watcher = chokidarWatch(filesToWatch, { ignoreInitial: true })

    watcher.on('change', (filePath) => {
      if (configPath && filePath === configPath) {
        process.stdout.write(
          `\n${YELLOW}Config file changed. Restart watch mode to pick up changes.${RESET}\n`,
        )
        printStatusLine()
        return
      }
      if (state.knownFiles.has(filePath)) {
        queue.scheduleFiles([filePath])
      }
    })

    watcher.on('add', (filePath) => {
      if (!state.knownFiles.has(filePath) && matchesTestPatterns(filePath)) {
        state.knownFiles.add(filePath)
        // Also start watching the new file itself for changes
        watcher.add(filePath)
        queue.scheduleFiles([filePath])
      }
    })

    watcher.on('unlink', (filePath) => {
      state.knownFiles.delete(filePath)
      state.failedFiles.delete(filePath)
    })

    return watcher
  }

  // ─── Keyboard input ───

  function setupKeyboardInput(): void {
    if (!process.stdin.isTTY) return

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    process.stdin.on('data', (key: string) => {
      const action = mapKeyToAction(key)
      if (!action) return

      switch (action) {
        case 'run-all':
          queue.scheduleAll()
          break
        case 'run-failed': {
          const failedList = [...state.failedFiles].filter((f) => state.knownFiles.has(f))
          if (failedList.length === 0) {
            process.stdout.write(`${DIM}No failed tests to re-run.${RESET}\n`)
          } else {
            queue.scheduleImmediate(failedList)
          }
          break
        }
        case 'rerun': {
          const validFiles = state.lastRunFiles.filter((f) => state.knownFiles.has(f))
          if (validFiles.length > 0) {
            queue.scheduleImmediate(validFiles)
          }
          break
        }
        case 'quit':
          cleanup()
          break
      }
    })
  }

  // ─── Status line ───

  function printStatusLine(results?: TestResult[], durationMs?: number): void {
    process.stdout.write('\n')

    if (results && durationMs !== undefined) {
      const passed = results.filter((r) => r.status === 'passed').length
      const failed = results.filter((r) => r.status === 'failed').length
      const skipped = results.filter((r) => r.status === 'skipped').length
      const duration = (durationMs / 1000).toFixed(1)
      const parts: string[] = []
      if (passed > 0) parts.push(`${GREEN}${passed} passed${RESET}`)
      if (failed > 0) parts.push(`${RED}${failed} failed${RESET}`)
      if (skipped > 0) parts.push(`${DIM}${skipped} skipped${RESET}`)
      process.stdout.write(`  ${parts.join(', ')} ${DIM}(${duration}s)${RESET}\n\n`)
    }

    process.stdout.write(`${BOLD}Watch Usage${RESET}\n`)
    process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}a${RESET}${DIM} to run all tests${RESET}\n`)
    process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}f${RESET}${DIM} to run only failed tests${RESET}\n`)
    if (state.lastRunFiles.length > 0) {
      const fileNames = state.lastRunFiles.map((f) => path.basename(f)).join(', ')
      process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}Enter${RESET}${DIM} to re-run ${fileNames}${RESET}\n`)
    }
    process.stdout.write(`${DIM} ${CYAN}\u203a${RESET}${DIM} Press ${BOLD}q${RESET}${DIM} to quit${RESET}\n`)
  }

  // ─── Cleanup ───

  function cleanup(): void {
    if (state.activeChild) {
      try { state.activeChild.kill() } catch { /* already dead */ }
    }

    if (state.watcher) {
      state.watcher.close()
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }

    ctx.device.close()
    ctx.client.close()

    preserveEmulatorsForReuse(ctx.launchedEmulators)

    process.exit(0)
  }

  // ─── Start watch mode ───

  process.stdout.write(`${BOLD}Watch mode started.${RESET} Watching ${state.knownFiles.size} test file(s).\n`)
  process.stdout.write(`${DIM}Using device: ${ctx.deviceSerial}${RESET}\n\n`)

  state.watcher = startWatcher()

  setupKeyboardInput()

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // Run initial test suite
  await executeWaveRun()

  // Keep alive forever — cleaned up via `cleanup()` on quit/signal.
  await new Promise<void>(() => { /* never resolves */ })
}
