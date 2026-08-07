import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { TapsmithGrpcClient, type DeviceInfoProto } from '../grpc-client.js';
import { findDaemonBin } from '../daemon-bin.js';
import { pickFreePort } from '../port-utils.js';
import type { TapsmithConfig } from '../config.js';
import { loadMcpConfig } from './config-loader.js';
import { uiPortFilePath, mcpDaemonRegistryPath } from './port-file.js';

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

  // 5. Daemons started by other MCP sessions in this project. Without this each
  // session starts its own daemon on a random port and they pile up, all
  // driving the same device.
  for (const address of readDaemonRegistry()) {
    candidates.add(address);
  }

  // 6. Default address
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
  // Probing is the liveness check, so this is the moment we know which
  // registered daemons are gone. Drop them rather than re-probing dead ports
  // on every future session.
  pruneDaemonRegistry(live.map((l) => l.address));

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

  // 7. No live daemons — start our own
  const conn = await startDaemon(config?.platform);
  if (!conn) return;

  try {
    await setDeviceAndAgent(conn.client, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Daemon started but setup failed: ${msg}`);
    removeConnection(conn);
    unregisterDaemon(conn.address);
    return;
  }

  await refreshDeviceIndex();
}

/**
 * Start a daemon for `platform` and add it to the pool.
 *
 * A daemon only serves the platform it was started for, so a session spanning
 * Android and iOS needs one of each — hence this is callable outside the
 * initial discovery.
 */
async function startDaemon(platform?: string): Promise<DaemonConnection | null> {
  log(platform ? `Starting a ${platform} daemon...` : 'No daemon found, starting one...');
  const port = String(await pickFreePort());
  const bin = findDaemonBin();
  const daemonArgs = ['--port', port];
  if (platform) daemonArgs.push('--platform', platform);

  const daemonProcess = spawn(bin, daemonArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  daemonProcess.unref();
  daemonProcess.on('error', (err) => { log(`Daemon process error: ${err.message}`); });
  daemonProcess.stderr?.on('data', (data: Buffer) => { log(`Daemon: ${data.toString().trim()}`); });

  const address = `127.0.0.1:${port}`;
  const client = new TapsmithGrpcClient(address);
  const started = await client.waitForReady(10_000);
  if (!started) {
    client.close();
    daemonProcess.kill();
    log('Failed to start daemon. Is tapsmith-core installed? Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.');
    return null;
  }

  try {
    const { version } = await client.ping();
    log(`Started daemon v${version} on port ${port}${platform ? ` (${platform})` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Daemon started but did not respond: ${msg}`);
    client.close();
    daemonProcess.kill();
    return null;
  }

  registerDaemon(address);
  const conn: DaemonConnection = { client, address, devices: [], daemonProcess };
  _connections.push(conn);
  return conn;
}

// ─── Per-platform targets ───

export interface PlatformTarget {
  /** Address of the daemon serving this platform's device. */
  address: string
  deviceSerial: string
  platform?: string
}

/**
 * Resolve a daemon + device + running agent for one project's platform.
 *
 * A multi-platform config has no top-level `platform`, so the session-wide
 * setup could not tell which agent artifacts to use and started none: iOS
 * projects failed with "iOS agent is not configured" no matter how the run was
 * requested. Each project's *effective* config carries its own platform, app
 * and agent paths, so resolve a target per platform from that instead.
 */
export async function ensurePlatformTarget(config: TapsmithConfig): Promise<PlatformTarget> {
  await ensureConnected();
  const platform = config.platform;

  const existing = await findConnectionForPlatform(platform, config.device);
  if (existing) {
    await prepareTarget(existing.conn, existing.serial, config);
    return { address: existing.conn.address, deviceSerial: existing.serial, platform };
  }

  // No pooled daemon serves this platform — daemons are per-platform, so start one.
  const conn = await startDaemon(platform);
  if (!conn) {
    throw new Error(`Failed to start a ${platform ?? 'Tapsmith'} daemon. Is tapsmith-core installed?`);
  }
  const serial = await pickDevice(conn, platform, config.device);
  if (!serial) {
    await refreshDeviceIndex();
    throw new Error(
      `No ${platform ?? ''} device is available.`.replace('  ', ' ')
      + (platform === 'android'
        ? ' Start an emulator (or connect a device) and try again.'
        : platform === 'ios'
          ? ' Boot a simulator (or connect a device) and try again.'
          : ' Connect a device or start an emulator and try again.'),
    );
  }
  await prepareTarget(conn, serial, config);
  await refreshDeviceIndex();
  return { address: conn.address, deviceSerial: serial, platform };
}

async function findConnectionForPlatform(
  platform: string | undefined,
  wantedSerial: string | undefined,
): Promise<{ conn: DaemonConnection; serial: string } | null> {
  for (const conn of _connections) {
    const serial = await pickDevice(conn, platform, wantedSerial);
    if (serial) return { conn, serial };
  }
  return null;
}

async function pickDevice(
  conn: DaemonConnection,
  platform: string | undefined,
  wantedSerial: string | undefined,
): Promise<string | undefined> {
  let devices: DeviceInfoProto[];
  try {
    ({ devices } = await conn.client.listDevices());
  } catch {
    return undefined;
  }

  const candidates = platform ? devices.filter((d) => d.platform === platform) : devices;
  if (wantedSerial) return candidates.find((d) => d.serial === wantedSerial)?.serial;
  return (
    candidates.find((d) => d.state === 'Active' || d.state === 'online')
    ?? candidates.find((d) => d.state === 'Discovered')
    ?? candidates[0]
  )?.serial;
}

/** Point a daemon at a device and make sure its agent is running. */
async function prepareTarget(
  conn: DaemonConnection,
  serial: string,
  config: TapsmithConfig,
): Promise<void> {
  await conn.client.setDevice(serial);
  await startAgentFromConfig(conn.client, config);
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

// ─── Daemon Registry ───

/**
 * Addresses of daemons other MCP sessions in this project started.
 *
 * Best-effort throughout: a missing, unreadable or malformed registry just
 * means we fall back to starting our own daemon, which is what happened before
 * the registry existed. Liveness is never trusted from the file — every address
 * is probed like any other candidate.
 */
/** @internal — exported for unit testing. */
export function readDaemonRegistry(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(mcpDaemonRegistryPath(), 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === 'string');
  } catch {
    return [];
  }
}

function writeDaemonRegistry(addresses: string[]): void {
  try {
    const file = mcpDaemonRegistryPath();
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...new Set(addresses)]), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    // The registry is an optimisation; never fail a session over it.
  }
}

/** @internal — exported for unit testing. */
export function registerDaemon(address: string): void {
  writeDaemonRegistry([...readDaemonRegistry(), address]);
}

/** @internal — exported for unit testing. */
export function unregisterDaemon(address: string): void {
  const remaining = readDaemonRegistry().filter((a) => a !== address);
  writeDaemonRegistry(remaining);
}

/** Keep only addresses that just answered a probe. @internal — exported for unit testing. */
export function pruneDaemonRegistry(liveAddresses: string[]): void {
  const registered = readDaemonRegistry();
  if (registered.length === 0) return;
  const live = new Set(liveAddresses);
  const surviving = registered.filter((a) => live.has(a));
  if (surviving.length !== registered.length) writeDaemonRegistry(surviving);
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

// ─── Utilities ───

function log(msg: string): void {
  process.stderr.write(`[tapsmith-mcp] ${msg}\n`);
}

export function closeAllClients(): void {
  for (const conn of _connections) {
    conn.client.close();
    if (conn.daemonProcess) {
      conn.daemonProcess.kill();
      unregisterDaemon(conn.address);
    }
  }
  _connections = [];
  _deviceIndex = new Map();
  _sessionDevices = null;
  _ready = false;
  _connectingPromise = null;
  _configFile = undefined;
}
