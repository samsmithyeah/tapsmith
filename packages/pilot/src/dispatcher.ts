/**
 * Parallel test dispatcher.
 *
 * Coordinates multiple worker processes, each assigned to a dedicated
 * device and daemon instance. Distributes test files using a work-stealing
 * queue for natural load balancing.
 *
 * @see PILOT-106
 */

import { fork, spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { PilotConfig } from './config.js'
import type { PilotGrpcClient } from './grpc-client.js'
import type { TestResult, SuiteResult } from './runner.js'
import type { PilotReporter, FullResult } from './reporter.js'
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  SerializedConfig,
} from './worker-protocol.js'
import { deserializeTestResult, deserializeSuiteResult } from './worker-protocol.js'

const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

interface WorkerHandle {
  id: number
  process: ChildProcess
  deviceSerial: string
  daemonPort: number
  daemonProcess?: ChildProcess
  busy: boolean
}

export interface DispatcherOptions {
  config: PilotConfig
  client: PilotGrpcClient
  reporter: PilotReporter
  testFiles: string[]
  workers: number
}

/**
 * Run test files in parallel across multiple workers/devices.
 * Returns a FullResult aggregating all worker results.
 */
export async function runParallel(opts: DispatcherOptions): Promise<FullResult> {
  const { config, client, reporter, testFiles } = opts

  // Discover available devices
  const deviceList = await client.listDevices()
  // Device states from pilot-core: "Discovered" (available), "Active" (in use), "Disconnected"
  const onlineDevices = deviceList.devices.filter((d) =>
    d.state === 'Discovered' || d.state === 'Active',
  )

  if (onlineDevices.length === 0) {
    throw new Error('No online devices found. Connect a device or start an emulator.')
  }

  const workerCount = Math.min(opts.workers, onlineDevices.length, testFiles.length)

  if (workerCount < opts.workers) {
    const reason = onlineDevices.length < opts.workers
      ? `only ${onlineDevices.length} device(s) available`
      : `only ${testFiles.length} test file(s) to run`
    process.stderr.write(
      `${YELLOW}Warning: Requested ${opts.workers} workers but ${reason}. Using ${workerCount} worker(s).${RESET}\n`,
    )
  }

  // Spawn a dedicated daemon per worker (each on a unique port)
  const baseDaemonPort = parseInt(config.daemonAddress.split(':').pop() ?? '50051', 10)
  const baseAgentPort = 18700
  const workers: WorkerHandle[] = []
  const fileQueue = [...testFiles]
  const allResults: TestResult[] = []
  const allSuites: SuiteResult[] = []
  const totalStart = Date.now()

  try {
    // Start daemons and workers
    for (let i = 0; i < workerCount; i++) {
      const daemonPort = baseDaemonPort + 1 + i
      const agentPort = baseAgentPort + 1 + i
      const deviceSerial = onlineDevices[i].serial

      // Spawn a dedicated pilot-core daemon for this worker
      const daemonBin = process.env.PILOT_DAEMON_BIN ?? config.daemonBin ?? 'pilot-core'
      const daemonProcess = spawn(
        daemonBin,
        ['--port', String(daemonPort), '--agent-port', String(agentPort)],
        { detached: true, stdio: 'ignore' },
      )
      daemonProcess.unref()
      daemonProcess.on('error', () => {
        // Handled via worker init failure
      })

      workers.push({
        id: i,
        process: undefined as unknown as ChildProcess,
        deviceSerial,
        daemonPort,
        daemonProcess,
        busy: false,
      })
    }

    // Wait briefly for daemons to start
    await new Promise((r) => setTimeout(r, 2_000))

    // Fork worker processes
    const workerScript = path.resolve(__dirname, 'worker-runner.js')
    // If running under tsx (TypeScript), use the .ts extension
    const resolvedScript = fs.existsSync(workerScript)
      ? workerScript
      : path.resolve(__dirname, 'worker-runner.ts')

    for (const worker of workers) {
      const child = fork(resolvedScript, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
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
            }, 30_000)

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
    // Cleanup: shut down all workers and daemons
    for (const worker of workers) {
      try {
        if (worker.process?.connected) {
          worker.process.send({ type: 'shutdown' } satisfies MainToWorkerMessage)
          // Give a short grace period, then force kill
          setTimeout(() => {
            try { worker.process.kill() } catch { /* already dead */ }
          }, 3_000)
        }
      } catch { /* worker may already be dead */ }

      try {
        worker.daemonProcess?.kill()
      } catch { /* daemon may already be dead */ }
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
