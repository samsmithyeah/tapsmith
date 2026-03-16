/**
 * E2E test harness — connects to daemon, sets up the device, and runs
 * Pilot test files using the real SDK.
 *
 * Usage: npx tsx e2e/run-tests.mjs [test-files...]
 */

import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pilotDist = resolve(__dirname, '../packages/pilot/dist')

const { PilotGrpcClient } = await import(resolve(pilotDist, 'grpc-client.js'))
const { Device } = await import(resolve(pilotDist, 'device.js'))
const { loadConfig } = await import(resolve(pilotDist, 'config.js'))
const { runTestFile, collectResults } = await import(resolve(pilotDist, 'runner.js'))

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'

// ── Load config ──

const config = await loadConfig(__dirname)

// ── Connect to daemon ──

console.log(`${CYAN}Connecting to Pilot daemon...${RESET}`)
const client = new PilotGrpcClient(config.daemonAddress)
const ready = await client.waitForReady(5000)
if (!ready) {
  console.error(`${RED}Failed to connect to daemon at ${config.daemonAddress}${RESET}`)
  process.exit(1)
}

const pong = await client.ping()
console.log(`${DIM}Daemon v${pong.version}${RESET}`)

const device = new Device(client, config)

// ── Set device ──

const serial = config.device ?? 'emulator-5554'
await device.setDevice(serial)
console.log(`${DIM}Device: ${serial}${RESET}`)

// ── Wake and unlock ──

try {
  await device.wake()
  await device.unlock()
  console.log(`${DIM}Screen unlocked.${RESET}`)
} catch {
  // Non-fatal
}

// ── Start agent (with auto-install) ──

const agentApk = config.agentApk
  ? resolve(__dirname, config.agentApk)
  : undefined
const agentTestApk = config.agentTestApk
  ? resolve(__dirname, config.agentTestApk)
  : undefined

try {
  await device.startAgent('', agentApk, agentTestApk)
  console.log(`${DIM}Agent connected.${RESET}`)
} catch (err) {
  console.error(`${RED}Failed to start agent: ${err.message}${RESET}`)
  process.exit(1)
}

// ── Discover test files ──

const testFiles = process.argv.slice(2)
if (testFiles.length === 0) {
  console.error(`${RED}No test files specified.${RESET}`)
  process.exit(1)
}

console.log('')

// ── Run tests ──

const allResults = []
const totalStart = Date.now()

for (const filePath of testFiles) {
  const absPath = resolve(filePath)
  const result = await runTestFile(absPath, {
    config,
    device,
    screenshotDir: resolve(__dirname, 'pilot-results'),
  })
  allResults.push(result)
}

// ── Print summary ──

const totalMs = Date.now() - totalStart
const tests = allResults.flatMap(suite => collectResults(suite))
const passCount = tests.filter(t => t.status === 'passed').length
const failCount = tests.filter(t => t.status === 'failed').length
const skipCount = tests.filter(t => t.status === 'skipped').length

console.log(`\n${BOLD}═══════════════════════════════════${RESET}`)
console.log(`  ${GREEN}${passCount} passed${RESET}${failCount > 0 ? `, ${RED}${failCount} failed${RESET}` : ''}${skipCount > 0 ? `, ${DIM}${skipCount} skipped${RESET}` : ''} ${DIM}| ${(totalMs / 1000).toFixed(2)}s${RESET}`)
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`)

client.close()
process.exit(failCount > 0 ? 1 : 0)
