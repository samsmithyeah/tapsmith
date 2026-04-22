import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { PilotGrpcClient } from '../grpc-client.js';
import { findDaemonBin } from '../daemon-bin.js';
import { pickFreePort } from '../port-utils.js';
import { loadConfig, type PilotConfig } from '../config.js';

const DEFAULT_ADDRESS = 'localhost:50051';

let _client: PilotGrpcClient | null = null;
let _daemonProcess: ChildProcess | null = null;
let _daemonAddress: string | null = null;
let _ready = false;

export function getDaemonAddress(): string | null {
  return _daemonAddress;
}

export async function ensureConnected(): Promise<PilotGrpcClient> {
  if (_client && _ready) {
    const alive = await _client.waitForReady(1_000);
    if (alive) return _client;
    _client.close();
    _client = null;
    _ready = false;
  }

  const config = await loadConfig().catch(() => null);

  // 1. Try connecting to an existing daemon (e.g. from `pilot test --ui`)
  const address = process.env.PILOT_DAEMON_ADDRESS
    ?? config?.daemonAddress
    ?? DEFAULT_ADDRESS;
  const probe = new PilotGrpcClient(address);
  const existing = await probe.waitForReady(1_000);
  if (existing) {
    _client = probe;
    const { agentConnected } = await _client.ping();
    if (agentConnected) {
      log('Connected to existing daemon (agent already running)');
      _daemonAddress = address;
      _ready = true;
      return _client;
    }
    log('Connected to existing daemon, starting agent...');
    await startAgentFromConfig(_client, config);
    _daemonAddress = address;
    _ready = true;
    return _client;
  }
  probe.close();

  // 2. Start our own daemon
  log('No daemon found, starting one...');
  const platform = config?.platform;
  const port = String(await pickFreePort());
  const bin = findDaemonBin();
  const daemonArgs = ['--port', port];
  if (platform) daemonArgs.push('--platform', platform);

  _daemonProcess = spawn(bin, daemonArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  _daemonProcess.unref();
  _daemonProcess.on('error', (err) => { log(`Daemon process error: ${err.message}`); });
  _daemonProcess.stderr?.on('data', (data: Buffer) => { log(`Daemon: ${data.toString().trim()}`); });

  const client = new PilotGrpcClient(`127.0.0.1:${port}`);
  const started = await client.waitForReady(10_000);
  if (!started) {
    _daemonProcess.kill();
    _daemonProcess = null;
    throw new Error(
      'Failed to start Pilot daemon. Is pilot-core installed? ' +
      'Set PILOT_DAEMON_BIN to an explicit path if it lives elsewhere.',
    );
  }

  _client = client;
  _daemonAddress = `127.0.0.1:${port}`;
  const { version } = await client.ping();
  log(`Started daemon v${version} on port ${port}`);

  // Set device and start agent
  await setDeviceAndAgent(client, config);
  _ready = true;
  return _client;
}

async function setDeviceAndAgent(
  client: PilotGrpcClient,
  config: PilotConfig | null,
): Promise<void> {
  // Pick a device
  let serial: string | undefined;

  if (config?.device) {
    serial = config.device;
  } else {
    const { devices } = await client.listDevices();
    const best = devices.find(d => d.state === 'Active' || d.state === 'online')
      ?? devices.find(d => d.state === 'Discovered');
    serial = best?.serial;
  }

  if (!serial) {
    log('No devices found — device tools will fail until one is connected');
    return;
  }

  await client.setDevice(serial);
  log(`Using device: ${serial}`);
  await startAgentFromConfig(client, config);
}

async function startAgentFromConfig(
  client: PilotGrpcClient,
  config: PilotConfig | null,
): Promise<void> {
  // Check if agent is already connected
  const { agentConnected } = await client.ping();
  if (agentConnected) return;

  const rootDir = config?.rootDir ?? process.cwd();
  const agentApk = config?.agentApk ? path.resolve(rootDir, config.agentApk) : undefined;
  const agentTestApk = config?.agentTestApk ? path.resolve(rootDir, config.agentTestApk) : undefined;

  let iosXctestrun = config?.iosXctestrun
    ? path.resolve(rootDir, config.iosXctestrun)
    : undefined;

  // Auto-detect xctestrun for iOS if not configured
  if (!iosXctestrun && config?.platform === 'ios') {
    try {
      const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
      iosXctestrun = findSimulatorXctestrun() ?? undefined;
    } catch {
      // Not on macOS or no xctestrun built
    }
  }

  try {
    log('Starting agent on device...');
    await client.startAgent(
      config?.package ?? '',
      agentApk,
      agentTestApk,
      iosXctestrun,
    );
    log('Agent started');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Warning: agent start failed (${msg}). Device tools may not work.`);
  }
}

function log(msg: string): void {
  process.stderr.write(`[pilot-mcp] ${msg}\n`);
}

export function closeClient(): void {
  if (_client) {
    _client.close();
    _client = null;
  }
  if (_daemonProcess) {
    _daemonProcess.kill();
    _daemonProcess = null;
  }
  _daemonAddress = null;
  _ready = false;
}
