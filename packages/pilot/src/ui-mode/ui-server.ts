/**
 * UI mode server.
 *
 * HTTP server that serves the bundled Preact SPA and upgrades to WebSocket
 * for real-time communication. Manages test discovery, execution (via forked
 * child processes), device screen polling, and watch mode.
 *
 * @see PILOT-87
 */

import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { WebSocketServer, type WebSocket } from 'ws'
import type { PilotConfig } from '../config.js'
import type { PilotGrpcClient } from '../grpc-client.js'
import type { Device } from '../device.js'
import type { ResolvedProject } from '../project.js'
import { collectTransitiveDeps } from '../project.js'
import type { LaunchedEmulator } from '../emulator.js'
import { preserveEmulatorsForReuse } from '../emulator.js'
import {
  deserializeTestResult,
  deserializeSuiteResult,
  type SerializedConfig,
  type RunFileUseOptions,
} from '../worker-protocol.js'
import type {
  ServerMessage,
  ClientMessage,
  TestTreeNode,
  UIRunMessage,
  UIRunChildMessage,
  UIDiscoverMessage,
  UIDiscoverChildMessage,
} from './ui-protocol.js'
import { encodeScreenFrame } from './ui-protocol.js'
import { RunQueue } from '../watch-queue.js'

// ─── SPA paths ───

const SPA_HTML_PATH = path.resolve(__dirname, 'index.html')

// ─── Types ───

export interface UIServerContext {
  config: PilotConfig
  device: Device
  client: PilotGrpcClient
  deviceSerial: string
  daemonAddress: string
  testFiles: string[]
  screenshotDir?: string
  launchedEmulators: LaunchedEmulator[]
  projects?: ResolvedProject[]
  /** Dependency-ordered project waves from topologicalSort(). */
  projectWaves?: ResolvedProject[][]
}

export interface UIServerOptions {
  port?: number
}

// ─── UI Server ───

export async function startUIServer(
  ctx: UIServerContext,
  options: UIServerOptions = {},
): Promise<{ port: number; close: () => void }> {
  const clients = new Set<WebSocket>()
  let testTree: TestTreeNode[] = []
  let isRunning = false
  let activeChild: ChildProcess | null = null
  let screenPollTimer: ReturnType<typeof setTimeout> | null = null
  let screenSeq = 0
  let screenPollActive = false
  let watcher: FSWatcher | null = null
  const watchedFiles = new Set<string>()

  // Detect whether meaningful projects are configured (not just a synthetic 'default')
  const hasRealProjects = ctx.projects != null
    && ctx.projects.length > 0
    && !(ctx.projects.length === 1 && ctx.projects[0].name === 'default')

  // Build file → project lookup
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
      : 'on',
  }

  // Resolve tsx binary for forking TypeScript files
  const jsScript = path.resolve(__dirname, 'ui-run.js')
  const tsScript = path.resolve(__dirname, 'ui-run.ts')
  const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript)
  const resolvedRunScript = useTypeScript ? tsScript : jsScript

  const jsDiscoverScript = path.resolve(__dirname, 'ui-discover.js')
  const tsDiscoverScript = path.resolve(__dirname, 'ui-discover.ts')
  const resolvedDiscoverScript = !fs.existsSync(jsDiscoverScript) && fs.existsSync(tsDiscoverScript)
    ? tsDiscoverScript
    : jsDiscoverScript

  let tsxBin: string | undefined
  if (useTypeScript || resolvedDiscoverScript.endsWith('.ts')) {
    const pilotPkgDir = path.resolve(__dirname, '..')
    const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx')
    tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx'
  }

  // ─── Broadcast ───

  function broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data)
      }
    }
  }

  function broadcastBinary(data: Buffer): void {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data)
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
      })

      let settled = false

      child.on('message', (response: UIDiscoverChildMessage) => {
        if (settled) return
        settled = true

        if (response.type === 'discover-result') {
          resolve(response.tree)
        } else {
          console.error(`Discovery error for ${filePath}: ${response.error.message}`)
          resolve(null)
        }
      })

      child.on('exit', () => {
        if (!settled) {
          settled = true
          resolve(null)
        }
      })

      child.on('error', () => {
        if (!settled) {
          settled = true
          resolve(null)
        }
      })

      const msg: UIDiscoverMessage = { type: 'discover', filePath }
      child.send(msg)
    })
  }

  async function discoverAllFiles(): Promise<void> {
    // Discover all files first
    const fileNodes = new Map<string, TestTreeNode>()
    for (const file of ctx.testFiles) {
      const tree = await discoverFile(file)
      if (tree) {
        fileNodes.set(file, tree)
      }
    }

    // Group into project nodes when projects are configured
    if (hasRealProjects && ctx.projects) {
      const trees: TestTreeNode[] = []
      for (const project of ctx.projects) {
        const projectFiles = project.testFiles
          .map((f) => fileNodes.get(f))
          .filter((n): n is TestTreeNode => n != null)

        if (projectFiles.length === 0) continue

        trees.push({
          id: `project::${project.name}`,
          type: 'project',
          name: project.name,
          filePath: '',
          fullName: project.name,
          status: 'idle',
          children: projectFiles,
          dependencies: project.dependencies.length > 0 ? project.dependencies : undefined,
        })
      }
      testTree = trees
    } else {
      // No meaningful projects — flat file list
      testTree = [...fileNodes.values()]
    }

    broadcast({ type: 'test-tree', files: testTree })
  }

  // ─── Test Execution ───

  function updateTestStatus(fullName: string, filePath: string, status: TestTreeNode['status'], duration?: number, error?: string, tracePath?: string): void {
    broadcast({
      type: 'test-status',
      fullName,
      filePath,
      status,
      duration,
      error,
      tracePath,
    })
  }

  async function runFile(filePath: string, testFilter?: string): Promise<void> {
    if (isRunning) {
      // Queue it up if already running
      return
    }

    isRunning = true
    const project = fileToProject.get(filePath)
    const useOptions = project?.use as RunFileUseOptions | undefined
    const projectName = project && project.name !== 'default' ? project.name : undefined

    broadcast({ type: 'file-status', filePath, status: 'running' })
    broadcast({ type: 'run-start', fileCount: 1, filePath, testFilter })

    // Speed up screen polling during execution
    screenPollActive = true

    try {
      const { results, suite } = await runFileInChild(filePath, useOptions, projectName, testFilter)

      const passed = results.filter((r) => r.status === 'passed').length
      const failed = results.filter((r) => r.status === 'failed').length
      const skipped = results.filter((r) => r.status === 'skipped').length
      const duration = suite.durationMs

      broadcast({ type: 'file-status', filePath, status: 'done' })
      broadcast({
        type: 'run-end',
        status: failed > 0 ? 'failed' : 'passed',
        duration,
        passed,
        failed,
        skipped,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      broadcast({
        type: 'error',
        message: `Failed to run ${path.basename(filePath)}: ${msg}`,
      })
      broadcast({ type: 'file-status', filePath, status: 'done' })
      broadcast({
        type: 'run-end',
        status: 'failed',
        duration: 0,
        passed: 0,
        failed: 1,
        skipped: 0,
      })
    } finally {
      isRunning = false
      screenPollActive = false
    }
  }

  async function runAllFiles(): Promise<void> {
    if (isRunning) return
    isRunning = true
    screenPollActive = true

    broadcast({ type: 'run-start', fileCount: ctx.testFiles.length })

    let totalPassed = 0
    let totalFailed = 0
    let totalSkipped = 0
    let totalDuration = 0

    try {
      if (hasRealProjects && ctx.projectWaves) {
        // Wave-based execution respecting project dependencies
        const failedProjects = new Set<string>()

        for (const wave of ctx.projectWaves) {
          for (const project of wave) {
            const blockedBy = project.dependencies.find((d) => failedProjects.has(d))
            if (blockedBy) {
              broadcast({
                type: 'error',
                message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed`,
              })
              markProjectTestsSkipped(project.name)
              failedProjects.add(project.name)
              continue
            }

            const { passed, failed, skipped, duration, anyFailed } = await runProjectFiles(project)
            totalPassed += passed
            totalFailed += failed
            totalSkipped += skipped
            totalDuration += duration
            if (anyFailed) failedProjects.add(project.name)
          }
        }
      } else {
        // No projects — sequential
        for (const file of ctx.testFiles) {
          const project = fileToProject.get(file)
          const useOptions = project?.use as RunFileUseOptions | undefined
          const projectName = project && project.name !== 'default' ? project.name : undefined

          broadcast({ type: 'file-status', filePath: file, status: 'running' })

          try {
            const { results, suite } = await runFileInChild(file, useOptions, projectName)

            totalPassed += results.filter((r) => r.status === 'passed').length
            totalFailed += results.filter((r) => r.status === 'failed').length
            totalSkipped += results.filter((r) => r.status === 'skipped').length
            totalDuration += suite.durationMs
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            broadcast({ type: 'error', message: `Error in ${path.basename(file)}: ${errMsg}` })
            totalFailed++
          }

          broadcast({ type: 'file-status', filePath: file, status: 'done' })
        }
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      })
    } finally {
      isRunning = false
      screenPollActive = false
    }
  }

  /** Run all files belonging to a single project, returning aggregate counts. */
  async function runProjectFiles(project: ResolvedProject): Promise<{
    passed: number; failed: number; skipped: number; duration: number; anyFailed: boolean
  }> {
    let passed = 0, failed = 0, skipped = 0, duration = 0, anyFailed = false
    const useOptions = project.use as RunFileUseOptions | undefined
    const projectName = project.name !== 'default' ? project.name : undefined

    for (const file of project.testFiles) {
      broadcast({ type: 'file-status', filePath: file, status: 'running' })

      try {
        const { results, suite } = await runFileInChild(file, useOptions, projectName)
        passed += results.filter((r) => r.status === 'passed').length
        failed += results.filter((r) => r.status === 'failed').length
        skipped += results.filter((r) => r.status === 'skipped').length
        duration += suite.durationMs
        if (results.some((r) => r.status === 'failed')) anyFailed = true
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        broadcast({ type: 'error', message: `Error in ${path.basename(file)}: ${errMsg}` })
        failed++
        anyFailed = true
      }

      broadcast({ type: 'file-status', filePath: file, status: 'done' })
    }

    return { passed, failed, skipped, duration, anyFailed }
  }

  /** Run a single project with its transitive dependencies in wave order. */
  async function runProject(projectName: string): Promise<void> {
    if (isRunning) return
    if (!ctx.projects || !ctx.projectWaves) return

    const target = ctx.projects.find((p) => p.name === projectName)
    if (!target) return

    isRunning = true
    screenPollActive = true

    // Collect transitive deps and filter waves
    const requiredNames = collectTransitiveDeps(new Set([projectName]), ctx.projects)
    const filteredWaves = ctx.projectWaves
      .map((wave) => wave.filter((p) => requiredNames.has(p.name)))
      .filter((wave) => wave.length > 0)

    const allFiles = filteredWaves.flatMap((w) => w.flatMap((p) => p.testFiles))
    broadcast({ type: 'run-start', fileCount: allFiles.length })

    let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0
    const failedProjects = new Set<string>()

    try {
      for (const wave of filteredWaves) {
        for (const project of wave) {
          const blockedBy = project.dependencies.find((d) => failedProjects.has(d))
          if (blockedBy) {
            broadcast({
              type: 'error',
              message: `Skipping project "${project.name}" — dependency "${blockedBy}" failed`,
            })
            markProjectTestsSkipped(project.name)
            failedProjects.add(project.name)
            continue
          }

          const { passed, failed, skipped, duration, anyFailed } = await runProjectFiles(project)
          totalPassed += passed
          totalFailed += failed
          totalSkipped += skipped
          totalDuration += duration
          if (anyFailed) failedProjects.add(project.name)
        }
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      })
    } finally {
      isRunning = false
      screenPollActive = false
    }
  }

  /**
   * Walk the test tree and broadcast 'skipped' status for every test under
   * a project whose dependency failed, so the UI shows them correctly.
   */
  function markProjectTestsSkipped(projectName: string): void {
    function markChildren(nodes: TestTreeNode[]): void {
      for (const node of nodes) {
        if (node.type === 'test') {
          updateTestStatus(node.fullName, node.filePath, 'skipped')
        }
        if (node.children) markChildren(node.children)
      }
    }

    for (const node of testTree) {
      if (node.type === 'project' && node.name === projectName && node.children) {
        markChildren(node.children)
        return
      }
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
      })

      activeChild = child
      let settled = false
      let currentTestFullName = ''

      child.on('message', (response: UIRunChildMessage) => {
        if (settled) return

        switch (response.type) {
          case 'test-start': {
            currentTestFullName = response.fullName
            broadcast({
              type: 'test-start',
              fullName: response.fullName,
              filePath: response.filePath,
            })
            break
          }
          case 'test-end': {
            const result = deserializeTestResult(response.result)
            // When running a single test, don't broadcast status for tests
            // that were merely filtered out — their previous status (e.g.
            // passed/failed from an earlier run) should persist.
            if (testFilter && result.status === 'skipped' && result.fullName !== testFilter) {
              break
            }
            updateTestStatus(
              result.fullName,
              filePath,
              result.status as TestTreeNode['status'],
              result.durationMs,
              result.error?.message,
              result.tracePath,
            )
            break
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
            })
            break
          }
          case 'source': {
            broadcast({
              type: 'source',
              fileName: response.fileName,
              content: response.content,
            })
            break
          }
          case 'network': {
            broadcast({
              type: 'network',
              entries: response.entries,
            })
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
        activeChild = null
        if (!settled) {
          settled = true
          reject(new Error(`UI run worker exited with code ${code ?? 0} without sending results`))
        }
      })

      child.on('error', (err) => {
        activeChild = null
        if (!settled) {
          settled = true
          reject(err)
        }
      })

      const msg: UIRunMessage = {
        type: 'run',
        daemonAddress: ctx.daemonAddress,
        deviceSerial: ctx.deviceSerial,
        filePath,
        config: serializedConfig,
        screenshotDir: ctx.screenshotDir,
        projectUseOptions,
        projectName,
        testFilter,
      }

      child.send(msg)
    })
  }

  /**
   * Run a file (or single test) with its project's dependency projects first.
   * Falls back to plain runFile when there are no deps or no project context.
   */
  async function runFileWithDeps(filePath: string, testFilter?: string): Promise<void> {
    if (isRunning) return

    const project = fileToProject.get(filePath)
    if (!project || project.dependencies.length === 0 || !ctx.projects || !ctx.projectWaves) {
      return runFile(filePath, testFilter)
    }

    isRunning = true
    screenPollActive = true

    // Collect only the dependency projects (not the target project itself)
    const depNames = collectTransitiveDeps(new Set(project.dependencies), ctx.projects)
    depNames.delete(project.name)

    const depWaves = ctx.projectWaves
      .map((wave) => wave.filter((p) => depNames.has(p.name)))
      .filter((wave) => wave.length > 0)

    const depFileCount = depWaves.reduce((n, w) => n + w.reduce((m, p) => m + p.testFiles.length, 0), 0)
    broadcast({ type: 'run-start', fileCount: depFileCount + 1, filePath, testFilter })

    let totalPassed = 0, totalFailed = 0, totalSkipped = 0, totalDuration = 0
    const failedProjects = new Set<string>()

    try {
      // Run dependency waves first
      for (const wave of depWaves) {
        for (const depProject of wave) {
          const blockedBy = depProject.dependencies.find((d) => failedProjects.has(d))
          if (blockedBy) {
            broadcast({ type: 'error', message: `Skipping project "${depProject.name}" — dependency "${blockedBy}" failed` })
            markProjectTestsSkipped(depProject.name)
            failedProjects.add(depProject.name)
            continue
          }

          const r = await runProjectFiles(depProject)
          totalPassed += r.passed
          totalFailed += r.failed
          totalSkipped += r.skipped
          totalDuration += r.duration
          if (r.anyFailed) failedProjects.add(depProject.name)
        }
      }

      // Check if any direct dependency failed
      const blockedBy = project.dependencies.find((d) => failedProjects.has(d))
      if (blockedBy) {
        broadcast({ type: 'error', message: `Skipping "${path.basename(filePath)}" — dependency "${blockedBy}" failed` })
        // Mark target file's tests as skipped via file-status cycle
        broadcast({ type: 'file-status', filePath, status: 'done' })
      } else {
        // Run the target file/test
        const useOptions = project.use as RunFileUseOptions | undefined
        const projectName = project.name !== 'default' ? project.name : undefined

        broadcast({ type: 'file-status', filePath, status: 'running' })

        try {
          const { results, suite } = await runFileInChild(filePath, useOptions, projectName, testFilter)
          totalPassed += results.filter((r) => r.status === 'passed').length
          totalFailed += results.filter((r) => r.status === 'failed').length
          totalSkipped += results.filter((r) => r.status === 'skipped').length
          totalDuration += suite.durationMs
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          broadcast({ type: 'error', message: `Failed to run ${path.basename(filePath)}: ${errMsg}` })
          totalFailed++
        }

        broadcast({ type: 'file-status', filePath, status: 'done' })
      }

      broadcast({
        type: 'run-end',
        status: totalFailed > 0 ? 'failed' : 'passed',
        duration: totalDuration,
        passed: totalPassed,
        failed: totalFailed,
        skipped: totalSkipped,
      })
    } finally {
      isRunning = false
      screenPollActive = false
    }
  }

  // ─── Screen Polling ───

  async function pollScreen(): Promise<void> {
    if (clients.size === 0) {
      scheduleScreenPoll()
      return
    }

    try {
      const response = await ctx.client.takeScreenshot()
      if (response.success && response.data) {
        const data = Buffer.isBuffer(response.data)
          ? response.data
          : Buffer.from(response.data)
        // Get screen dimensions (we default to common mobile size)
        const width = 1080
        const height = 1920
        const frame = encodeScreenFrame(screenSeq++, width, height, data)
        broadcastBinary(frame)
      }
    } catch {
      // Device may be busy — skip frame
    }

    scheduleScreenPoll()
  }

  function scheduleScreenPoll(): void {
    if (screenPollTimer) clearTimeout(screenPollTimer)
    const interval = screenPollActive ? 150 : 500
    screenPollTimer = setTimeout(pollScreen, interval)
  }

  // ─── Watch Mode ───

  function startWatching(filePath: string): void {
    if (watchedFiles.has(filePath)) return
    watchedFiles.add(filePath)

    if (!watcher) {
      watcher = chokidarWatch([], { ignoreInitial: true })
      watcher.on('change', (changedPath) => {
        if (watchedFiles.has(changedPath)) {
          broadcast({ type: 'watch-event', filePath: changedPath, event: 'changed' })
          watchQueue.scheduleFiles([changedPath])
        }
      })
    }

    watcher.add(filePath)
    broadcast({ type: 'watch-event', filePath, event: 'watch-enabled' })
  }

  function stopWatching(filePath: string): void {
    if (!watchedFiles.has(filePath)) return
    watchedFiles.delete(filePath)
    watcher?.unwatch(filePath)
    broadcast({ type: 'watch-event', filePath, event: 'watch-disabled' })
  }

  const watchQueue = new RunQueue(300, (request) => {
    if (request.type === 'all') {
      runAllFiles().catch(() => {})
    } else {
      // Run the first changed file
      const file = request.files[0]
      if (file) runFile(file).catch(() => {})
    }
  })

  // ─── Command Handler ───

  function handleCommand(msg: ClientMessage): void {
    switch (msg.type) {
      case 'run-test':
        if (msg.runDeps) runFileWithDeps(msg.filePath, msg.fullName).catch(() => {})
        else runFile(msg.filePath, msg.fullName).catch(() => {})
        break
      case 'run-file':
        if (msg.runDeps) runFileWithDeps(msg.filePath).catch(() => {})
        else runFile(msg.filePath).catch(() => {})
        break
      case 'run-all':
        runAllFiles().catch(() => {})
        break
      case 'run-project':
        runProject(msg.projectName).catch(() => {})
        break
      case 'stop-run':
        if (activeChild) {
          try { activeChild.kill() } catch { /* already dead */ }
        }
        break
      case 'toggle-watch':
        if (msg.filePath === 'all') {
          const allWatched = ctx.testFiles.every((f) => watchedFiles.has(f))
          for (const f of ctx.testFiles) {
            if (allWatched) stopWatching(f)
            else startWatching(f)
          }
        } else {
          if (watchedFiles.has(msg.filePath)) stopWatching(msg.filePath)
          else startWatching(msg.filePath)
        }
        break
      case 'request-hierarchy':
        ctx.client.getUiHierarchy().then((response) => {
          if (response.hierarchyXml) {
            broadcast({ type: 'hierarchy-update', xml: response.hierarchyXml })
          }
        }).catch(() => {})
        break
      case 'tap-coordinates':
        // Interactive tap: scale normalized coordinates to device screen.
        // This is a best-effort feature — if no raw coordinate tap exists
        // on the gRPC client, we log a message.
        console.log(`[Pilot UI] Tap at (${msg.x.toFixed(2)}, ${msg.y.toFixed(2)}) — coordinate tap not yet implemented`)
        break
      case 'set-filter':
        // Filtering is client-side — no action needed
        break
    }
  }

  // ─── HTTP Server ───

  let spaHtml: string
  if (fs.existsSync(SPA_HTML_PATH)) {
    spaHtml = fs.readFileSync(SPA_HTML_PATH, 'utf-8')
  } else {
    spaHtml = buildFallbackHtml()
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(spaHtml)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  // ─── WebSocket Server ───

  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    clients.add(ws)

    // Send current state to new client
    ws.send(JSON.stringify({ type: 'test-tree', files: testTree } satisfies ServerMessage))
    ws.send(JSON.stringify({
      type: 'device-info',
      serial: ctx.deviceSerial,
      model: undefined,
      isEmulator: ctx.deviceSerial.startsWith('emulator-'),
    } satisfies ServerMessage))

    ws.on('message', (data) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString())
        handleCommand(msg)
      } catch {
        // Ignore malformed messages
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
    })
  })

  // ─── Start ───

  const actualPort = await new Promise<number>((resolve, reject) => {
    const tryPort = options.port ?? 0
    server.listen(tryPort, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        resolve(addr.port)
      } else {
        reject(new Error('Failed to bind UI server'))
      }
    })
    server.on('error', reject)
  })

  // Discover tests and start screen polling
  await discoverAllFiles()
  scheduleScreenPoll()

  // Open browser
  const viewerUrl = `http://127.0.0.1:${actualPort}/`
  try {
    const open = await import('open')
    await open.default(viewerUrl)
  } catch {
    console.log(`Pilot UI: ${viewerUrl}`)
  }

  console.log(`\x1b[1mPilot UI mode\x1b[0m running at ${viewerUrl}`)
  console.log(`\x1b[2mDevice: ${ctx.deviceSerial} | ${ctx.testFiles.length} test file(s)\x1b[0m`)

  // Send device info
  broadcast({
    type: 'device-info',
    serial: ctx.deviceSerial,
    model: undefined,
    isEmulator: ctx.deviceSerial.startsWith('emulator-'),
  })

  return {
    port: actualPort,
    close: () => {
      if (screenPollTimer) clearTimeout(screenPollTimer)
      if (activeChild) {
        try { activeChild.kill() } catch { /* already dead */ }
      }
      if (watcher) watcher.close()
      for (const ws of clients) ws.close()
      wss.close()
      server.close()

      ctx.device.close()
      ctx.client.close()
      preserveEmulatorsForReuse(ctx.launchedEmulators)
    },
  }
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
</html>`
}
