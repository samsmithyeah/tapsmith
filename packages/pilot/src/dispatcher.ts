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
import { resolveDeviceStrategy, type PilotConfig } from './config.js'
import { PilotGrpcClient } from './grpc-client.js'
import type { TestResult, SuiteResult } from './runner.js'
import type { PilotReporter, FullResult } from './reporter.js'
import type {
  WorkerToMainMessage,
  MainToWorkerMessage,
  SerializedConfig,
} from './worker-protocol.js'
import { deserializeTestResult, deserializeSuiteResult } from './worker-protocol.js'
import {
  provisionEmulators,
  cleanupEmulators,
  filterHealthyDevices,
  getRunningAvdName,
  selectDevicesForStrategy,
  type DeviceHealthResult,
  type LaunchedEmulator,
} from './emulator.js'

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
  currentFile?: string
  retired?: boolean
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
  const deviceStrategy = resolveDeviceStrategy(config)

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

  const healthyOnline = filterHealthyDevices(onlineDevices.map((d) => d.serial))
  warnUnhealthyDevices(healthyOnline.unhealthyDevices)
  const selectedOnline = selectDevicesForStrategy(
    healthyOnline.healthySerials,
    deviceStrategy,
    config.avd,
  )
  warnSkippedDevices(selectedOnline.skippedDevices)

  // Auto-launch emulators if enabled and we don't have enough devices
  let launchedEmulators: LaunchedEmulator[] = []
  let deviceSerials: string[]

  if (
    config.launchEmulators &&
    selectedOnline.selectedSerials.length < Math.min(opts.workers, testFiles.length)
  ) {
    const provision = await provisionEmulators({
      existingSerials: selectedOnline.selectedSerials,
      occupiedSerials: healthyOnline.healthySerials,
      workers: Math.min(opts.workers, testFiles.length),
      avd: config.avd,
    })
    launchedEmulators = provision.launched
    const healthyProvisioned = filterHealthyDevices(provision.allSerials)
    warnUnhealthyDevices(healthyProvisioned.unhealthyDevices)
    const selectedProvisioned = selectDevicesForStrategy(
      healthyProvisioned.healthySerials,
      deviceStrategy,
      config.avd,
    )
    warnSkippedDevices(selectedProvisioned.skippedDevices)
    deviceSerials = selectedProvisioned.selectedSerials
  } else {
    deviceSerials = selectedOnline.selectedSerials
  }

  if (deviceSerials.length === 0) {
    throw new Error(
      'No online devices found. Connect a device, start an emulator, ' +
      'or set `launchEmulators: true` in your config.',
    )
  }

  const workers: WorkerHandle[] = []
  const fileQueue = [...testFiles]
  const allResults: TestResult[] = []
  const allSuites: SuiteResult[] = []
  const totalStart = Date.now()
  const maxUsefulWorkers = Math.min(opts.workers, testFiles.length)
  let firstDaemonAssigned = false

  try {
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

    for (let workerId = 0; workerId < maxUsefulWorkers && workerId < deviceSerials.length; workerId++) {
      let initializedWorker: WorkerHandle | undefined
      let lastInitError: unknown

      for (let candidateIndex = workerId; candidateIndex < deviceSerials.length; candidateIndex++) {
        const candidateSerial = deviceSerials[candidateIndex]
        if (workers.some((w) => w.deviceSerial === candidateSerial)) continue

        try {
          const worker = await initializeWorker({
            workerId,
            deviceSerial: candidateSerial,
            daemonBin,
            serializedConfig,
            baseDaemonPort,
            baseAgentPort,
            firstDaemon,
            resolvedScript,
            tsxBin,
          })
          if (worker.id === 0) firstDaemonAssigned = true
          workers.push(worker)
          initializedWorker = worker
          break
        } catch (err) {
          lastInitError = err
          process.stderr.write(
            `${YELLOW}Skipping device ${candidateSerial}: ${err instanceof Error ? err.message : err}.${RESET}\n`,
          )
        }
      }

      if (!initializedWorker) {
        if (lastInitError && workers.length === 0) {
          throw lastInitError instanceof Error ? lastInitError : new Error(String(lastInitError))
        }
        break
      }
    }

    const workerCount = workers.length

    if (workerCount === 0) {
      throw new Error(
        'No worker-ready devices found. Start healthy emulators or devices, ' +
        'or set `launchEmulators: true` in your config.',
      )
    }

    if (workerCount < opts.workers) {
      const reason = testFiles.length < opts.workers && workerCount === testFiles.length
        ? `only ${testFiles.length} test file(s) to run`
        : `only ${workerCount} healthy worker-ready device(s) available`
      process.stderr.write(
        `${YELLOW}Warning: Requested ${opts.workers} workers but ${reason}. Using ${workerCount} worker(s).${RESET}\n`,
      )
    }

    process.stderr.write(
      `${DIM}Running ${testFiles.length} test file(s) across ${workerCount} worker(s)${RESET}\n`,
    )

    // Work-stealing distribution loop
    await new Promise<void>((resolve, reject) => {
      let hasError = false
      let settled = false

      function maybeResolve(): void {
        if (settled || hasError) return
        if (fileQueue.length > 0) return
        if (workers.every((w) => w.retired || !w.busy)) {
          settled = true
          resolve()
        }
      }

      function failRun(error: Error): void {
        if (settled || hasError) return
        hasError = true
        settled = true
        reject(error)
      }

      function dispatchNext(worker: WorkerHandle): void {
        if (worker.retired) return

        const nextFile = fileQueue.shift()
        if (!nextFile) {
          worker.busy = false
          worker.currentFile = undefined
          maybeResolve()
          return
        }

        worker.busy = true
        worker.currentFile = nextFile
        reporter.onTestFileStart?.(nextFile)

        const msg: MainToWorkerMessage = { type: 'run-file', filePath: nextFile }
        worker.process.send(msg)
      }

      function retireWorker(worker: WorkerHandle, reason: string): void {
        if (worker.retired) return

        worker.retired = true
        const inFlightFile = worker.currentFile
        worker.currentFile = undefined
        worker.busy = false

        cleanupWorkerResources(worker)

        if (inFlightFile) {
          fileQueue.unshift(inFlightFile)
          process.stderr.write(
            `${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) became unavailable: ${reason}. Requeueing ${path.basename(inFlightFile)} and continuing with remaining workers.${RESET}\n`,
          )
        } else {
          process.stderr.write(
            `${YELLOW}Worker ${worker.id} (${worker.deviceSerial}) became unavailable: ${reason}. Continuing with remaining workers.${RESET}\n`,
          )
        }

        const activeWorkers = workers.filter((w) => !w.retired)
        if (activeWorkers.length === 0) {
          failRun(
            new Error(
              `All workers became unavailable before the run completed. Last failure: ${reason}`,
            ),
          )
          return
        }

        const idleWorker = activeWorkers.find((w) => !w.busy)
        if (idleWorker) {
          dispatchNext(idleWorker)
        }

        maybeResolve()
      }

      for (const worker of workers) {
        worker.process.on('message', (msg: WorkerToMainMessage) => {
          if (hasError || worker.retired) return

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
              worker.currentFile = undefined
              const results = msg.results.map(deserializeTestResult)
              const suite = deserializeSuiteResult(msg.suite)
              allResults.push(...results)
              allSuites.push(suite)

              reporter.onTestFileEnd?.(msg.filePath, results)

              dispatchNext(worker)
              break
            }
            case 'error': {
              retireWorker(worker, msg.error.message)
              break
            }
          }
        })

        worker.process.on('exit', (code) => {
          if (code !== 0 && !hasError && !worker.retired) {
            retireWorker(worker, `exited unexpectedly with code ${code}`)
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

    if (!firstDaemonAssigned) {
      try {
        firstDaemon.kill()
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

function cleanupWorkerResources(worker: WorkerHandle): void {
  try {
    if (worker.process.connected) {
      worker.process.kill()
    }
  } catch { /* already dead */ }

  try {
    worker.daemonProcess?.kill()
  } catch { /* already dead */ }

  try {
    execFileSync('adb', ['-s', worker.deviceSerial, 'forward', '--remove', `tcp:${worker.agentPort}`], {
      timeout: 5_000,
      stdio: 'ignore',
    })
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
  tsxBin?: string
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
    tsxBin,
  } = opts

  const daemonPort = baseDaemonPort + 1 + workerId
  const agentPort = baseAgentPort + 1 + workerId

  let daemonProcess: ChildProcess | undefined
  if (workerId === 0) {
    daemonProcess = firstDaemon
  } else {
    daemonProcess = spawn(
      daemonBin,
      ['--port', String(daemonPort), '--agent-port', String(agentPort)],
      { detached: true, stdio: 'ignore' },
    )
    daemonProcess.unref()
    daemonProcess.on('error', (err) => {
      process.stderr.write(`Daemon for worker ${workerId} failed to start: ${err.message}\n`)
    })

    const client = new PilotGrpcClient(`localhost:${daemonPort}`)
    const ready = await client.waitForReady(10_000)
    client.close()
    if (!ready) {
      try { daemonProcess.kill() } catch { /* already dead */ }
      throw new Error(`worker daemon on port ${daemonPort} did not become ready`)
    }
  }

  const child = fork(resolvedScript, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    ...(tsxBin ? { execPath: tsxBin } : {}),
    env: {
      ...process.env,
      PILOT_WORKER_ID: String(workerId),
    },
  })

  const worker: WorkerHandle = {
    id: workerId,
    process: child,
    deviceSerial,
    daemonPort,
    agentPort,
    daemonProcess,
    busy: false,
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`worker ${workerId} timed out during initialization`))
      }, 90_000)

      const onExit = (code: number | null) => {
        if (code !== 0) {
          clearTimeout(timeout)
          cleanup()
          reject(new Error(`worker ${workerId} exited with code ${code} during initialization`))
        }
      }

      const onMessage = (msg: WorkerToMainMessage) => {
        if (msg.type === 'ready' && msg.workerId === worker.id) {
          clearTimeout(timeout)
          cleanup()
          resolve()
        } else if (msg.type === 'error' && msg.workerId === worker.id) {
          clearTimeout(timeout)
          cleanup()
          reject(new Error(msg.error.message))
        }
      }

      const cleanup = () => {
        worker.process.removeListener('exit', onExit)
        worker.process.removeListener('message', onMessage)
      }

      worker.process.on('exit', onExit)
      worker.process.on('message', onMessage)

      const initMsg: MainToWorkerMessage = {
        type: 'init',
        workerId: worker.id,
        deviceSerial: worker.deviceSerial,
        daemonPort: worker.daemonPort,
        config: serializedConfig,
      }
      worker.process.send(initMsg)
    })

    return worker
  } catch (err) {
    try {
      if (worker.process.connected) {
        worker.process.kill()
      }
    } catch { /* already dead */ }

    if (workerId !== 0) {
      try { daemonProcess?.kill() } catch { /* already dead */ }
    }

    try {
      execFileSync('adb', ['-s', deviceSerial, 'forward', '--remove', `tcp:${agentPort}`], {
        timeout: 5_000,
        stdio: 'ignore',
      })
    } catch { /* forward may not exist */ }

    throw err
  }
}

function warnUnhealthyDevices(devices: DeviceHealthResult[]): void {
  for (const device of devices) {
    const avd = device.serial.startsWith('emulator-') ? getRunningAvdName(device.serial) : undefined
    const label = avd ? `${device.serial} (${avd})` : device.serial
    process.stderr.write(
      `${YELLOW}Skipping unhealthy device ${label}: ${device.reason ?? 'unknown health check failure'}.${RESET}\n`,
    )
  }
}

function warnSkippedDevices(devices: Array<{ serial: string; reason: string }>): void {
  for (const device of devices) {
    process.stderr.write(
      `${YELLOW}Skipping device ${device.serial}: ${device.reason}.${RESET}\n`,
    )
  }
}
