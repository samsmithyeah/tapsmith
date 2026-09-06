/**
 * Device sessions: the one implementation of "connect to a daemon, bind a
 * device, install the app, start the agent, launch, and keep it recoverable".
 *
 * Every run path used to carry its own copy of this sequence (the sequential
 * CLI, parallel workers, UI workers, watch/MCP run children), and each copy
 * drifted — a per-device concern added to one was silently missing from the
 * others. Device groups (`use.devices`, PILOT-310) run the sequence N times
 * per worker, so it lives here once and the embedders only decide *which*
 * devices and daemons to hand it.
 */

import * as path from 'node:path';
import { spawn, execFileSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { TapsmithGrpcClient } from './grpc-client.js';
import { Device } from './device.js';
import type { TapsmithConfig } from './config.js';
import { isNetworkTracingEnabled, networkHostsForPac, networkPassthroughHosts } from './trace/types.js';
import { installedApkMatches, isPackageInstalled, waitForPackageIndexed } from './emulator.js';
import { installApp, installAppAsync, installedAppMatches, isAppInstalled, probeSimulatorHealth, rebootSimulator } from './ios-simulator.js';
import { findAgentApk, findAgentTestApk } from './agent-resolve.js';
import {
  AGENT_START_RETRY_DELAY_MS,
  isRetryableAgentStartError,
  retryDeviceSelection,
} from './worker-protocol.js';
import {
  ensureSessionReady,
  launchConfiguredApp,
  probeResetCapabilities,
  type SessionPreflightContext,
} from './session-preflight.js';
import type { PreparedState, ResetCapabilities } from './app-reset.js';
import { findDaemonBin } from './daemon-bin.js';

// ─── Types ───

/** Which device a session should hold, and the daemon that drives it. */
export interface DeviceSessionSpec {
  /**
   * Group entry name (`alice`, or `device-1` for unnamed groups). Tags every
   * trace event the device produces and names its failure screenshots.
   */
  name: string
  /** ADB serial / simulator UDID / physical iOS UDID. */
  serial: string
  /** `host:port` of the daemon dedicated to this device. */
  daemonAddress: string
}

/** An open device session: one daemon, one device, one app instance. */
export interface DeviceSession {
  name: string
  serial: string
  daemonAddress: string
  client: TapsmithGrpcClient
  device: Device
  /**
   * The effective config this device runs under — a copy of the embedder's
   * config with `device` and `daemonAddress` pointed at this session, so
   * consumers that read `config.device` (trace metadata, preflight) see the
   * right device without the embedder mutating a shared object.
   */
  config: TapsmithConfig
  /** Human label for errors and progress, e.g. `Worker 0 (emulator-5554)`. */
  label: string
  /**
   * Runtime reset capabilities (in-app hooks detected?). One mutable object
   * per device for the session's whole life: the preflight probe fills it and
   * every reset refreshes it, so `appReset: 'auto'` resolves per device.
   */
  capabilities: ResetCapabilities
  /**
   * A launch that already left the app in fresh state (startup, warmup,
   * recovery). The next file's runner consumes it to skip a redundant reset.
   */
  prepared?: PreparedState
  /** Preflight context for resets, readiness checks and recovery. */
  context: SessionPreflightContext
  /** Daemon process this session spawned and owns; absent when adopted. */
  daemonProcess?: ChildProcess
  /** Agent host port the owned daemon forwards to the device (for cleanup). */
  agentPort?: number
  /**
   * False when the gRPC client was handed in by the caller
   * (`OpenDeviceSessionOptions.client`), who owns its lifetime;
   * `closeDeviceSession` then leaves it open.
   */
  ownsClient?: boolean
}

/** A setup step the sequential CLI shows as its own progress row. */
export type DeviceSessionPhase = 'install' | 'agent' | 'launch'
export type DeviceSessionPhaseState = 'start' | 'complete' | 'skip' | 'fail'

export interface OpenDeviceSessionOptions {
  /** Prefix for error messages and preflight labels, e.g. `Worker 0`. */
  label: string
  onProgress?: (message: string) => void
  /**
   * Step-level progress for embedders with a step UI (the sequential CLI):
   * fired when the app install, the agent start and the app launch begin,
   * finish, are skipped or fail, with the detail the CLI has always shown
   * (`checking app.apk`, `com.x already installed (matching build)`,
   * `agent connected`, `launched com.x`, `no package configured`, …).
   */
  onPhase?: (phase: DeviceSessionPhase, state: DeviceSessionPhaseState, detail: string) => void
  /**
   * An already-connected client for `daemonAddress`, reused instead of opening
   * a second connection to the same daemon. The caller keeps ownership: a
   * failed open (and `closeDeviceSession`) leaves it for the caller to close.
   */
  client?: TapsmithGrpcClient
  /**
   * The emulator / simulator was provisioned for this run: reinstall the app
   * unconditionally (the snapshot may hold a stale build) and cycle the app
   * once after launch so JIT warmup does not land on the first test.
   */
  freshDevice?: boolean
  /**
   * The daemon already holds this device with the agent running and the app
   * launched (the sequential CLI's primary setup). Skip install / agent /
   * launch: connect, re-select, verify the session and probe capabilities.
   */
  adopt?: boolean
  /**
   * With `adopt`: the launch that already happened has not been consumed by
   * any test, so it is this session's `clear · file` prepared state.
   */
  adoptPrepared?: boolean
  /**
   * With `adopt`: verify the session (agent alive, app in front) before
   * returning. Default true. A per-run child whose runner performs a reset —
   * which ends with its own readiness check — passes false to skip the
   * duplicate round trip.
   */
  adoptVerify?: boolean
  /**
   * Sticky reset-capability knowledge from a parent process (in-app hooks
   * detected on this device by an earlier run). Seeds the session's own
   * capabilities so `appReset: 'auto'` resolves warm from the first file, and
   * the hooks probe is skipped when the answer is already known.
   */
  seedCapabilities?: ResetCapabilities
  /** Reinstall the app even when the installed build matches. */
  forceInstall?: boolean
  /** Headless CI emulators have no lockscreen — skip the wake/unlock RPCs. */
  skipWakeUnlock?: boolean
  /**
   * Ask the daemon to refresh its device listing before selecting. A daemon
   * that (re)connects later than its listing (a respawned UI worker) may not
   * know the device yet.
   */
  refreshDeviceList?: boolean
  connectTimeoutMs?: number
  /** `launchConfiguredApp` readiness attempts for the startup launch. */
  readinessAttempts?: number
  /** Name of the startup launch in traces/errors (default `startup launch`). */
  launchPhase?: string
  /**
   * Daemon process and agent port to record on the session when the caller
   * spawned the daemon itself (so `closeDeviceSession` tears it down).
   */
  daemonProcess?: ChildProcess
  agentPort?: number
  /**
   * Stamp this device's group name on every trace event it produces. Set for
   * groups of two or more; a single-device run records untagged events, as
   * it always has.
   */
  tagTraceEvents?: boolean
  /**
   * Pre-resolved agent artifacts. A group opens its sessions concurrently,
   * and resolving per device would race two simulator-agent builds against
   * each other — resolve once for the group and pass the result in.
   */
  artifacts?: AgentArtifacts
}

/** Agent / app artifact paths a session needs to (re)start its agent. */
export interface AgentArtifacts {
  agentApkPath?: string
  agentTestApkPath?: string
  iosXctestrunPath?: string
  iosAppPath?: string
}

// ─── Daemon processes ───

export interface SpawnDaemonOptions {
  daemonBin?: string
  port: number
  agentPort: number
  platform?: string
  stdio?: StdioOptions
  /** Anchor a relative `daemonBin` here (the config's rootDir). */
  rootDir?: string
}

/** Resolve the daemon binary the same way every embedder does. */
export function resolveDaemonBin(config: Pick<TapsmithConfig, 'daemonBin' | 'rootDir'>): string {
  const raw = process.env.TAPSMITH_DAEMON_BIN ?? config.daemonBin ?? findDaemonBin();
  return raw.includes(path.sep) || raw.startsWith('.') ? path.resolve(config.rootDir, raw) : raw;
}

/**
 * Spawn a `tapsmith-core` daemon on `port`, forwarding its agent on
 * `agentPort`. Does not wait for readiness — see {@link waitForDaemon}.
 */
export function spawnDaemon(opts: SpawnDaemonOptions): ChildProcess {
  const bin = opts.daemonBin ?? 'tapsmith-core';
  const args = ['--port', String(opts.port), '--agent-port', String(opts.agentPort)];
  if (opts.platform) args.push('--platform', opts.platform);
  const child = spawn(bin, args, { stdio: opts.stdio ?? 'ignore' });
  child.on('error', () => { /* surfaced by waitForDaemon */ });
  return child;
}

/** Wait for a daemon to answer on `address`; false when it does not. */
export async function waitForDaemon(address: string, timeoutMs = 10_000): Promise<boolean> {
  const client = new TapsmithGrpcClient(address);
  try {
    return await client.waitForReady(timeoutMs);
  } finally {
    client.close();
  }
}

/**
 * Spawn a daemon and wait for it. Kills the process and throws when it does
 * not come up, so callers never hold a handle to a daemon that is not there.
 */
export async function startDaemon(
  opts: SpawnDaemonOptions & { timeoutMs?: number; describe?: string },
): Promise<{ process: ChildProcess; address: string }> {
  const child = spawnDaemon(opts);
  const address = `localhost:${opts.port}`;
  const ready = await waitForDaemon(address, opts.timeoutMs);
  if (!ready) {
    try { child.kill(); } catch { /* already dead */ }
    throw new Error(`${opts.describe ?? 'daemon'} on port ${opts.port} did not become ready`);
  }
  child.unref();
  return { process: child, address };
}

// ─── Artifact resolution ───

/**
 * Resolve agent APK / xctestrun / device-signed .app paths for a device. The
 * xctestrun is auto-detected like every embedder did: the device slice under
 * `ios-agent/.build-device` for physical devices; for simulators
 * `ensureSimulatorAgent` also rebuilds on SDK mismatch instead of handing the
 * daemon a stale xctestrun that xcodebuild rejects at startup.
 */
export async function resolveAgentArtifacts(
  config: TapsmithConfig,
  serial: string,
  onProgress?: (message: string) => void,
  options: {
    /**
     * Fail when a physical iOS device has no device-slice xctestrun to run
     * (the agent cannot start without one). Off for adopting sessions, whose
     * agent is already running.
     */
    requireXctestrun?: boolean
  } = {},
): Promise<AgentArtifacts> {
  const agentApkPath = config.agentApk
    ? path.resolve(config.rootDir, config.agentApk)
    : findAgentApk();
  const agentTestApkPath = config.agentTestApk
    ? path.resolve(config.rootDir, config.agentTestApk)
    : findAgentTestApk();

  if (config.platform !== 'ios') {
    return { agentApkPath, agentTestApkPath };
  }

  // TAPSMITH_IOS_XCTESTRUN pins a locally built agent for any config that does
  // not set `iosXctestrun` — CI configs read it explicitly.
  let iosXctestrunPath = config.iosXctestrun
    ? path.resolve(config.rootDir, config.iosXctestrun)
    : process.env.TAPSMITH_IOS_XCTESTRUN || undefined;
  const { isPhysicalDevice } = await import('./ios-devicectl.js');
  const physical = isPhysicalDevice(serial);
  if (!iosXctestrunPath) {
    if (physical) {
      const { findDeviceXctestrun } = await import('./ios-device-resolve.js');
      iosXctestrunPath = findDeviceXctestrun(config.rootDir);
      if (!iosXctestrunPath && options.requireXctestrun) {
        throw new Error(
          'No device xctestrun found under ios-agent/.build-device. '
          + 'Run `tapsmith build-ios-agent` first, or set `iosXctestrun` explicitly.',
        );
      }
    } else {
      const { ensureSimulatorAgent } = await import('./ios-simulator-build.js');
      onProgress?.('resolving iOS simulator agent');
      iosXctestrunPath = await ensureSimulatorAgent();
    }
    if (iosXctestrunPath) onProgress?.(`auto-detected xctestrun: ${path.basename(iosXctestrunPath)}`);
  }
  // The daemon caches the .app path so physical-device `clearAppData` can
  // reinstall via devicectl; simulators and Android ignore it.
  const iosAppPath = config.app ? path.resolve(config.rootDir, config.app) : undefined;
  return { agentApkPath, agentTestApkPath, iosXctestrunPath, iosAppPath };
}

// ─── App install ───

interface InstallOutcome {
  /**
   * Whether the install was a *fresh* one — onto a device with no data
   * container for the app — which is the only case the startup launch may
   * skip its clear (a reinstall keeps the data).
   */
  freshInstall: boolean
  /**
   * An iOS simulator install still running. It is started here and awaited by
   * the caller right before the agent starts, so agent-artifact resolution
   * (possibly an xcodebuild) overlaps with the install instead of waiting
   * behind it. Resolves once the install is complete and reported.
   */
  pending?: Promise<void>
}

/**
 * Install the app under test unless the device already holds this exact
 * build. Progress lines keep the wording the parallel workers always emitted
 * (the dispatcher's launch-phase tracker parses them); `onPhase` carries the
 * sequential CLI's step details.
 */
async function installAppUnderTest(
  config: TapsmithConfig,
  device: Device,
  serial: string,
  opts: {
    freshDevice?: boolean
    forceInstall?: boolean
    onProgress?: (m: string) => void
    onPhase?: OpenDeviceSessionOptions['onPhase']
  },
): Promise<InstallOutcome> {
  const progress = opts.onProgress ?? (() => {});
  const phase = opts.onPhase ?? (() => {});

  if (config.platform !== 'ios') {
    if (!config.apk) {
      progress('app install skipped');
      phase('install', 'skip', 'no Android APK configured');
      return { freshInstall: false };
    }
    const resolvedApk = path.resolve(config.rootDir, config.apk);
    phase('install', 'start', `checking ${path.basename(resolvedApk)}`);
    const wasInstalled = !!config.package && isPackageInstalled(serial, config.package);
    // A rebuilt APK must replace the installed one; a freshly-launched AVD
    // snapshot may hold a stale build *with* data, so it is always reinstalled.
    const buildDiffers = wasInstalled && !!config.package
      && installedApkMatches(serial, config.package, resolvedApk) === false;
    const upToDate = !opts.freshDevice && wasInstalled && !buildDiffers;
    if (upToDate && !opts.forceInstall) {
      progress(`app ${config.package} already installed (matching build), skipping APK install`);
      phase('install', 'complete', `${config.package} already installed (matching build)`);
      return { freshInstall: false };
    }
    const why = buildDiffers ? ' (installed build differs)' : '';
    progress(`${wasInstalled ? 'reinstalling' : 'installing'} app APK ${path.basename(resolvedApk)}${why}`);
    try {
      await device.installApk(resolvedApk);
      if (config.package) await waitForPackageIndexed(serial, config.package);
    } catch (err) {
      phase('install', 'fail', `failed to install ${path.basename(resolvedApk)}`);
      throw new Error(`Failed to install app APK: ${err instanceof Error ? err.message : String(err)}`);
    }
    progress('app install complete');
    phase('install', 'complete', `installed ${path.basename(resolvedApk)}`);
    return { freshInstall: !wasInstalled };
  }

  if (!config.app) {
    progress('app install skipped');
    phase('install', 'skip', 'no iOS app configured');
    return { freshInstall: false };
  }
  const resolvedApp = path.resolve(config.rootDir, config.app);
  phase('install', 'start', `checking ${path.basename(resolvedApp)}`);
  const { isPhysicalDevice, installAppOnDevice, isAppInstalledOnDevice } = await import('./ios-devicectl.js');
  if (isPhysicalDevice(serial)) {
    const wasInstalled = !!config.package && (await isAppInstalledOnDevice(serial, config.package));
    if (wasInstalled && !opts.forceInstall && !opts.freshDevice) {
      progress(`app ${config.package} already installed, skipping app install`);
      phase('install', 'complete', `${config.package} already installed on device`);
      return { freshInstall: false };
    }
    progress(`${wasInstalled ? 'reinstalling' : 'installing'} ${path.basename(resolvedApp)} on device`);
    try {
      await installAppOnDevice(serial, resolvedApp);
    } catch (err) {
      phase('install', 'fail', `failed to install ${path.basename(resolvedApp)}`);
      throw new Error(`Failed to install iOS app: ${err instanceof Error ? err.message : String(err)}`);
    }
    progress('app install complete');
    phase('install', 'complete', `installed ${path.basename(resolvedApp)} on ${serial}`);
    return { freshInstall: !wasInstalled };
  }
  // Skip only when the installed bundle is byte-identical — simulator state
  // can outlive a run, and a presence-only skip silently tests a stale build.
  const wasInstalled = !!config.package && isAppInstalled(serial, config.package);
  const upToDate = !opts.freshDevice && wasInstalled
    && installedAppMatches(serial, config.package!, resolvedApp);
  if (upToDate && !opts.forceInstall) {
    progress(`app ${config.package} already installed (matching build), skipping app install`);
    phase('install', 'complete', `${config.package} already installed (matching build)`);
    return { freshInstall: false };
  }
  const why = wasInstalled && !opts.freshDevice ? ' (installed build differs)' : '';
  progress(`${wasInstalled ? 'reinstalling' : 'installing'} ${path.basename(resolvedApp)}${why}`);
  // Asynchronous: the caller resolves agent artifacts meanwhile and awaits
  // this before the agent starts (the iOS agent launches the app itself).
  const pending = installAppAsync(serial, resolvedApp).then(
    () => {
      progress('app install complete');
      phase('install', 'complete', `installed ${path.basename(resolvedApp)}`);
    },
    (err: unknown) => {
      phase('install', 'fail', `failed to install ${path.basename(resolvedApp)}`);
      throw new Error(`Failed to install iOS app: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  return { freshInstall: !wasInstalled, pending };
}

/**
 * Bring a simulator app to the foreground before the XCUITest agent attaches,
 * which avoids a brief black-screen flicker. Best-effort: the app may already
 * be running. Physical devices are skipped — `simctl launch` is simulator-only.
 */
async function prelaunchSimulatorApp(config: TapsmithConfig, serial: string): Promise<void> {
  if (config.platform !== 'ios' || !config.package) return;
  const { isPhysicalDevice } = await import('./ios-devicectl.js');
  if (isPhysicalDevice(serial)) return;
  try {
    execFileSync('xcrun', ['simctl', 'launch', serial, config.package], { stdio: 'ignore' });
  } catch {
    // App may already be running
  }
}

// ─── Session lifecycle ───

/**
 * Open a session on one device: connect to its daemon, select the device,
 * wake it, install the app, start the agent and cold-launch (or, with
 * `adopt`, verify what the daemon already holds). Throws with the session
 * label in the message when any step fails; the caller decides whether that
 * retires a worker or fails the run.
 */
export async function openDeviceSession(
  spec: DeviceSessionSpec,
  baseConfig: TapsmithConfig,
  opts: OpenDeviceSessionOptions,
): Promise<DeviceSession> {
  const progress = opts.onProgress ?? (() => {});
  const phase = opts.onPhase ?? (() => {});
  const label = `${opts.label} (${spec.serial})`;
  const config: TapsmithConfig = { ...baseConfig, device: spec.serial, daemonAddress: spec.daemonAddress };

  progress(`connecting to daemon on ${spec.daemonAddress}`);
  const client = opts.client ?? new TapsmithGrpcClient(spec.daemonAddress);
  const ready = await client.waitForReady(opts.connectTimeoutMs ?? 10_000);
  if (!ready) {
    if (!opts.client) client.close();
    throw new Error(`${label}: Failed to connect to daemon at ${spec.daemonAddress}`);
  }

  const device = new Device(client, config);
  if (opts.tagTraceEvents) device._traceDeviceId = spec.name;
  const networkTracingEnabled = isNetworkTracingEnabled(config.trace);
  const capabilities: ResetCapabilities = {};
  const session: DeviceSession = {
    name: spec.name,
    serial: spec.serial,
    daemonAddress: spec.daemonAddress,
    client,
    device,
    config,
    label,
    capabilities,
    context: {
      label,
      config,
      device,
      client,
      deviceSerial: spec.serial,
      networkTracingEnabled,
      capabilities,
    },
    daemonProcess: opts.daemonProcess,
    agentPort: opts.agentPort,
    ownsClient: !opts.client,
  };

  try {
    progress(`selecting device ${spec.serial}`);
    if (opts.refreshDeviceList) await device.listDevices();
    await retryDeviceSelection(
      () => device.setDevice(
        spec.serial,
        networkTracingEnabled,
        networkHostsForPac(config.trace),
        networkPassthroughHosts(config.trace),
      ),
      (err) => progress(`device selection failed transiently, retrying: ${err instanceof Error ? err.message : String(err)}`),
    );

    if (!opts.skipWakeUnlock) {
      try {
        progress('waking and unlocking device');
        await device.wake();
        await device.unlock();
      } catch {
        // Non-fatal — the device may already be awake and unlocked.
      }
    }

    if (opts.adopt) {
      // The daemon already installed, started the agent and launched (the
      // CLI's primary setup, or a previous run through the same daemon).
      // Resolve the artifact paths recovery needs, then verify and probe.
      Object.assign(session.context, opts.artifacts ?? await resolveAgentArtifacts(config, spec.serial, progress));
      if (opts.seedCapabilities) Object.assign(capabilities, opts.seedCapabilities);
      if (opts.adoptVerify ?? true) {
        progress('attaching to the device session');
        await ensureSessionReady(session.context, `${opts.label} adopt`);
      }
      // Detection only ever upgrades: a session that already knows the app
      // has hooks has nothing to probe for.
      if (!capabilities.hooksDetected) await probeResetCapabilities(session.context);
      session.prepared = opts.adoptPrepared
        ? { policy: { mode: 'clear', scope: 'file' }, preparedAt: Date.now(), durationMs: 0, source: 'startup launch' }
        : undefined;
      return session;
    }

    const install = await installAppUnderTest(config, device, spec.serial, {
      freshDevice: opts.freshDevice,
      forceInstall: opts.forceInstall,
      onProgress: progress,
      onPhase: phase,
    });

    // Resolving the agent artifacts may build the simulator agent; a pending
    // simulator install runs alongside it, and is awaited before the agent
    // starts because the iOS agent launches the app as soon as it is up.
    let artifacts: AgentArtifacts;
    try {
      artifacts = opts.artifacts ?? await resolveAgentArtifacts(config, spec.serial, progress, { requireXctestrun: true });
    } catch (err) {
      // Never leave the install dangling as an unhandled rejection.
      install.pending?.catch(() => {});
      phase('agent', 'fail', err instanceof Error ? err.message : String(err));
      throw err;
    }
    Object.assign(session.context, artifacts);
    if (install.pending) await install.pending;
    await prelaunchSimulatorApp(config, spec.serial);
    const freshInstall = install.freshInstall;

    progress('starting Tapsmith agent');
    phase('agent', 'start', config.platform === 'ios'
      ? `starting iOS agent (${artifacts.iosXctestrunPath ? path.basename(artifacts.iosXctestrunPath) : 'xctestrun not set'})`
      : 'starting Android automation agent');
    const startAgent = (): Promise<void> => device.startAgent(
      config.package ?? '',
      artifacts.agentApkPath,
      artifacts.agentTestApkPath,
      artifacts.iosXctestrunPath,
      artifacts.iosAppPath,
      networkTracingEnabled,
    );
    try {
      try {
        await startAgent();
      } catch (err) {
        if (!isRetryableAgentStartError(err)) throw err;
        progress(`agent startup failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
        // Let a transient agent-connection drop clear before the retry — an
        // immediate re-attempt lands inside the same drop window (PILOT-282).
        await new Promise((resolve) => setTimeout(resolve, AGENT_START_RETRY_DELAY_MS));
        await startAgent();
      }
    } catch (err) {
      phase('agent', 'fail', err instanceof Error ? err.message : String(err));
      throw new Error(`Failed to start agent: ${err instanceof Error ? err.message : String(err)}`);
    }
    progress('agent connected');
    phase('agent', 'complete', 'agent connected');

    const launchPhase = opts.launchPhase ?? 'startup launch';
    if (config.package) {
      progress(`launching ${config.package}`);
      phase('launch', 'start', `launching ${config.package}`);
      try {
        session.prepared = await launchConfiguredApp(session.context, launchPhase, {
          freshInstall,
          ...(opts.readinessAttempts !== undefined ? { readinessAttempts: opts.readinessAttempts } : {}),
        });
      } catch (err) {
        phase('launch', 'fail', `failed to launch ${config.package}`);
        throw new Error(`Failed to launch app: ${err instanceof Error ? err.message : String(err)}`);
      }
      progress('app launched');
      phase('launch', 'complete', `launched ${config.package}`);
    } else {
      progress('validating session readiness');
      await ensureSessionReady(session.context, `${opts.label} initialization`);
      progress('session ready');
      phase('launch', 'skip', 'no package configured');
    }

    // Warm up freshly launched emulators by cycling the app once. The first
    // launch on a cold emulator triggers JIT compilation and DEX optimization
    // that makes the first few tests unreasonably slow or time out.
    if (opts.freshDevice && config.package) {
      progress('warming up fresh emulator');
      await device.waitForIdle();
      await device.terminateApp(config.package);
      session.prepared = await launchConfiguredApp(session.context, 'emulator warmup launch');
      await device.waitForIdle();
    }

    return session;
  } catch (err) {
    closeDeviceSession(session);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.startsWith(label) ? message : `${label}: ${message}`);
  }
}

/**
 * Open every session of a device group concurrently, resolving the agent
 * artifacts once for all of them. If any member fails, the ones that opened
 * are closed again and the first failure is thrown — a group is atomic.
 */
export async function openDeviceGroup(
  specs: Array<DeviceSessionSpec & Partial<Pick<OpenDeviceSessionOptions, 'freshDevice' | 'adopt' | 'adoptPrepared' | 'seedCapabilities' | 'daemonProcess' | 'agentPort' | 'refreshDeviceList'>>>,
  config: TapsmithConfig,
  opts: Omit<OpenDeviceSessionOptions, 'freshDevice' | 'adopt' | 'adoptPrepared' | 'seedCapabilities' | 'daemonProcess' | 'agentPort' | 'artifacts' | 'onProgress'> & {
    /** Progress lines are prefixed with the member name for groups of two or more. */
    onProgress?: (message: string, member: DeviceSessionSpec) => void
  },
): Promise<DeviceSession[]> {
  if (specs.length === 0) return [];
  // Same fast-fail as a single session: a physical iOS group with no
  // device xctestrun stops here with the `build-ios-agent` hint, not in
  // xcodebuild. Adopting members have a running agent and need none.
  const artifacts = await resolveAgentArtifacts(
    { ...config, device: specs[0].serial },
    specs[0].serial,
    (m) => opts.onProgress?.(m, specs[0]),
    { requireXctestrun: specs.some((spec) => !spec.adopt) },
  );
  const results = await Promise.allSettled(specs.map((spec) => openDeviceSession(spec, config, {
    ...opts,
    artifacts,
    tagTraceEvents: specs.length > 1,
    freshDevice: spec.freshDevice,
    adopt: spec.adopt,
    adoptPrepared: spec.adoptPrepared,
    seedCapabilities: spec.seedCapabilities,
    daemonProcess: spec.daemonProcess,
    agentPort: spec.agentPort,
    refreshDeviceList: spec.refreshDeviceList ?? opts.refreshDeviceList,
    onProgress: (m) => opts.onProgress?.(specs.length > 1 ? `[${spec.name}] ${m}` : m, spec),
  })));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    for (const r of results) if (r.status === 'fulfilled') closeDeviceSession(r.value);
    throw failure.reason;
  }
  return results.map((r) => (r as PromiseFulfilledResult<DeviceSession>).value);
}

/**
 * Bring a session back after an infrastructure error (agent drop, ADB hiccup,
 * simulator wedge): reboot an unhealthy simulator (reinstalling the app it
 * may have lost), then relaunch. The relaunch is a fresh `clear`, recorded as
 * the session's prepared state for the retried file.
 */
export async function recoverDeviceSession(session: DeviceSession, phase: string): Promise<void> {
  const { config, serial } = session;
  if (config.platform === 'ios') {
    const health = probeSimulatorHealth(serial);
    if (!health.healthy) {
      process.stderr.write(`${session.label}: Simulator is unhealthy (${health.reason}), rebooting...\n`);
      rebootSimulator(serial);
      if (config.app) installApp(serial, path.resolve(config.rootDir, config.app));
      process.stderr.write(`${session.label}: Simulator rebooted and healthy.\n`);
    }
  }
  if (config.package) {
    session.prepared = await launchConfiguredApp(session.context, phase);
  } else {
    session.prepared = undefined;
    await ensureSessionReady(session.context, phase);
  }
}

/**
 * Recover every session of a group, concurrently — the devices are
 * independent, and a serial recovery doubles the cost of every retry.
 */
export async function recoverDeviceSessions(sessions: DeviceSession[], phase: string): Promise<void> {
  await Promise.all(sessions.map((s) => recoverDeviceSession(s, phase)));
}

/**
 * Close a session: the Device, the gRPC client, and — when this session owns
 * it — the daemon and the ADB forward it left on the device. Idempotent.
 */
export function closeDeviceSession(session: DeviceSession): void {
  // The Device holds the same client instance: a plain `device.close()`
  // would close a caller-owned one behind the guard below.
  const ownsClient = session.ownsClient !== false;
  session.device._close({ closeClient: ownsClient }).catch(() => { /* already closed */ });
  if (ownsClient) {
    try { session.client.close(); } catch { /* already closed */ }
  }
  if (session.daemonProcess) {
    try { session.daemonProcess.kill(); } catch { /* already gone */ }
    session.daemonProcess = undefined;
  }
  if (session.agentPort !== undefined && session.config.platform !== 'ios') {
    try {
      execFileSync('adb', ['-s', session.serial, 'forward', '--remove', `tcp:${session.agentPort}`], {
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch { /* forward may already be gone */ }
  }
}

/** Consume a session's prepared state (once): the next file's reset uses it. */
export function consumePrepared(session: DeviceSession): PreparedState | undefined {
  const p = session.prepared;
  session.prepared = undefined;
  return p;
}
