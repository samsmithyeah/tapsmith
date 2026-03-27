import type { PilotConfig } from './config.js';
import type { Device } from './device.js';
import type { LaunchAppOptions, PilotGrpcClient } from './grpc-client.js';
import { text } from './selectors.js';
import { detectBlockingSystemDialog, dismissSystemDialogsViaAdb } from './emulator.js';

type SessionDevice = Pick<Device, 'startAgent' | 'terminateApp' | 'launchApp' | 'restartApp' | 'waitForIdle' | 'currentPackage' | 'tap' | 'pressBack' | 'clearAppData'>
type SessionClient = Pick<PilotGrpcClient, 'ping' | 'getUiHierarchy'>

export interface SessionPreflightContext {
  label: string
  config: Pick<PilotConfig, 'package' | 'activity' | 'platform'>
  device: SessionDevice
  client: SessionClient
  agentApkPath?: string
  agentTestApkPath?: string
  iosXctestrunPath?: string
  /** ADB serial for this device — enables ADB-level recovery when agent is unavailable */
  deviceSerial?: string
}

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 2;
/** Time to wait for UIAutomator2 to produce a non-empty hierarchy on cold start. */
const HIERARCHY_READY_TIMEOUT_MS = 10_000;
const HIERARCHY_POLL_INTERVAL_MS = 500;

export async function ensureSessionReady(
  ctx: SessionPreflightContext,
  phase: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await verifySession(ctx);
      return;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      await recoverSession(ctx);
    }
  }

  throw new Error(
    `${ctx.label}: session preflight failed during ${phase}: ${formatError(lastError)}`,
  );
}

export async function launchConfiguredApp(
  ctx: SessionPreflightContext,
  phase: string,
): Promise<void> {
  if (!ctx.config.package) {
    await ensureSessionReady(ctx, phase);
    return;
  }

  if (ctx.config.platform === 'ios') {
    // On iOS, restart the app for file-level isolation.
    // Use restartApp which does a full agent restart — terminate the
    // app, kill the XCUITest runner, relaunch, and start a fresh agent.
    await ctx.device.restartApp(ctx.config.package);
    return;
  }

  try {
    await ctx.device.terminateApp(ctx.config.package);
  } catch {
    // App may not be running yet
  }

  // Clear app data before launching to ensure proper isolation between test
  // files. Without this, state from a previous file (e.g. auth tokens in
  // AsyncStorage) leaks into the next file. Projects that need persisted
  // state use test.use({ appState }) which restores after this reset.
  await ctx.device.clearAppData(ctx.config.package);

  await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config));

  await ensureSessionReady(ctx, phase);
}

async function verifySession(ctx: SessionPreflightContext): Promise<void> {
  const pong = await ctx.client.ping();
  if (!pong.agentConnected) {
    throw new Error('agent is not connected');
  }

  if (ctx.config.platform === 'ios') {
    // On iOS, a successful ping is sufficient. Skip the expensive hierarchy
    // dump (Android-specific UIAutomator2 readiness check) and the
    // foreground package check (iOS doesn't expose this reliably).
    return;
  }

  await ctx.device.waitForIdle(DEFAULT_READY_TIMEOUT_MS);

  const hierarchy = await waitForHierarchy(ctx.client);

  const blockingDialog = detectBlockingSystemDialog(hierarchy.hierarchyXml);
  if (blockingDialog) {
    throw new Error(`blocking system dialog detected (${blockingDialog})`);
  }

  if (ctx.config.package) {
    const currentPackage = await ctx.device.currentPackage();
    if (currentPackage !== ctx.config.package) {
      // The app may still be visible underneath a system overlay (e.g. launcher
      // text-selection, share sheet). Check if the hierarchy contains nodes
      // from the expected package — if so, dismiss the overlay rather than failing.
      const appInHierarchy = hierarchy.hierarchyXml.includes(`package="${ctx.config.package}"`);
      if (!appInHierarchy) {
        throw new Error(
          `foreground package mismatch (expected ${ctx.config.package}, got ${currentPackage || '(none)'})`,
        );
      }
      await ctx.device.pressBack();
      await ctx.device.waitForIdle(DEFAULT_READY_TIMEOUT_MS);
    }
  }
}

async function recoverSession(ctx: SessionPreflightContext): Promise<void> {
  // First try ADB-level dismissal — works even when the agent is dead (Android only)
  if (ctx.deviceSerial && ctx.config.platform !== 'ios') {
    dismissSystemDialogsViaAdb(ctx.deviceSerial);
  }

  // Then try agent-level dismissal if the agent is reachable
  await dismissBlockingSystemUi(ctx);
  await ctx.device.startAgent(ctx.config.package ?? '', ctx.agentApkPath, ctx.agentTestApkPath, ctx.iosXctestrunPath);
  if (!ctx.config.package) return;

  try {
    await ctx.device.terminateApp(ctx.config.package);
  } catch {
    // App may not be running
  }

  await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config));
}

async function dismissBlockingSystemUi(ctx: SessionPreflightContext): Promise<void> {
  let hierarchy = '';
  try {
    hierarchy = (await ctx.client.getUiHierarchy()).hierarchyXml;
  } catch {
    return;
  }

  if (!detectBlockingSystemDialog(hierarchy)) return;

  for (const selector of [text('Wait'), text('Close app'), text('OK')]) {
    try {
      await ctx.device.tap(selector);
      await ctx.device.waitForIdle(1_000);
    } catch {
      // Best effort
    }
  }

  try {
    await ctx.device.pressBack();
    await ctx.device.waitForIdle(1_000);
  } catch {
    // Best effort
  }
}

function launchOptions(config: Pick<PilotConfig, 'activity'>): LaunchAppOptions {
  return {
    ...(config.activity ? { activity: config.activity } : {}),
    waitForIdle: false,
  };
}

async function waitForHierarchy(
  client: SessionClient,
): Promise<{ hierarchyXml: string }> {
  const deadline = Date.now() + HIERARCHY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hierarchy = await client.getUiHierarchy();
    if (hierarchy.hierarchyXml.trim()) {
      return hierarchy;
    }
    await new Promise(resolve => setTimeout(resolve, HIERARCHY_POLL_INTERVAL_MS));
  }
  throw new Error('UI hierarchy is empty (timed out waiting for UIAutomator2)');
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
