/**
 * Parallel test dispatcher.
 *
 * Coordinates multiple worker processes, each assigned to a dedicated
 * device and daemon instance. Distributes test files using a work-stealing
 * queue for natural load balancing.
 *
 * @see PILOT-106
 */

import { fork, spawn, execFileSync, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { PilotConfig } from './config.js'
import { PilotGrpcClient } from './grpc-client.js'
import type { TestResult, SuiteResult } from './runner.js'
import type { PilotReporter, FullResult } from './reporter.js'
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  SerializedConfig,
} from './worker-protocol.js'
import { deserializeTestResult, deserializeSuiteResult } from './worker-protocol.js'
import { provisionEmulators, cleanupEmulators, type LaunchedEmulator } from './emulator.js'

const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

interface WorkerHandle {
  id: number
  process: ChildProcess
  deviceSerial: string
  daemonPort: number
  agentPort: number
  daemonProcess?: ChildProcess
  busy: boolean
}

export interface DispatcherOptions {
  config: PilotConfig
  reporter: PilotReporter
  testFiles: string[]
  workers: number
}

/**
 * Run test files in parallel across multiple workers/devices.
 * Returns a FullResult aggregating all worker results.
 */
export async function runParallel(opts: DispatcherOptions): Promise<FullResult> {
  const { config, reporter, testFiles } = opts

  // Spawn the first worker daemon early so we can use it for device discovery.
  // This daemon will also serve as worker 0's daemon.
  const baseDaemonPort = Number.parseInt(config.daemonAddress.split(':').pop() ?? '50051', 10)
  const baseAgentPort = 18700
  const rawBin = process.env.PILOT_DAEMON_BIN ?? config.daemonBin ?? 'pilot-core'
  const daemonBin = rawBin.includes(path.sep) || rawBin.startsWith('.')
    ? path.resolve(config.rootDir, rawBin)
    : rawBin

  const firstDaemonPort = baseDaemonPort + 1
  const firstAgentPort = baseAgentPort + 1
  const firstDaemon = spawn(
    daemonBin,
    ['--port', String(firstDaemonPort), '--agent-port', String(firstAgentPort)],
    { detached: true, stdio: 'ignore' },
  )
  firstDaemon.unref()
  firstDaemon.on('error', () => {
    // Handled by the waitForReady timeout below
  })

  // Wait for daemon to be ready
  const discoveryClient = new PilotGrpcClient(`localhost:${firstDaemonPort}`)
  const ready = await discoveryClient.waitForReady(10_000)
  if (!ready) {
    firstDaemon.kill()
    throw new Error(`Failed to start worker daemon. Is pilot-core installed? (tried: ${daemonBin})`)
  }

  // Discover available devices
  const deviceList = await discoveryClient.listDevices()
  discoveryClient.close()
  // Device states from pilot-core: "Discovered" (available), "Active" (in use), "Disconnected"
  const onlineDevices = deviceList.devices.filter((d) =>
    d.state === 'Discovered' || d.state === 'Active',
  )

  // Auto-launch emulators if enabled and we don't have enough devices
  let launchedEmulators: LaunchedEmulator[] = []
  let deviceSerials: string[]

  if (config.launchEmulators && onlineDevices.length < Math.min(opts.workers, testFiles.length)) {
    const provision = await provisionEmulators({
      existingSerials: onlineDevices.map((d) => d.serial),
      workers: Math.min(opts.workers, testFiles.length),
      avd: config.avd,
    })
    launchedEmulators = provision.launched
    deviceSerials = provision.allSerials
  } else {
    deviceSerials = onlineDevices.map((d) => d.serial)
  }

  if (deviceSerials.length === 0) {
    throw new Error(
      'No online devices found. Connect a device, start an emulator, ' +
      'or set `launchEmulators: true` in your config.',
    )
  }

  const workerCount = Math.min(opts.workers, deviceSerials.length, testFiles.length)

  if (workerCount < opts.workers) {
    const reason = deviceSerials.length < opts.workers
      ? `only ${deviceSerials.length} device(s) available`
      : `only ${testFiles.length} test file(s) to run`
    process.stderr.write(
      `${YELLOW}Warning: Requested ${opts.workers} workers but ${reason}. Using ${workerCount} worker(s).${RESET}\n`,
    )
  }

  const workers: WorkerHandle[] = []
  const fileQueue = [...testFiles]
  const allResults: TestResult[] = []
  const allSuites: SuiteResult[] = []
  const totalStart = Date.now()

  try {
    // Start a dedicated daemon per worker (each on a unique port).
    // Worker 0 reuses the daemon we already spawned for discovery.
    for (let i = 0; i < workerCount; i++) {
      const daemonPort = baseDaemonPort + 1 + i
      const agentPort = baseAgentPort + 1 + i
      const deviceSerial = deviceSerials[i]

      let daemonProcess: ChildProcess | undefined
      if (i === 0) {
        // Reuse the daemon already spawned for discovery
        daemonProcess = firstDaemon
      } else {
        daemonProcess = spawn(
          daemonBin,
          ['--port', String(daemonPort), '--agent-port', String(agentPort)],
          { detached: true, stdio: 'ignore' },
        )
        daemonProcess.unref()
        daemonProcess.on('error', (err) => {
          process.stderr.write(`Daemon for worker ${i} failed to start: ${err.message}\n`)
        })
      }

      workers.push({
        id: i,
        process: undefined as unknown as ChildProcess,
        deviceSerial,
        daemonPort,
        agentPort,
        daemonProcess,
        busy: false,
      })
    }

    // Wait for additional daemons to start (worker 0's daemon is already ready)
    if (workerCount > 1) {
      await new Promise((r) => setTimeout(r, 2_000))
    }

    // Fork worker processes.
    // When running under tsx (TypeScript test files), __dirname points to src/
    // and we need to fork with tsx as the loader. When running from compiled JS,
    // __dirname points to dist/ and we can fork directly.
    const jsScript = path.resolve(__dirname, 'worker-runner.js')
    const tsScript = path.resolve(__dirname, 'worker-runner.ts')
    const useTypeScript = !fs.existsSync(jsScript) && fs.existsSync(tsScript)
    const resolvedScript = useTypeScript ? tsScript : jsScript

    // When forking a .ts file, we need tsx to handle it.
    let tsxBin: string | undefined
    if (useTypeScript) {
      const pilotPkgDir = path.resolve(__dirname, '..')
      const localTsx = path.join(pilotPkgDir, 'node_modules', '.bin', 'tsx')
      tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx'
    }

    for (const worker of workers) {
      const child = fork(resolvedScript, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        ...(tsxBin ? { execPath: tsxBin } : {}),
        env: {
          ...process.env,
          PILOT_WORKER_ID: String(worker.id),
        },
      })
      worker.process = child
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
    }

    // Initialize all workers and wait for ready
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error(`Worker ${worker.id} timed out during initialization`))
            }, 60_000)

            worker.process.on('exit', (code) => {
              if (code !== 0) {
                clearTimeout(timeout)
                reject(new Error(`Worker ${worker.id} exited with code ${code} during initialization`))
              }
            })

            const onMessage = (msg: WorkerToMainMessage) => {
              if (msg.type === 'ready' && msg.workerId === worker.id) {
                clearTimeout(timeout)
                worker.process.removeListener('message', onMessage)
                resolve()
              } else if (msg.type === 'error' && msg.workerId === worker.id) {
                clearTimeout(timeout)
                worker.process.removeListener('message', onMessage)
                reject(new Error(msg.error.message))
              }
            }

            worker.process.on('message', onMessage)

            const initMsg: MainToWorkerMessage = {
              type: 'init',
              workerId: worker.id,
              deviceSerial: worker.deviceSerial,
              daemonPort: worker.daemonPort,
              config: serializedConfig,
            }
            worker.process.send(initMsg)
          }),
      ),
    )

    process.stderr.write(
      `${DIM}Running ${testFiles.length} test file(s) across ${workerCount} worker(s)${RESET}\n`,
    )

    // Work-stealing distribution loop
    await new Promise<void>((resolve, reject) => {
      let hasError = false

      function dispatchNext(worker: WorkerHandle): void {
        const nextFile = fileQueue.shift()
        if (!nextFile) {
          worker.busy = false
          // Check if all workers are done
          if (workers.every((w) => !w.busy)) {
            resolve()
          }
          return
        }

        worker.busy = true
        reporter.onTestFileStart?.(nextFile)

        const msg: MainToWorkerMessage = { type: 'run-file', filePath: nextFile }
        worker.process.send(msg)
      }

      for (const worker of workers) {
        worker.process.on('message', (msg: WorkerToMainMessage) => {
          if (hasError) return

          switch (msg.type) {
            case 'test-end': {
              const result = deserializeTestResult(msg.result)
              reporter.onTestEnd?.(result)
              break
            }
            case 'file-start':
              // Already notified above in dispatchNext
              break
            case 'file-done': {
              const results = msg.results.map(deserializeTestResult)
              const suite = deserializeSuiteResult(msg.suite)
              allResults.push(...results)
              allSuites.push(suite)

              reporter.onTestFileEnd?.(msg.filePath, results)

              dispatchNext(worker)
              break
            }
            case 'error': {
              hasError = true
              reject(new Error(`Worker ${msg.workerId} error: ${msg.error.message}`))
              break
            }
          }
        })

        worker.process.on('exit', (code) => {
          if (code !== 0 && !hasError && worker.busy) {
            hasError = true
            reject(new Error(`Worker ${worker.id} exited unexpectedly with code ${code}`))
          }
        })

        // Start dispatching to each worker
        dispatchNext(worker)
      }
    })
  } finally {
    // Cleanup order matters: workers first, then daemons, then ADB state, then emulators.
    // This ensures nothing is using the resources when we clean them up.

    // 1. Shut down workers gracefully, then force-kill
    const workerExitPromises: Promise<void>[] = []
    for (const worker of workers) {
      try {
        if (worker.process?.connected) {
          const exitPromise = new Promise<void>((resolve) => {
            worker.process.once('exit', () => resolve())
            setTimeout(() => {
              try { worker.process.kill() } catch { /* already dead */ }
              resolve()
            }, 3_000)
          })
          worker.process.send({ type: 'shutdown' } satisfies MainToWorkerMessage)
          workerExitPromises.push(exitPromise)
        }
      } catch { /* worker may already be dead */ }
    }
    await Promise.all(workerExitPromises)

    // 2. Kill daemons
    for (const worker of workers) {
      try {
        worker.daemonProcess?.kill()
      } catch { /* daemon may already be dead */ }
    }

    // 3. Clean up ADB port forwards created by worker daemons.
    // Each daemon set up `adb forward tcp:<agentPort> tcp:18700` on its device.
    // Stale forwards break subsequent runs on the same device.
    for (const worker of workers) {
      try {
        execFileSync('adb', ['-s', worker.deviceSerial, 'forward', '--remove', `tcp:${worker.agentPort}`], {
          timeout: 5_000,
          stdio: 'ignore',
        })
      } catch { /* forward may already be gone */ }
    }

    // 4. Shut down any emulators we launched
    if (launchedEmulators.length > 0) {
      cleanupEmulators(launchedEmulators)
    }
  }

  const totalDuration = Date.now() - totalStart
  const hasFailed = allResults.some((r) => r.status === 'failed')

  return {
    status: hasFailed ? 'failed' : 'passed',
    duration: totalDuration,
    tests: allResults,
    suites: allSuites,
  }
}
