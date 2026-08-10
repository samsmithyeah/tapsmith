import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { withFileLockSync } from '../file-lock.js';
import { TapsmithGrpcClient, type DeviceInfoProto } from '../grpc-client.js';
import { findDaemonBin } from '../daemon-bin.js';
import { pickFreePort } from '../port-utils.js';
import type { TapsmithConfig } from '../config.js';
import { loadMcpConfig } from './config-loader.js';
import { uiPortFilePath, mcpDaemonRegistryPath } from './port-file.js';

const DEFAULT_ADDRESS = 'localhost:50051';

// ─── Connection Pool ───

/**
 * Where a pooled daemon came from. It decides what we may do to it: a daemon
 * we started (or an equivalent peer MCP session's) can be pointed at a device
 * and have an agent started on it, but a UI-mode worker daemon is mid-run for
 * someone else and must not be repointed underneath them.
 */
type DaemonSource = 'started' | 'peer' | 'configured' | 'ui';

interface DaemonConnection {
  client: TapsmithGrpcClient
  address: string
  devices: string[]
  daemonProcess?: ChildProcess
  source: DaemonSource
  /** Platform this daemon was started for. Unknown for daemons we found. */
  platform?: string
  /** Set once a platform target claims this daemon, so a second cannot. */
  claimedBy?: string
  /**
   * The device this daemon was pointed at, and the device its agent was
   * started for. A daemon can list devices it is not driving, so these — not
   * `devices` — say which connection actually serves a serial.
   */
  preparedDevice?: string
  agentDevice?: string
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

  // Collect candidate addresses from all sources, remembering where each came
  // from — provenance decides whether we may repoint that daemon later.
  const candidates = new Map<string, DaemonSource>();
  const addCandidate = (address: string, source: DaemonSource): void => {
    if (!candidates.has(address)) candidates.set(address, source);
  };

  // 1. Env var (supports comma-separated for multi-daemon)
  if (process.env.TAPSMITH_DAEMON_ADDRESS) {
    for (const addr of process.env.TAPSMITH_DAEMON_ADDRESS.split(',')) {
      const trimmed = addr.trim();
      if (trimmed) addCandidate(trimmed, 'configured');
    }
  }

  // 2. Config file
  if (config?.daemonAddress) {
    addCandidate(config.daemonAddress, 'configured');
  }

  // 3. UI mode discovery — query the UI server for worker daemon ports
  const uiDaemons = await discoverFromUiServer();
  for (const addr of uiDaemons.addresses) {
    addCandidate(addr, 'ui');
  }
  if (uiDaemons.deviceSerials.size > 0) {
    _sessionDevices = uiDaemons.deviceSerials;
  }

  // 4. Include existing connections so re-discovery doesn't spawn redundant daemons
  for (const conn of _connections) {
    addCandidate(conn.address, conn.source);
  }

  // 5. Daemons started by other MCP sessions in this project. Without this each
  // session starts its own daemon on a random port and they pile up, all
  // driving the same device.
  for (const address of readDaemonRegistry()) {
    addCandidate(address, 'peer');
  }

  // 6. Default address
  if (candidates.size === 0) {
    addCandidate(DEFAULT_ADDRESS, 'configured');
  }

  // Probe all candidates in parallel
  const probes = [...candidates].map(async ([address, source]) => {
    let client: TapsmithGrpcClient | undefined;
    try {
      client = new TapsmithGrpcClient(address);
      const alive = await client.waitForReady(1_000);
      if (alive) return { client, address, source };
      client.close();
    } catch {
      client?.close();
    }
    return null;
  });
  const results = await Promise.all(probes);
  const live = results.filter(
    (r): r is { client: TapsmithGrpcClient; address: string; source: DaemonSource } => r !== null,
  );
  // Probing is the liveness check, so this is the moment we know which
  // registered daemons are gone. Drop them rather than re-probing dead ports
  // on every future session.
  pruneDaemonRegistry(live.map((l) => l.address));

  if (live.length > 0) {
    // Connect to all live daemons in parallel, then batch-update shared state
    const newConns = await Promise.all(live.map(async ({ client, address, source }) => {
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
        // Adopting a peer session's daemon makes us a user of it, so its
        // starter must not kill it while we are still here.
        if (source === 'peer') registerDaemon(address);
        return { client, address, devices: [], source } as DaemonConnection;
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
    // Record what it was pointed at: a platform-less daemon picks whichever
    // device is Active and starts that platform's agent, so a later target
    // claiming this daemon for a *different* device must know it is repointing
    // one — otherwise the daemon reports an agent connected and the second
    // platform silently runs against the first one's.
    conn.preparedDevice = await setDeviceAndAgent(conn.client, config);
    conn.agentDevice = conn.preparedDevice;
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
/**
 * Arguments for a daemon this session spawns.
 *
 * @internal — exported for unit testing.
 */
export function daemonSpawnArgs(port: string, agentPort: string, platform?: string): string[] {
  const args = ['--port', port, '--agent-port', agentPort];
  if (platform) args.push('--platform', platform);
  return args;
}

async function startDaemon(platform?: string): Promise<DaemonConnection | null> {
  log(platform ? `Starting a ${platform} daemon...` : 'No daemon found, starting one...');
  const port = String(await pickFreePort());
  // Its own agent port, like every other daemon we spawn (see dispatcher.ts
  // and ui-server.ts). Daemons default to a shared one, which was harmless
  // while a session had a single daemon — but a session now runs one per
  // platform, and the second would attach to the first platform's agent:
  // iOS tools would drive the Android device, and iOS-only calls would come
  // back as "Unknown method".
  const agentPort = String(await pickFreePort());
  const bin = findDaemonBin();
  const daemonArgs = daemonSpawnArgs(port, agentPort, platform);

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
    log(`Started daemon v${version} on port ${port} (agent ${agentPort})${platform ? ` [${platform}]` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Daemon started but did not respond: ${msg}`);
    client.close();
    daemonProcess.kill();
    return null;
  }

  registerDaemon(address, daemonProcess.pid);
  const conn: DaemonConnection = {
    client,
    address,
    devices: [],
    daemonProcess,
    source: 'started',
    platform,
  };
  _connections.push(conn);
  return conn;
}

/** Tear down a daemon we started but cannot use, so it does not linger. */
function discardDaemon(conn: DaemonConnection): void {
  removeConnection(conn);
  unregisterDaemon(conn.address);
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
  const key = platform ?? 'default';

  const existing = await findConnectionForPlatform(platform, key, config.device);
  if (existing) {
    // Claim it only for as long as the claim holds: a failed prepare would
    // otherwise leave the daemon marked as this platform's forever, so no
    // other platform could take it and this one would start a second daemon
    // on its next attempt.
    const previousClaim = existing.conn.claimedBy;
    existing.conn.claimedBy = key;
    try {
      await prepareTarget(existing.conn, existing.serial, config);
    } catch (err) {
      existing.conn.claimedBy = previousClaim;
      throw err;
    }
    return { address: existing.conn.address, deviceSerial: existing.serial, platform };
  }

  // Nothing reusable serves this platform — daemons are per-platform, so start
  // one dedicated to it.
  const conn = await startDaemon(platform);
  if (!conn) {
    throw new Error(`Failed to start a ${platform ?? 'Tapsmith'} daemon. Is tapsmith-core installed?`);
  }

  const serial = await pickDevice(conn, platform, config.device);
  if (!serial) {
    // A daemon with no device to drive is dead weight: it would sit in the pool
    // and the shared registry, and a second unsatisfiable platform would start
    // yet another one.
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw new Error(noDeviceMessage(platform));
  }

  conn.claimedBy = key;
  try {
    await prepareTarget(conn, serial, config);
  } catch (err) {
    // Same reasoning as the no-device case above: a daemon we started and
    // could not prepare is dead weight, and leaving it pooled means the next
    // attempt starts another one beside it.
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw err;
  }
  await refreshDeviceIndex();
  return { address: conn.address, deviceSerial: serial, platform };
}

function noDeviceMessage(platform?: string): string {
  const what = platform ? `No ${platform} device is available.` : 'No device is available.';
  if (platform === 'android') return `${what} Start an emulator (or connect a device) and try again.`;
  if (platform === 'ios') return `${what} Boot a simulator (or connect a device) and try again.`;
  return `${what} Connect a device or start an emulator and try again.`;
}

/**
 * A pooled daemon this platform may take over, if any.
 *
 * Two things make a daemon unusable even when it can see a matching device:
 *
 * - It belongs to a live UI-mode run. Claiming it means `setDevice`-ing it out
 *   from under that run, whose next action then lands on the wrong device.
 * - Another platform already claimed it. A daemon started without `--platform`
 *   lists both Android and iOS devices, so a multi-platform session would find
 *   the same daemon twice; the second claim repoints it away from the first
 *   platform's device, and `startAgentFromConfig` skips the agent because the
 *   daemon already reports one connected (the first platform's).
 */
async function findConnectionForPlatform(
  platform: string | undefined,
  key: string,
  wantedSerial: string | undefined,
): Promise<{ conn: DaemonConnection; serial: string } | null> {
  for (const conn of _connections) {
    if (conn.source === 'ui') continue;
    if (conn.claimedBy && conn.claimedBy !== key) continue;
    // A daemon started for another platform cannot serve this one.
    if (conn.platform && platform && conn.platform !== platform) continue;
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
  // `agentConnected` is daemon-global and `set_device` does not disconnect the
  // agent, so a daemon repointed to a different device still reports one as
  // connected — the platform's real agent would never start, and the session
  // would drive the previous device's agent. Force a start only when we know
  // *we* moved it: an unset `preparedDevice` means we have never pointed this
  // daemon anywhere, and forcing then would tear down an agent that is already
  // serving this device — including one a peer session is mid-run against.
  const repointed = conn.preparedDevice !== undefined && conn.preparedDevice !== serial;
  await startAgentFromConfig(conn.client, config, { force: repointed, required: true });
  conn.preparedDevice = serial;
  conn.agentDevice = serial;
  // The daemon that was prepared for a serial is the one that serves it, even
  // when another daemon can merely see it.
  _deviceIndex.set(serial, conn);
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
 * Which daemons the MCP sessions of this project are using.
 *
 * Each record is one session's *use* of one daemon, so a daemon is only torn
 * down when the last session using it goes away. Recording only the starter
 * would let its shutdown kill a daemon a peer had adopted, and that peer
 * cannot recover — its resolved targets are cached from init and would keep
 * pointing at a dead address.
 *
 * Best-effort throughout: a missing, unreadable or malformed registry just
 * means we start our own daemon, which is what happened before it existed.
 * Liveness is never trusted from the file — every address is probed like any
 * other candidate.
 */
interface DaemonRegistryEntry {
  address: string
  /** Session holding this daemon open. Entries of dead pids are pruned. */
  pid: number
  /**
   * The daemon process itself, recorded by whichever session started it.
   * A session that merely adopted the address has no child handle, so without
   * this the last session out could not shut the daemon down and it would
   * outlive every user with no one left to reap it.
   */
  daemonPid?: number
}

/**
 * Only loopback addresses are accepted from the registry.
 *
 * Unlike every other candidate source — an env var, the user's own config, a
 * port file this process wrote — the registry lives at a path derived solely
 * from the project directory, in a shared temp directory. On a multi-user host
 * anyone can plant one, and an accepted address receives the session's
 * screenshots and UI trees and decides what it believes the device shows.
 */
function isLoopbackAddress(address: string): boolean {
  const match = /^(.+):(\d+)$/.exec(address);
  if (!match) return false;
  const [, host, port] = match;
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * The registry file, once its directory is known to be private to this user.
 *
 * `mkdirSync(..., { mode })` applies the mode only when it creates the
 * directory, so a pre-existing one is used with whatever permissions it
 * already has — and the name is only `tapsmith-<uid>`, which anyone on a
 * shared host can create first in a sticky temp dir. Loosen permissions we
 * own back to 0700; refuse the registry outright when it belongs to someone
 * else, since planting entries there is exactly the redirect the loopback
 * filter cannot catch. Returns null when the registry cannot be trusted, in
 * which case sessions simply stop sharing daemons.
 */
function privateRegistryFile(): string | null {
  const file = mcpDaemonRegistryPath();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    if (stat.mode & 0o077) fs.chmodSync(dir, 0o700);
    return file;
  } catch {
    return null;
  }
}

function readRegistryEntries(): DaemonRegistryEntry[] {
  const file = privateRegistryFile();
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): DaemonRegistryEntry[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { address, pid, daemonPid } = entry as Partial<DaemonRegistryEntry>;
    if (typeof address !== 'string' || !isLoopbackAddress(address)) return [];
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return [];
    const validDaemonPid = typeof daemonPid === 'number' && Number.isInteger(daemonPid) && daemonPid > 0
      ? daemonPid
      : undefined;
    return [{ address, pid, daemonPid: validDaemonPid }];
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read, transform and write the registry under an exclusive lock.
 *
 * Read-modify-write over a shared file is a lost-update race: two sessions
 * registering at the same moment each overwrite the other's entry, and the
 * next session then starts a third daemon on the same device — the pile-up
 * the registry exists to prevent.
 */
/**
 * Collapse duplicate rows for one session and address, keeping the daemon pid.
 *
 * Last-write-wins would let a later pid-less row — a peer adoption after a
 * re-`discover()`, say — overwrite the row that recorded which process to
 * reap, leaving the daemon unreapable.
 */
function mergeByAddressAndPid(entries: DaemonRegistryEntry[]): Map<string, DaemonRegistryEntry> {
  const merged = new Map<string, DaemonRegistryEntry>();
  for (const entry of entries) {
    const key = `${entry.address}::${entry.pid}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, ...entry, daemonPid: entry.daemonPid ?? existing.daemonPid } : entry);
  }
  return merged;
}

/**
 * Give every session holding an address the daemon pid recorded for it.
 *
 * Only the session that *started* a daemon knows its pid; a peer adopts the
 * address alone. That pid then lived on exactly one row, which disappears as
 * soon as the starter exits or is killed — after which the remaining sessions
 * have no way to reap the daemon, and it holds the device forever. Copying it
 * to every row for the address means any survivor can finish the job.
 */
function shareDaemonPids(entries: DaemonRegistryEntry[]): DaemonRegistryEntry[] {
  const known = new Map<string, number>();
  for (const entry of entries) {
    if (entry.daemonPid) known.set(entry.address, entry.daemonPid);
  }
  return entries.map((entry) => (
    entry.daemonPid ? entry : { ...entry, daemonPid: known.get(entry.address) }
  ));
}

function updateRegistry(
  transform: (entries: DaemonRegistryEntry[]) => DaemonRegistryEntry[],
): void {
  const file = privateRegistryFile();
  if (!file) return;
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', { encoding: 'utf-8', mode: 0o600 });
    // A dropped write is not fatal, but it is worth saying: the session then
    // holds a daemon no peer knows about, and whoever started it may reap it
    // mid-session believing nobody else is attached.
    let wrote = false;
    withFileLockSync(file, () => {
      wrote = true;
      // Share before transforming as well as after: the row being removed here
      // is often the only one carrying the daemon pid, and the same is true of
      // a row about to be dropped for a dead session.
      const current = shareDaemonPids(readRegistryEntries());
      const next = transform(current).filter((e) => isProcessAlive(e.pid));
      const deduped = shareDaemonPids([...mergeByAddressAndPid(next).values()]);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(deduped), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, file);
    });
    if (!wrote) log(`Warning: could not lock the daemon registry at ${file}; this session's daemon record was not written`);
  } catch {
    // The registry is an optimisation; never fail a session over it.
  }
}

/** Addresses of daemons this project's MCP sessions are using. @internal — exported for unit testing. */
export function readDaemonRegistry(): string[] {
  return [...new Set(readRegistryEntries().filter((e) => isProcessAlive(e.pid)).map((e) => e.address))];
}

/** Record that this session is using a daemon. @internal — exported for unit testing. */
export function registerDaemon(address: string, daemonPid?: number): void {
  if (!isLoopbackAddress(address)) return;
  updateRegistry((entries) => [...entries, { address, pid: process.pid, daemonPid }]);
}

/** The daemon process behind an address, if its starter recorded one. */
function registeredDaemonPid(address: string): number | undefined {
  return readRegistryEntries().find((e) => e.address === address && e.daemonPid)?.daemonPid;
}

/**
 * Whether a pid is a Tapsmith daemon, checked before signalling a process we
 * did not spawn — pids are reused, and a registry entry may be stale.
 */
function isTapsmithDaemonProcess(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' })
      .includes('tapsmith-core');
  } catch {
    return false;
  }
}

/** Drop this session's use of a daemon. @internal — exported for unit testing. */
export function unregisterDaemon(address: string): void {
  updateRegistry((entries) => entries.filter((e) => !(e.address === address && e.pid === process.pid)));
}

/**
 * Whether any other live session is still using a daemon — i.e. whether
 * killing it on our way out would pull it from under them.
 */
function daemonInUseByOthers(address: string): boolean {
  return readRegistryEntries().some(
    (e) => e.address === address && e.pid !== process.pid && isProcessAlive(e.pid),
  );
}

/**
 * Drop *our own* records for addresses that failed to answer a probe.
 *
 * Only ours: another session's entry may be for a daemon it can still reach
 * (a different network view, or a daemon started microseconds ago), and
 * deleting it would make its owner invisible to everyone else.
 *
 * @internal — exported for unit testing.
 */
export function pruneDaemonRegistry(liveAddresses: string[]): void {
  const live = new Set(liveAddresses);
  // A daemon whose process is still running has not gone away — a 1s probe can
  // time out under load or a GC pause. Dropping the row on that evidence loses
  // the recorded pid, and an adopted daemon then has nothing left to reap it.
  const gone = (entry: DaemonRegistryEntry): boolean =>
    !live.has(entry.address) && !(entry.daemonPid && isTapsmithDaemonProcess(entry.daemonPid));
  const entries = readRegistryEntries();
  const stale = entries.some((e) => e.pid === process.pid && gone(e));
  if (!stale) return;
  updateRegistry((current) => current.filter((e) => e.pid !== process.pid || !gone(e)));
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
  // Prepared bindings first. A platform-less daemon enumerates every device,
  // including ones a *second* daemon was started to drive, so first-seen-wins
  // would route an iOS tap to the daemon holding the Android emulator.
  for (const { conn } of results) {
    if (conn.preparedDevice) _deviceIndex.set(conn.preparedDevice, conn);
  }
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
  // Dropping an unresponsive daemon is not licence to kill one other sessions
  // are still registered against — a failed readiness probe here can be a
  // transient stall, and they may well still be talking to it. Only the
  // sources that ever registered pay for the locked registry write: this runs
  // from `ensureConnected` whenever a 1s probe fails, and the lock blocks the
  // event loop while it waits.
  if (conn.source === 'started' || conn.source === 'peer') {
    unregisterDaemon(conn.address);
    if (conn.daemonProcess && !daemonInUseByOthers(conn.address)) conn.daemonProcess.kill();
  } else if (conn.daemonProcess) {
    conn.daemonProcess.kill();
  }
  _connections = _connections.filter(c => c !== conn);
  for (const [serial, c] of _deviceIndex) {
    if (c === conn) _deviceIndex.delete(serial);
  }
}

// ─── Device & Agent Setup ───

/** Points the daemon at a device and starts its agent; returns that device. */
async function setDeviceAndAgent(
  client: TapsmithGrpcClient,
  config: TapsmithConfig | null,
): Promise<string | undefined> {
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
    return undefined;
  }

  await client.setDevice(serial);
  log(`Using device: ${serial}`);
  await startAgentFromConfig(client, config);
  return serial;
}

/**
 * Start the device agent described by `config`.
 *
 * `force` re-starts one the daemon already reports as connected; `required`
 * makes a failure the caller's problem instead of a log line. Discovery starts
 * agents opportunistically and must survive a failure — but a platform target
 * that cannot start its agent is not a working target, and reporting it as one
 * gives the session a device whose every run fails.
 */
async function startAgentFromConfig(
  client: TapsmithGrpcClient,
  config: TapsmithConfig | null,
  options?: { force?: boolean; required?: boolean },
): Promise<void> {
  if (!options?.force) {
    const { agentConnected } = await client.ping();
    if (agentConnected) return;
  }

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
    if (options?.required) throw new Error(`Failed to start the agent on this device: ${msg}`);
  }
}

// ─── Utilities ───

function log(msg: string): void {
  process.stderr.write(`[tapsmith-mcp] ${msg}\n`);
}

export function closeAllClients(): void {
  for (const conn of _connections) {
    conn.client.close();
    // Drop our claim first, then keep the daemon alive if a peer session still
    // holds one: it adopted this address from the registry and has no process
    // of its own to fall back on.
    if (conn.source !== 'started' && conn.source !== 'peer') continue;
    // Read the daemon's pid before dropping our record: an adopted daemon has
    // no child handle here, and we may be the last session able to reap it.
    const daemonPid = conn.daemonProcess?.pid ?? registeredDaemonPid(conn.address);
    unregisterDaemon(conn.address);
    if (daemonInUseByOthers(conn.address)) {
      log(`Leaving daemon at ${conn.address} running — another session is still using it`);
      continue;
    }
    if (conn.daemonProcess) {
      conn.daemonProcess.kill();
    } else if (daemonPid && isTapsmithDaemonProcess(daemonPid)) {
      try { process.kill(daemonPid); } catch { /* already gone */ }
    }
  }
  _connections = [];
  _deviceIndex = new Map();
  _sessionDevices = null;
  _ready = false;
  _connectingPromise = null;
  _configFile = undefined;
}
