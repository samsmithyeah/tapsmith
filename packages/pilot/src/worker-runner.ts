/**
 * Worker child process entry point for parallel test execution.
 *
 * Each worker is forked by the dispatcher and assigned a dedicated device.
 * It receives test files to run via IPC, executes them sequentially, and
 * sends results back to the main process.
 *
 * @see PILOT-106
 */

import * as path from 'node:path'
import { PilotGrpcClient } from './grpc-client.js'
import { Device } from './device.js'
import { runTestFile, collectResults } from './runner.js'
import type { PilotConfig } from './config.js'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  InitMessage,
  SerializedConfig,
} from './worker-protocol.js'
import { serializeTestResult, serializeSuiteResult } from './worker-protocol.js'

let workerId = -1
let device: Device | undefined
let client: PilotGrpcClient | undefined
let config: PilotConfig | undefined

function send(msg: WorkerToMainMessage): void {
  if (process.send) {
    process.send(msg)
  }
}

function configFromSerialized(s: SerializedConfig, daemonAddress: string): PilotConfig {
  return {
    timeout: s.timeout,
    retries: s.retries,
    screenshot: s.screenshot,
    testMatch: [],
    daemonAddress,
    rootDir: s.rootDir,
    outputDir: s.outputDir,
    package: s.package,
    agentApk: s.agentApk,
    agentTestApk: s.agentTestApk,
    workers: 1,
    fullyParallel: false,
  }
}

async function handleInit(msg: InitMessage): Promise<void> {
  workerId = msg.workerId
  const daemonAddress = `localhost:${msg.daemonPort}`

  config = configFromSerialized(msg.config, daemonAddress)

  // Connect to our dedicated daemon
  client = new PilotGrpcClient(daemonAddress)
  const ready = await client.waitForReady(10_000)
  if (!ready) {
    throw new Error(`Worker ${workerId}: Failed to connect to daemon at ${daemonAddress}`)
  }

  device = new Device(client, config)

  // Set the assigned device
  if (msg.deviceSerial) {
    await device.setDevice(msg.deviceSerial)
  }

  // Start agent
  const resolvedAgentApk = config.agentApk
    ? path.resolve(config.rootDir, config.agentApk)
    : undefined
  const resolvedAgentTestApk = config.agentTestApk
    ? path.resolve(config.rootDir, config.agentTestApk)
    : undefined
  await device.startAgent('', resolvedAgentApk, resolvedAgentTestApk)

  // Launch app under test
  if (config.package) {
    try { await device.terminateApp(config.package) } catch { /* may not be running */ }
    await device.launchApp(config.package)
  }

  send({ type: 'ready', workerId })
}

async function handleRunFile(filePath: string): Promise<void> {
  if (!config || !device) {
    throw new Error(`Worker ${workerId}: Not initialized`)
  }

  send({ type: 'file-start', workerId, filePath })

  // Reset app between files for isolation
  if (config.package) {
    try { await device.terminateApp(config.package) } catch { /* app may not be running */ }
    await device.launchApp(config.package)
  }

  const screenshotDir =
    config.screenshot !== 'never'
      ? path.resolve(config.rootDir, config.outputDir, 'screenshots')
      : undefined

  // Create a reporter proxy that sends events back to main process
  const reporterProxy = {
    onTestEnd(result: import('./runner.js').TestResult): void {
      send({
        type: 'test-end',
        workerId,
        result: serializeTestResult(result, workerId),
      })
    },
  }

  const suiteResult = await runTestFile(filePath, {
    config,
    device,
    screenshotDir,
    reporter: reporterProxy,
  })

  const results = collectResults(suiteResult)

  send({
    type: 'file-done',
    workerId,
    filePath,
    suite: serializeSuiteResult(suiteResult, workerId),
    results: results.map((r) => serializeTestResult(r, workerId)),
  })
}

function handleShutdown(): void {
  if (device) {
    device.close()
  }
  process.exit(0)
}

// ─── IPC message handler ───

process.on('message', async (msg: MainToWorkerMessage) => {
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg)
        break
      case 'run-file':
        await handleRunFile(msg.filePath)
        break
      case 'shutdown':
        handleShutdown()
        break
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    send({
      type: 'error',
      workerId,
      error: { message: error.message, stack: error.stack },
    })
  }
})
