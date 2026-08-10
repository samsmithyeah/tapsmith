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
 * Where a pooled daemon came from. It decides what we may do to it.
 *
 * The line that matters is whether something else is still driving it. A
 * daemon we `started`, one the user `configured` us to use, or an `orphan`
 * whose starting session is gone, are all ours: they can be repointed and have
 * an agent started on them. A `peer` MCP session's and a `ui` worker's are
 * mid-run for someone else — repointing one sends their next action to our
 * device, and starting an agent installs our config's artifacts on theirs.
 */
type DaemonSource = 'started' | 'peer' | 'orphan' | 'configured' | 'ui';

/** Sources we are free to repoint and start agents on. */
function isOurs(source: DaemonSource): boolean {
  return source === 'started' || source === 'configured' || source === 'orphan';
}

/** Sources that record themselves in the shared registry, and so must unregister. */
function isRegistered(source: DaemonSource): boolean {
  return source === 'started' || source === 'peer' || source === 'orphan';
}

interface DaemonConnection {
  client: TapsmithGrpcClient
  address: string
  devices: string[]
  daemonProcess?: ChildProcess
  source: DaemonSource
  /**
   * Platform this daemon serves — set when it was started for one, or when a
   * platform target claimed a platform-less one. Unknown only for a daemon we
   * found and have not claimed.
   */
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
  /** The device this daemon reports as Active, refreshed with the device index. */
  activeDevice?: string
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

export interface SessionDevice {
  serial: string
  platform?: string
}

/**
 * The device a device tool should act on, and the client that serves it.
 *
 * `ensureConnected()` with no device falls back to the first pooled daemon —
 * a fair guess when a session had one, and now merely the first platform to
 * resolve. Nothing in the response said which device answered, so a screenshot
 * taken while debugging an iOS failure could be the Android emulator's.
 *
 * `platform` is how a caller says which one it means without knowing a serial:
 * tools take a project name, which maps to a platform, which maps here. Serials
 * change between runs; project names do not.
 */
export async function resolveDeviceTarget(
  request?: { device?: string; project?: RequestedProject },
): Promise<{ client: TapsmithGrpcClient; device?: string }> {
  const { device, project } = request ?? {};
  if (device) return { client: await ensureConnected(device), device };

  // Discovery has to run before the session can say what it is driving.
  const fallback = await ensureConnected();
  // UI mode spawns its worker daemons on the first run, which is usually after
  // the first tool call — and the pool is cached once discovery has succeeded.
  // Without this refresh a UI session keeps answering from the primary daemon
  // and reports no per-platform devices at all, however many workers exist.
  await refreshUiConnections();
  const targets = sessionTargetDevices();

  if (project) {
    const chosen = selectProjectDevice(targets, project);
    if ('error' in chosen) throw new Error(chosen.error);
    return forDevice(chosen.serial);
  }

  // The daemon that *holds* the device, not whichever sits at index 0 — those
  // are different connections as soon as the session has a daemon it has not
  // pointed anywhere, and answering from the wrong one is the whole failure
  // this function exists to prevent.
  if (targets.length === 1) return forDevice(targets[0].serial);
  if (targets.length === 0) return { client: fallback };
  throw new Error(ambiguousDeviceMessage(targets)!);
}

/** A project a caller named, and the platform it runs on (which may be none). */
export interface RequestedProject {
  name: string
  platform?: string
}

/**
 * The device a named project runs on, or why it cannot be picked.
 *
 * Matched on the project's platform, `undefined` included: a config whose root
 * declares no platform gives its unqualified projects exactly that, and they
 * run on the session's unqualified device. Treating that as "no project was
 * named" fell through to the generic path, whose message told the caller to
 * pass the `project` they had just passed.
 *
 * @internal — exported for unit testing.
 */
export function selectProjectDevice(
  targets: SessionDevice[],
  project: RequestedProject,
): { serial: string } | { error: string } {
  const match = targets.filter((t) => t.platform === project.platform);
  if (match.length === 1) return { serial: match[0].serial };
  const called = project.platform ? `${project.platform} ` : '';
  if (match.length === 0) {
    return {
      error: `This session has no ${called}device for project "${project.name}". ${describeTargets(targets)}`,
    };
  }
  return {
    error: `Project "${project.name}" matches ${match.length} ${called}devices `
      + `(${match.map((t) => t.serial).join(', ')}). Pass \`device\` with the serial this should act on.`,
  };
}

async function forDevice(serial: string): Promise<{ client: TapsmithGrpcClient; device: string }> {
  return { client: await ensureConnected(serial), device: serial };
}

/**
 * Why this session cannot pick a device on the caller's behalf, or null when it
 * can. @internal — exported for unit testing.
 */
export function ambiguousDeviceMessage(targets: SessionDevice[]): string | null {
  if (targets.length <= 1) return null;
  return `This session is driving ${targets.length} devices, so there is no single default. `
    + `${describeTargets(targets)} `
    + 'Pass `project` to say which one this should act on, or `device` for a specific serial.';
}

function describeTargets(targets: SessionDevice[]): string {
  if (targets.length === 0) return 'It is driving none.';
  const listed = targets
    .map((t) => (t.platform ? `${t.platform}: ${t.serial}` : t.serial))
    .join(', ');
  return `Devices: ${listed}.`;
}

/**
 * The devices this session is actually driving — not every device it can see.
 *
 * A daemon lists devices it was never pointed at (two booted simulators, say),
 * and treating those as targets would demand an argument from a session that
 * only ever uses one. `preparedDevice` is what we pointed a daemon at, and for
 * a UI worker it is what the UI server told us that worker holds — the two
 * transports answer this the same way.
 *
 * @internal — exported for unit testing.
 */
export function sessionTargetDevices(): SessionDevice[] {
  const bySerial = new Map<string, SessionDevice>();
  for (const conn of _connections) {
    // `devices` is refreshed from each daemon's own list, so the one it reports
    // Active is what it drives even when nothing here pointed it there — a
    // daemon found at the default address, say.
    const serial = conn.preparedDevice ?? conn.activeDevice;
    if (serial) bySerial.set(serial, { serial, platform: conn.platform });
  }
  // Deliberately not `_sessionDevices`: that is what the UI server *says* it
  // has, and a worker whose daemon we could not reach is not something this
  // session can act on. Counting it made a one-device session refuse every
  // device tool as ambiguous, naming a phantom that no argument could select.
  return [...bySerial.values()];
}

/**
 * Pick up UI worker daemons that appeared after discovery ran.
 *
 * Cheap enough to do per interactive call: one loopback GET, and connections
 * we already hold are left alone. Silent on every failure — a session with no
 * UI server behind it is the normal case, not an error.
 */
async function refreshUiConnections(): Promise<void> {
  const { daemons, deviceSerials } = await discoverFromUiServer();
  if (daemons.length === 0) return;
  if (deviceSerials.size > 0) _sessionDevices = deviceSerials;

  const added: DaemonConnection[] = [];
  for (const daemon of daemons) {
    if (_connections.some((c) => c.address === daemon.address)) continue;
    const client = new TapsmithGrpcClient(daemon.address);
    try {
      if (!(await client.waitForReady(1_000))) { client.close(); continue; }
    } catch {
      client.close();
      continue;
    }
    added.push({
      client,
      address: daemon.address,
      devices: [],
      source: 'ui',
      platform: daemon.platform,
      preparedDevice: daemon.deviceSerial,
    });
  }
  if (added.length === 0) return;
  _connections.push(...added);
  await refreshDeviceIndex();
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
  const uiByAddress = new Map(uiDaemons.daemons.map((d) => [d.address, d]));
  for (const daemon of uiDaemons.daemons) {
    addCandidate(daemon.address, 'ui');
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
  for (const { address, orphaned } of readDaemonRegistry()) {
    addCandidate(address, orphaned ? 'orphan' : 'peer');
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
        // Only on a daemon that is ours to drive. A 'peer' or 'ui' daemon
        // belongs to a live session of someone else's, and one reporting no
        // agent is usually between runs rather than free — installing our
        // config's agent artifacts on its active device puts a different
        // platform's app on a device we do not own. An 'orphan' has no such
        // owner left, so recovering its agent here is exactly right.
        if (isOurs(source)) {
          const { agentConnected } = await client.ping();
          if (!agentConnected) await startAgentFromConfig(client, config);
        }
        log(`Connected to daemon at ${address}`);
        // Adopting a peer session's daemon makes us a user of it, so its
        // starter must not kill it while we are still here.
        if (source === 'peer' || source === 'orphan') registerDaemon(address);
        // A UI worker's device and platform come from the UI server, not from
        // anything we did to the daemon — record them so this connection
        // answers the same questions a headless one does.
        const ui = uiByAddress.get(address);
        return {
          client,
          address,
          devices: [],
          source,
          platform: ui?.platform,
          preparedDevice: ui?.deviceSerial,
        } as DaemonConnection;
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
    // `removeConnection` already unregisters a daemon we started; a second call
    // would take the registry lock again, and that lock blocks the event loop.
    removeConnection(conn);
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
 * A free port that is not `taken`.
 *
 * `pickFreePort` binds `:0` and closes again, so two calls in a row can be
 * handed the same port — nothing holds it in between, and with no connection
 * made there is no TIME_WAIT to keep it reserved. The daemon would then serve
 * gRPC on a port it also tries to forward the agent to, and the agent never
 * attaches. Other spawn paths avoid this by drawing agent ports from their own
 * 18700+ band; this one picks both, so it has to check.
 */
async function pickDistinctFreePort(taken: number): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await pickFreePort();
    if (port !== taken) return port;
  }
  throw new Error(`Could not find a free agent port distinct from ${taken}`);
}

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
  const agentPort = String(await pickDistinctFreePort(Number(port)));
  const bin = findDaemonBin();
  const daemonArgs = daemonSpawnArgs(port, agentPort, platform);

  // `detached`, not just `unref`. A daemon may outlive the session that started
  // it — that is the whole point of the registry, and `closeAllClients`
  // deliberately leaves one running when a peer has adopted it. Without its own
  // process group, a Ctrl-C in the starter's shell is delivered to the group and
  // kills the daemon anyway, before any of that reasoning runs. `unref` only
  // stops it holding *our* event loop open, which is a different problem.
  const daemonProcess = spawn(bin, daemonArgs, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
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
  // Just `removeConnection`: it unregisters every source that registered, and
  // each extra `unregisterDaemon` is another locked registry write — the lock
  // spins on `Atomics.wait`, so the cost lands on the event loop, on a path
  // that runs whenever a platform fails to provision.
  removeConnection(conn);
}

// ─── Per-platform targets ───

export interface PlatformTarget {
  /** Address of the daemon serving this platform's device. */
  address: string
  deviceSerial: string
  platform?: string
}

/**
 * Whether the daemon behind a resolved target is still answering.
 *
 * A target is resolved once and then handed to every run child, which connects
 * to `address` itself. Nothing revisits that decision, so a daemon that dies
 * mid-session — killed by hand, OOM, a crash — leaves the session pointing at a
 * dead port with no way back short of restarting the server. Callers holding a
 * cached target check here and re-resolve when this comes back false.
 */
export async function platformTargetIsLive(target: PlatformTarget): Promise<boolean> {
  const conn = _connections.find((c) => c.address === target.address);
  if (!conn) return false;
  try {
    return await conn.client.waitForReady(1_000);
  } catch {
    return false;
  }
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
    const previousPlatform = existing.conn.platform;
    existing.conn.claimedBy = key;
    // A daemon started without `--platform` serves whichever platform claims
    // it, and from here it serves only that one. Recording it is what lets a
    // caller name a device by its project: without it the session knows it
    // drives an emulator but not that the emulator is the android target.
    existing.conn.platform ??= platform;
    try {
      await prepareTarget(existing.conn, existing.serial, config);
    } catch (err) {
      existing.conn.claimedBy = previousClaim;
      existing.conn.platform = previousPlatform;
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

  const serial = (await pickDevice(conn, platform, config.device))?.serial;
  if (!serial) {
    // Ask what it *could* see before discarding it, so a config pinning a
    // serial that does not exist is not reported as "no device available"
    // while the device the user is looking at sits there booted.
    const visible = await visibleDevices(conn, platform);
    // A daemon with no device to drive is dead weight: it would sit in the pool
    // and the shared registry, and a second unsatisfiable platform would start
    // yet another one.
    discardDaemon(conn);
    await refreshDeviceIndex();
    throw new Error(noDeviceMessage(platform, config.device, visible));
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

/** The serials a daemon can see for a platform; empty if it cannot be reached. */
async function visibleDevices(conn: DaemonConnection, platform: string | undefined): Promise<string[]> {
  try {
    const { devices } = await conn.client.listDevices();
    return (platform ? devices.filter((d) => d.platform === platform) : devices).map((d) => d.serial);
  } catch {
    return [];
  }
}

export function noDeviceMessage(platform?: string, wanted?: string, visible: string[] = []): string {
  const what = platform ? `No ${platform} device is available.` : 'No device is available.';
  // A pinned serial that does not exist is a different problem with a
  // different fix, and telling the user to boot a simulator when one is
  // already booted sends them looking in the wrong place entirely.
  if (wanted && visible.length > 0) {
    return `Device "${wanted}" from your config is not available. `
      + `${platform ? `Visible ${platform} devices` : 'Visible devices'}: ${visible.join(', ')}. `
      + 'Update `device` in your config, or start that device.';
  }
  if (wanted) {
    return `Device "${wanted}" from your config is not available, and no other `
      + `${platform ?? 'device'} was found. Start it, or update \`device\` in your config.`;
  }
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
 * - It belongs to a live peer MCP session and is already pointed somewhere
 *   else. The registry lists a peer's daemon precisely because that session is
 *   still running, so the UI-mode reasoning applies unchanged: repointing it
 *   sends the peer's next tap to our device. Adopting it is only safe when it
 *   already serves the device we want — the case reuse exists for — or when it
 *   has no active device yet.
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
    const choice = await pickDevice(conn, platform, wantedSerial);
    if (!choice) continue;
    if (conn.source === 'peer' && isRepointing(choice.activeSerial, choice.serial)) continue;
    return { conn, serial: choice.serial };
  }
  return null;
}

interface DeviceChoice {
  /** The device this daemon would serve for us. */
  serial: string
  /** The device it is pointed at now, whoever pointed it there. */
  activeSerial?: string
}

/**
 * Whether taking `serial` on a daemon currently pointed at `currentDevice`
 * moves it off another device.
 *
 * Both places that need this answer get it wrong on their own. A daemon whose
 * current device is unknown must be treated as *not* being moved: forcing an
 * agent restart on one that already serves this device tears down a working
 * agent, possibly mid-run.
 */
export function isRepointing(currentDevice: string | undefined, serial: string): boolean {
  return currentDevice !== undefined && currentDevice !== serial;
}

async function pickDevice(
  conn: DaemonConnection,
  platform: string | undefined,
  wantedSerial: string | undefined,
): Promise<DeviceChoice | undefined> {
  let devices: DeviceInfoProto[];
  try {
    ({ devices } = await conn.client.listDevices());
  } catch {
    return undefined;
  }

  const activeSerial = activeDeviceOf(devices);
  const candidates = platform ? devices.filter((d) => d.platform === platform) : devices;
  const serial = wantedSerial
    ? candidates.find((d) => d.serial === wantedSerial)?.serial
    : (
        candidates.find((d) => d.state === 'Active' || d.state === 'online')
        ?? candidates.find((d) => d.state === 'Discovered')
        ?? candidates[0]
      )?.serial;
  return serial ? { serial, activeSerial } : undefined;
}

/**
 * The device a daemon is pointed at, as the daemon itself reports it.
 *
 * `set_device` marks its target `Active` and demotes the previous one, so this
 * is the one piece of daemon state that survives across processes — unlike
 * `preparedDevice`, which only records what *this* process did.
 */
function activeDeviceOf(devices: DeviceInfoProto[]): string | undefined {
  return devices.find((d) => d.state === 'Active')?.serial;
}

/** {@link activeDeviceOf} for a connection; undefined if the daemon can't be reached. */
async function currentDevice(conn: DaemonConnection): Promise<string | undefined> {
  try {
    const { devices } = await conn.client.listDevices();
    return activeDeviceOf(devices);
  } catch {
    return undefined;
  }
}

/** Point a daemon at a device and make sure its agent is running. */
async function prepareTarget(
  conn: DaemonConnection,
  serial: string,
  config: TapsmithConfig,
): Promise<void> {
  // Ask the daemon where it is pointed *before* moving it. `agentConnected` is
  // daemon-global and `set_device` does not disconnect the agent, so a daemon
  // repointed to a different device still reports one as connected — the
  // platform's real agent would never start and the session would drive the
  // previous device's agent. Force a start exactly when the device changed.
  //
  // The daemon's own `Active` device, not `preparedDevice`: the latter records
  // only what this process did, so an adopted 'peer' or 'configured' daemon
  // already serving another device looks untouched and the force is skipped.
  // Fall back to `preparedDevice` when the daemon can't be reached — forcing on
  // a daemon that already serves this device would tear down a working agent,
  // including one a peer session is mid-run against.
  const wasPointedAt = await currentDevice(conn) ?? conn.preparedDevice;
  await conn.client.setDevice(serial);
  const repointed = isRepointing(wasPointedAt, serial);
  // Record the move before starting the agent: `setDevice` has already
  // happened, so if the agent start throws, the next claim must still see this
  // daemon as pointed here rather than assume it never moved.
  conn.preparedDevice = serial;
  await startAgentFromConfig(conn.client, config, { force: repointed, required: true });
  conn.agentDevice = serial;
  // The daemon that was prepared for a serial is the one that serves it, even
  // when another daemon can merely see it.
  _deviceIndex.set(serial, conn);
}

interface UiDaemonRecord {
  address: string
  deviceSerial?: string
  platform?: string
}

interface UiDiscoveryResult {
  daemons: UiDaemonRecord[]
  deviceSerials: Set<string>
}

const EMPTY_DISCOVERY: UiDiscoveryResult = { daemons: [], deviceSerials: new Set() };

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
    // The UI server publishes each worker's platform alongside its address. We
    // used to drop it, which left UI-mode sessions unable to answer "which
    // device does the ios project run on?" — the one question routing a device
    // tool by project needs. Headless knows it from `conn.platform`; this is
    // the same fact from the other transport.
    const data = JSON.parse(json) as { daemons?: UiDaemonRecord[] };
    if (!Array.isArray(data.daemons)) return EMPTY_DISCOVERY;
    const daemons = data.daemons.filter((d) => Boolean(d.address));
    return {
      daemons,
      deviceSerials: new Set(daemons.map(d => d.deviceSerial).filter(Boolean) as string[]),
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
    // `wx`, not exists-then-write: two sessions starting together both see it
    // missing, and the loser's `[]` lands on top of the winner's entry while
    // the winner holds the lock — so neither can see the other's daemon and
    // both start one, which is the pile-up this file exists to prevent.
    try {
      fs.writeFileSync(file, '[]', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const { locked } = withFileLockSync(file, () => {
      // Share before transforming as well as after: the row being removed here
      // is often the only one carrying the daemon pid, and the same is true of
      // a row about to be dropped for a dead session.
      const current = shareDaemonPids(readRegistryEntries());
      const next = transform(current).filter(entryIsLive);
      const deduped = shareDaemonPids([...mergeByAddressAndPid(next).values()]);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(deduped), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, file);
    });
    // A dropped write is not fatal, but it is worth saying: the session then
    // holds a daemon no peer knows about, and whoever started it may reap it
    // mid-session believing nobody else is attached.
    if (!locked) log(`Warning: could not lock the daemon registry at ${file}; this session's daemon record was not written`);
  } catch {
    // The registry is an optimisation; never fail a session over it.
  }
}

/**
 * Whether a registry row still describes something real.
 *
 * A row outlives its session when the daemon that session started is still
 * running. That row is the only record of the daemon's pid, so dropping it
 * strands the process: no later session can find it to reuse, and none can
 * find it to reap. Sessions killed with SIGKILL never reach `closeAllClients`,
 * which makes this the ordinary way daemons leak rather than an edge case.
 *
 * Checked in that order because `isTapsmithDaemonProcess` shells out to `ps` —
 * a live session is the common row and answers for free.
 */
function entryIsLive(entry: DaemonRegistryEntry): boolean {
  if (isProcessAlive(entry.pid)) return true;
  return Boolean(entry.daemonPid && isTapsmithDaemonProcess(entry.daemonPid));
}

/**
 * Daemons this project's MCP sessions are using, and whether each still has an
 * owner.
 *
 * `orphaned` is what separates "another session is driving this" from "the
 * session that started this is gone". The second is ours to repoint, to start
 * an agent on, and eventually to reap; treating it as a peer would leave it
 * running untouched forever.
 *
 * @internal — exported for unit testing.
 */
export function readDaemonRegistry(): Array<{ address: string; orphaned: boolean }> {
  const byAddress = new Map<string, boolean>();
  for (const entry of readRegistryEntries()) {
    if (!entryIsLive(entry)) continue;
    const orphaned = !isProcessAlive(entry.pid);
    // Any live owner wins: one dead session's row must not mark an address
    // orphaned while another session is still using the same daemon.
    byAddress.set(entry.address, (byAddress.get(entry.address) ?? true) && orphaned);
  }
  return [...byAddress].map(([address, orphaned]) => ({ address, orphaned }));
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
    conn.activeDevice = activeDeviceOf(devices);
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
  if (isRegistered(conn.source)) {
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
    if (!isRegistered(conn.source)) continue;
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
