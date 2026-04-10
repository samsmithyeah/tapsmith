import type { PilotConfig } from './config.js';
import type { Device } from './device.js';
import type { LaunchAppOptions, PilotGrpcClient } from './grpc-client.js';
import { detectBlockingSystemDialog, dismissSystemDialogsViaAdb } from './emulator.js';

type SessionDevice = Pick<Device, 'startAgent' | 'terminateApp' | 'launchApp' | 'restartApp' | 'waitForIdle' | 'currentPackage' | 'getByText' | 'pressBack' | 'clearAppData' | 'openDeepLink' | 'getAppState'>
type SessionClient = Pick<PilotGrpcClient, 'ping' | 'getUiHierarchy'>

export interface SessionPreflightContext {
  label: string
  config: Pick<PilotConfig, 'package' | 'activity' | 'platform' | 'resetAppDeepLink' | 'resetAppWaitMs'>
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
const DEFAULT_SOFT_RESET_WAIT_MS = 750;

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
  options: { allowSoftReset?: boolean } = {},
): Promise<void> {
  if (!ctx.config.package) {
    await ensureSessionReady(ctx, phase);
    return;
  }

  const allowSoftReset = options.allowSoftReset ?? true;
  if (ctx.config.platform === 'ios') {
    if (allowSoftReset && ctx.config.resetAppDeepLink) {
      await softResetAppViaDeepLink(ctx);
      await ensureSessionReady(ctx, phase);
      return;
    }

    // On iOS, clear data then restart for isolation between test files.
    // clearAppData removes AsyncStorage (including React Navigation state).
    // restartApp handles terminate → relaunch atomically through the daemon
    // with fallback mechanisms (in-runner relaunch → simctl relaunch →
    // full agent restart), avoiding the race condition where a separate
    // terminateApp + launchApp sequence can reconnect to a dying process.
    await ctx.device.clearAppData(ctx.config.package);
    try {
      await ctx.device.restartApp(ctx.config.package);
    } catch (err) {
      // restartApp can fail on iOS if the agent session is stale after
      // clearAppData. The app will be relaunched by ensureSessionReady's
      // recovery path, or by the test's own beforeAll/beforeEach. Surface
      // the error to stderr so a real app crash here is debuggable rather
      // than silently masked until the next test fails for an unrelated
      // reason.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pilot] iOS file-level restartApp failed (will recover): ${message}\n`);
    }
    await ensureSessionReady(ctx, phase);
    // After launch, wait for the app to actually be ready (non-empty
    // accessibility hierarchy). This guards the file-level race where
    // beforeAll can fire before the React Native JS bundle has loaded.
    await waitForIosAppReady(ctx);
    return;
  }

  // Android uses separate terminate → clear → launch steps. Unlike iOS,
  // Android's terminateApp reliably kills the process before clearAppData
  // runs, and launchApp doesn't race with a dying process. iOS must use
  // the atomic restartApp path (above) to avoid reconnecting to a stale
  // process that's mid-teardown after clearAppData.
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

  // Restart the agent BEFORE launching the app. The terminate + clearAppData
  // sequence above kills the agent process. If we launch the app first and
  // then let ensureSessionReady discover the dead agent, its recoverSession
  // path does a redundant terminateApp + launchApp cycle that can restore
  // the Activity's saved instance state Bundle (e.g. React Navigation route).
  await ctx.device.startAgent(
    ctx.config.package, ctx.agentApkPath, ctx.agentTestApkPath, ctx.iosXctestrunPath,
  );

  await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config));

  await ensureSessionReady(ctx, phase);
}

async function verifySession(ctx: SessionPreflightContext): Promise<void> {
  const pong = await ctx.client.ping();
  if (!pong.agentConnected) {
    throw new Error('agent is not connected');
  }

  if (ctx.config.platform === 'ios') {
    // On iOS, ensure the configured app is in the foreground. If a previous
    // test terminated, backgrounded, or otherwise displaced the app, relaunch
    // it cheaply via launchApp (no clearData) so the next test starts on a
    // sensible state. We deliberately do NOT poll the UI hierarchy here —
    // that path was triggering expensive recovery on every test, see
    // waitForIosAppReady (used only by launchConfiguredApp) for the
    // post-launch readiness check.
    if (ctx.config.package) {
      try {
        const state = await ctx.device.getAppState(ctx.config.package);
        if (state !== 'foreground') {
          await ctx.device.launchApp(ctx.config.package);
        }
      } catch (err) {
        // getAppState/launchApp failures are best-effort recovery; let the
        // test itself surface a clearer error if the app is still broken.
        // Surface to stderr so a real failure here is debuggable rather than
        // silently masked until the next test fails for an unrelated reason.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pilot] iOS verifySession recovery failed (continuing): ${message}\n`);
      }
    }
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

/**
 * Wait for an iOS app to be ready after launch by polling for a non-empty
 * accessibility hierarchy. Used at the file level (after launchConfiguredApp)
 * where we know the app should be in the foreground; not used per-test
 * because tests may intentionally leave the app stopped.
 */
async function waitForIosAppReady(ctx: SessionPreflightContext): Promise<void> {
  const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const h = await ctx.client.getUiHierarchy();
      if (h.hierarchyXml && h.hierarchyXml.trim().length > 0) return;
    } catch {
      // Agent may not be ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, HIERARCHY_POLL_INTERVAL_MS));
  }
  throw new Error('iOS app not ready: accessibility hierarchy is empty after launch');
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

async function softResetAppViaDeepLink(ctx: SessionPreflightContext): Promise<void> {
  const resetDeepLink = ctx.config.resetAppDeepLink!;
  await ctx.device.openDeepLink(resetDeepLink);

  const waitMs = ctx.config.resetAppWaitMs ?? DEFAULT_SOFT_RESET_WAIT_MS;
  try {
    await ctx.device.waitForIdle(waitMs);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const homeDeepLink = getHomeDeepLink(resetDeepLink);
  if (!homeDeepLink || homeDeepLink === resetDeepLink) return;

  await ctx.device.openDeepLink(homeDeepLink);

  try {
    await ctx.device.waitForIdle(waitMs);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function dismissBlockingSystemUi(ctx: SessionPreflightContext): Promise<void> {
  let hierarchy = '';
  try {
    hierarchy = (await ctx.client.getUiHierarchy()).hierarchyXml;
  } catch {
    return;
  }

  if (!detectBlockingSystemDialog(hierarchy)) return;

  for (const label of ['Not Now', 'Wait', 'Close app', 'OK']) {
    try {
      await ctx.device.getByText(label, { exact: true }).tap();
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

function getHomeDeepLink(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}
