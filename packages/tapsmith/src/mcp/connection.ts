import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { TapsmithGrpcClient, type DeviceInfoProto } from '../grpc-client.js';
import { findDaemonBin } from '../daemon-bin.js';
import { pickFreePort } from '../port-utils.js';
import type { TapsmithConfig, NotificationPermissionState } from '../config.js';
import { loadMcpConfig } from './config-loader.js';
import { uiPortFilePath } from './port-file.js';

const DEFAULT_ADDRESS = 'localhost:50051';

// ─── Connection Pool ───

interface DaemonConnection {
  client: TapsmithGrpcClient
  address: string
  devices: string[]
  daemonProcess?: ChildProcess
}

let _connections: DaemonConnection[] = [];
let _deviceIndex: Map<string, DaemonConnection> = new Map();
let _sessionDevices: Set<string> | null = null;
let _ready = false;
let _connectingPromise: Promise<void> | null = null;
let _configFile: string | undefined;

export function configureMcpConnection(options?: { configFile?: string }): void {
  _configFile = options?.configFile;
}

export function getSessionDeviceSerials(): Set<string> | null {
  return _sessionDevices;
}

export function getAllDaemonAddresses(): string | null {
  if (_connections.length === 0) return null;
  return _connections.map(c => c.address).join(',');
}

export async function ensureConnected(device?: string): Promise<TapsmithGrpcClient> {
  if (_ready && _connections.length > 0) {
    if (device) {
      const conn = _deviceIndex.get(device);
      if (conn) {
        const alive = await conn.client.waitForReady(1_000);
        if (alive) return conn.client;
        removeConnection(conn);
      }
      // Device not found or daemon died — re-discover (new daemons may have started)
      _ready = false;
    } else {
      // No specific device — return default
      const defaultConn = _connections[0];
      const alive = await defaultConn.client.waitForReady(1_000);
      if (alive) return defaultConn.client;
      removeConnection(defaultConn);
      // Fall through to re-discover
      _ready = false;
    }
  }

  // First-time init (with mutex to prevent concurrent discovery)
  if (_connectingPromise) {
    await _connectingPromise;
    return ensureConnected(device);
  }
  _connectingPromise = discover();
  try {
    await _connectingPromise;
  } finally {
    _connectingPromise = null;
  }

  if (_connections.length === 0) {
    throw new Error(
      'No Tapsmith daemons found or started. Is tapsmith-core installed? ' +
      'Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.',
    );
  }

  _ready = true;

  if (device) {
    const conn = _deviceIndex.get(device);
    if (conn) return conn.client;
    const available = [..._deviceIndex.keys()];
    throw new Error(
      `Device "${device}" not found in any connected daemon. ` +
      `Available devices: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }

  return _connections[0].client;
}

export async function listAllDevices(): Promise<DeviceInfoProto[]> {
  await ensureConnected();
  const perConn = await Promise.all(_connections.map(async (conn) => {
    try {
      const { devices } = await conn.client.listDevices();
      return devices;
    } catch {
      return [];
    }
  }));
  const all: DeviceInfoProto[] = [];
  const seen = new Set<string>();
  for (const devices of perConn) {
    for (const d of devices) {
      if (!seen.has(d.serial)) {
        seen.add(d.serial);
        all.push(d);
      }
    }
  }
  return all;
}

// ─── Discovery ───

async function discover(): Promise<void> {
  const config = await loadMcpConfig(_configFile).then((result) => result.config).catch(() => null);

  // Collect candidate addresses from all sources
  const candidates = new Set<string>();

  // 1. Env var (supports comma-separated for multi-daemon)
  if (process.env.TAPSMITH_DAEMON_ADDRESS) {
    for (const addr of process.env.TAPSMITH_DAEMON_ADDRESS.split(',')) {
      const trimmed = addr.trim();
      if (trimmed) candidates.add(trimmed);
    }
  }

  // 2. Config file
  if (config?.daemonAddress) {
    candidates.add(config.daemonAddress);
  }

  // 3. UI mode discovery — query the UI server for worker daemon ports
  const uiDaemons = await discoverFromUiServer();
  for (const addr of uiDaemons.addresses) {
    candidates.add(addr);
  }
  if (uiDaemons.deviceSerials.size > 0) {
    _sessionDevices = uiDaemons.deviceSerials;
  }

  // 4. Include existing connections so re-discovery doesn't spawn redundant daemons
  for (const conn of _connections) {
    candidates.add(conn.address);
  }

  // 5. Default address
  if (candidates.size === 0) {
    candidates.add(DEFAULT_ADDRESS);
  }

  // Probe all candidates in parallel
  const probes = [...candidates].map(async (address) => {
    let client: TapsmithGrpcClient | undefined;
    try {
      client = new TapsmithGrpcClient(address);
      const alive = await client.waitForReady(1_000);
      if (alive) return { client, address };
      client.close();
    } catch {
      client?.close();
    }
    return null;
  });
  const results = await Promise.all(probes);
  const live = results.filter((r): r is { client: TapsmithGrpcClient; address: string } => r !== null);

  if (live.length > 0) {
    // Connect to all live daemons in parallel, then batch-update shared state
    const newConns = await Promise.all(live.map(async ({ client, address }) => {
      if (_connections.some(c => c.address === address)) {
        client.close();
        return null;
      }
      try {
        const { agentConnected } = await client.ping();
        if (!agentConnected) {
          await startAgentFromConfig(client, config);
        }
        log(`Connected to daemon at ${address}`);
        return { client, address, devices: [] } as DaemonConnection;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to connect to daemon at ${address}: ${msg}`);
        client.close();
        return null;
      }
    }));
    _connections.push(...newConns.filter((c): c is DaemonConnection => c !== null));
    await refreshDeviceIndex();
    return;
  }

  // 5. No live daemons — start our own
  log('No daemon found, starting one...');
  const platform = config?.platform;
  const port = String(await pickFreePort());
  const bin = findDaemonBin();
  const daemonArgs = ['--port', port];
  if (platform) daemonArgs.push('--platform', platform);

  const daemonProcess = spawn(bin, daemonArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  daemonProcess.unref();
  daemonProcess.on('error', (err) => { log(`Daemon process error: ${err.message}`); });
  daemonProcess.stderr?.on('data', (data: Buffer) => { log(`Daemon: ${data.toString().trim()}`); });

  const client = new TapsmithGrpcClient(`127.0.0.1:${port}`);
  const started = await client.waitForReady(10_000);
  if (!started) {
    client.close();
    daemonProcess.kill();
    log('Failed to start daemon. Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.');
    return;
  }

  try {
    const { version } = await client.ping();
    log(`Started daemon v${version} on port ${port}`);
    await setDeviceAndAgent(client, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Daemon started but setup failed: ${msg}`);
    client.close();
    daemonProcess.kill();
    return;
  }

  const conn: DaemonConnection = {
    client,
    address: `127.0.0.1:${port}`,
    devices: [],
    daemonProcess,
  };
  _connections.push(conn);
  await refreshDeviceIndex();
}

interface UiDiscoveryResult {
  addresses: string[]
  deviceSerials: Set<string>
}

const EMPTY_DISCOVERY: UiDiscoveryResult = { addresses: [], deviceSerials: new Set() };

async function discoverFromUiServer(): Promise<UiDiscoveryResult> {
  let portFileContent: string;
  try {
    portFileContent = (await fs.promises.readFile(uiPortFilePath(), 'utf-8')).trim();
  } catch {
    return EMPTY_DISCOVERY;
  }
  const uiMcpPort = Number.parseInt(portFileContent, 10);
  if (!Number.isFinite(uiMcpPort) || uiMcpPort <= 0) return EMPTY_DISCOVERY;

  try {
    const json = await httpGet(`http://127.0.0.1:${uiMcpPort}/api/daemon-ports`, 2_000);
    const data = JSON.parse(json) as { daemons?: Array<{ address: string; deviceSerial?: string }> };
    if (!Array.isArray(data.daemons)) return EMPTY_DISCOVERY;
    return {
      addresses: data.daemons.map(d => d.address).filter(Boolean),
      deviceSerials: new Set(data.daemons.map(d => d.deviceSerial).filter(Boolean) as string[]),
    };
  } catch (err) {
    log(`UI server discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_DISCOVERY;
  }
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Device Index ───

async function refreshDeviceIndex(): Promise<void> {
  const results = await Promise.all(_connections.map(async (conn) => {
    try {
      const { devices } = await conn.client.listDevices();
      return { conn, devices };
    } catch {
      return { conn, devices: [] as DeviceInfoProto[] };
    }
  }));
  _deviceIndex.clear();
  for (const { conn, devices } of results) {
    conn.devices = devices.map(d => d.serial);
    for (const d of devices) {
      if (!_deviceIndex.has(d.serial)) {
        _deviceIndex.set(d.serial, conn);
      } else if (_deviceIndex.get(d.serial) !== conn) {
        log(`Device ${d.serial} visible from multiple daemons — using ${_deviceIndex.get(d.serial)!.address}`);
      }
    }
  }
}

function removeConnection(conn: DaemonConnection): void {
  conn.client.close();
  if (conn.daemonProcess) conn.daemonProcess.kill();
  _connections = _connections.filter(c => c !== conn);
  for (const [serial, c] of _deviceIndex) {
    if (c === conn) _deviceIndex.delete(serial);
  }
}

// ─── Device & Agent Setup ───

async function setDeviceAndAgent(
  client: TapsmithGrpcClient,
  config: TapsmithConfig | null,
): Promise<void> {
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
  client: TapsmithGrpcClient,
  config: TapsmithConfig | null,
): Promise<void> {
  const { agentConnected } = await client.ping();
  if (agentConnected) return;

  const rootDir = config?.rootDir ?? process.cwd();
  const agentApk = config?.agentApk ? path.resolve(rootDir, config.agentApk) : undefined;
  const agentTestApk = config?.agentTestApk ? path.resolve(rootDir, config.agentTestApk) : undefined;

  let iosXctestrun = config?.iosXctestrun
    ? path.resolve(rootDir, config.iosXctestrun)
    : undefined;

  if (!iosXctestrun && config?.platform === 'ios') {
    try {
      const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
      iosXctestrun = findSimulatorXctestrun() ?? undefined;
    } catch {
      // Not on macOS or no xctestrun built
    }
  }

  // PILOT-291: keep the session's notification policy across MCP-triggered
  // agent starts — omitting it would relaunch the agent with the default
  // allow-first behavior and silently grant a permission the config denies.
  let notificationPermission: NotificationPermissionState | undefined;
  if (config?.platform === 'ios' && config.permissions?.notifications) {
    try {
      const { isPhysicalDevice } = await import('../ios-devicectl.js');
      const isPhys = !!config.device && isPhysicalDevice(config.device);
      notificationPermission = isPhys ? undefined : config.permissions.notifications;
    } catch {
      notificationPermission = config.permissions.notifications;
    }
  }

  try {
    log('Starting agent on device...');
    await client.startAgent(
      config?.package ?? '',
      agentApk,
      agentTestApk,
      iosXctestrun,
      undefined,
      false,
      notificationPermission,
    );
    log('Agent started');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Warning: agent start failed (${msg}). Device tools may not work.`);
  }
}

// ─── Utilities ───

function log(msg: string): void {
  process.stderr.write(`[tapsmith-mcp] ${msg}\n`);
}

export function closeAllClients(): void {
  for (const conn of _connections) {
    conn.client.close();
    if (conn.daemonProcess) conn.daemonProcess.kill();
  }
  _connections = [];
  _deviceIndex = new Map();
  _sessionDevices = null;
  _ready = false;
  _connectingPromise = null;
  _configFile = undefined;
}
