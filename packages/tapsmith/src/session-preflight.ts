import type { TapsmithConfig } from './config.js';
import type { Device } from './device.js';
import type { LaunchAppOptions, TapsmithGrpcClient } from './grpc-client.js';
import { detectBlockingSystemDialog, dismissSystemDialogsViaAdb } from './emulator.js';
import { withActionProgress } from './action-progress.js';

type SessionDevice = Pick<Device, 'startAgent' | 'terminateApp' | 'launchApp' | 'restartApp' | 'waitForIdle' | 'currentPackage' | 'getByText' | 'pressBack' | 'clearAppData' | 'openDeepLink' | 'getAppState'>
type SessionClient = Pick<TapsmithGrpcClient, 'ping' | 'getUiHierarchy'>

export interface SessionPreflightContext {
  label: string
  config: Pick<TapsmithConfig, 'package' | 'activity' | 'platform' | 'resetAppDeepLink' | 'resetAppWaitMs' | 'device'>
  device: SessionDevice
  client: SessionClient
  agentApkPath?: string
  agentTestApkPath?: string
  iosXctestrunPath?: string
  /**
   * Device-signed .app bundle path. On physical iOS, the daemon caches this
   * so that `clearAppData` can reinstall the app. Ignored on simulators
   * and Android.
   */
  iosAppPath?: string
  /** ADB serial for this device — enables ADB-level recovery when agent is unavailable */
  deviceSerial?: string
  /**
   * Whether this session wants network tracing. Threaded through to
   * `startAgent` so daemon recovery paths don't spin up the physical-iOS
   * MITM proxy for a basic-track session. Default false is the safe
   * no-op. Callers should compute this once via `isNetworkTracingEnabled`.
   */
  networkTracingEnabled?: boolean
}

export interface EnsureSessionReadyOptions {
  onRecovery?: (error: unknown) => void
  /**
   * Delay (ms) before recovery attempt N (the last entry is reused when
   * attempts exceed the list). Defaults to {@link DEFAULT_RETRY_BACKOFF_MS};
   * overridable so unit tests don't sleep for real.
   */
  retryBackoffMs?: number[]
}

class BlockingDialogError extends Error {}

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * Backoff before each recovery attempt. A transient agent-connection drop
 * (PILOT-282) takes a few seconds to clear, and the recovery RPCs themselves
 * can hit the same blip — immediate retries land inside the same window and
 * burn every layer's budget in milliseconds, failing the test at 0ms while an
 * interactive (UI-mode/MCP) session recovers from the identical drop simply
 * because the operator's next command arrives seconds later. This backoff
 * gives test runs the same wall-clock tolerance.
 */
const DEFAULT_RETRY_BACKOFF_MS = [1_000, 2_000];
/** Time to wait for UIAutomator2 to produce a non-empty hierarchy on cold start. */
const HIERARCHY_READY_TIMEOUT_MS = 10_000;
/** Time to wait for a cold-launched iOS app to render a non-empty accessibility
 *  hierarchy. A first RN launch on a loaded CI runner (right after the agent's
 *  xcodebuild warmup) can take well over 30s to paint — observed when the app
 *  cold-starts at the tail of a 60s+ xcodebuild warmup on a pegged runner. The
 *  poll returns as soon as the hierarchy appears, so the generous ceiling costs
 *  nothing when healthy. This check runs once per file-level launch and sits
 *  outside `ensureSessionReady`'s retry envelope — a single timeout here kills
 *  the whole shard at setup, so err on the side of patience. */
const IOS_APP_READY_TIMEOUT_MS = 90_000;
/** Per-poll RPC deadline inside {@link waitForIosAppReady}. Without it, one
 *  snapshot call wedged on a busy simulator inherits the 60s client default
 *  and eats most of the readiness budget in a single sample. */
const IOS_APP_READY_POLL_DEADLINE_MS = 5_000;
/** How long the readiness poll tolerates a non-foreground app before its
 *  one-shot relaunch. Covers an app that crashed mid-launch or lost the
 *  foreground to SpringBoard on a slow runner. */
const IOS_APP_READY_RELAUNCH_AFTER_MS = 20_000;
const HIERARCHY_POLL_INTERVAL_MS = 500;
const DEFAULT_SOFT_RESET_WAIT_MS = 750;

export async function ensureSessionReady(
  ctx: SessionPreflightContext,
  phase: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  options: EnsureSessionReadyOptions = {},
): Promise<void> {
  return withActionProgress('sessionReady', ctx.config.package, async () => {
    let lastError: unknown;
    const backoff = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await verifySession(ctx);
        return;
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) break;
        options.onRecovery?.(err);
        // Give a transient agent-connection drop time to clear before
        // recovering — the recovery RPCs go over the same channel and an
        // immediate retry lands inside the same drop window (PILOT-282).
        await delay(backoff[attempt - 1] ?? backoff.at(-1) ?? 0);
        try {
          await recoverSession(ctx);
        } catch (recoveryErr) {
          // The recovery RPC can hit the same transient agent/ADB transport
          // blip that caused verification to fail. If the caller allowed more
          // attempts, loop back and probe the session again before giving up.
          lastError = recoveryErr;
          if (attempt === maxAttempts - 1) break;
        }
      }
    }

    throw new Error(
      `${ctx.label}: session preflight failed during ${phase}: ${formatError(lastError)}`,
    );
  });
}

export async function launchConfiguredApp(
  ctx: SessionPreflightContext,
  phase: string,
  options: { allowSoftReset?: boolean; readinessAttempts?: number; skipAppReset?: boolean; skipDataClear?: boolean } = {},
): Promise<void> {
  const readinessAttempts = options.readinessAttempts;

  if (!ctx.config.package) {
    await ensureSessionReady(ctx, phase, readinessAttempts);
    return;
  }

  const allowSoftReset = options.allowSoftReset ?? true;
  if (allowSoftReset && ctx.config.resetAppDeepLink) {
    try {
      await softResetAppViaDeepLink(ctx);
      await ensureSessionReady(ctx, phase, readinessAttempts);
      if (ctx.config.platform === 'ios') {
        await waitForIosAppReady(ctx);
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tapsmith] Soft reset failed, falling back to hard reset: ${message}\n`);
    }
  }

  // Skip the expensive clearAppData + restartApp cycle when either:
  //  - skipAppReset (fresh install / startup): the app was just installed,
  //    there's no state to clear; or
  //  - skipDataClear: a non-empty `appState` restore will follow for this
  //    scope and owns isolation. The restore does its own keystore-preserving
  //    in-place data clear, so clearing here is redundant AND harmful: on
  //    Android `clearAppData` is `pm clear`, which also wipes the app's
  //    AndroidKeyStore keys. Those keys decrypt credentials persisted inside
  //    the data dir (e.g. Firebase Auth's Tink keyset), are device-bound, and
  //    are NOT in the saved-state archive — so once pm clear destroys them the
  //    restored ciphertext can't be decrypted and the app comes back signed
  //    out. (On iOS the keychain is captured into the archive, so a clear here
  //    is merely wasteful, not destructive.)
  // On Android, explicitly launch the app (iOS auto-launches via the XCUITest
  // agent during startAgent). Then go straight to ensuring the session is ready.
  if (options.skipAppReset || options.skipDataClear) {
    if (ctx.config.platform !== 'ios') {
      await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config));
    }
    await ensureSessionReady(ctx, phase, readinessAttempts);
    if (ctx.config.platform === 'ios') {
      await waitForIosAppReady(ctx);
    }
    return;
  }

  if (ctx.config.platform === 'ios') {
    // On iOS, clear data then restart for isolation between test files.
    // clearAppData removes AsyncStorage (including React Navigation state).
    // restartApp handles terminate → relaunch atomically through the daemon
    // with fallback mechanisms (in-runner relaunch → simctl relaunch →
    // full agent restart), avoiding the race condition where a separate
    // terminateApp + launchApp sequence can reconnect to a dying process.
    //
    // On physical iOS devices the daemon implements clearAppData via
    // uninstall + reinstall (devicectl), since there's no host-side
    // app-container access. That path requires StartAgent to have been
    // called with ios_app_path — tapsmith's CLI + worker runners always do.
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
      process.stderr.write(`[tapsmith] iOS file-level restartApp failed (will recover): ${message}\n`);
    }
    await ensureSessionReady(ctx, phase, readinessAttempts);
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
  // Best-effort: if the agent restart fails here (e.g. missing APK),
  // ensureSessionReady's recovery path will retry with a clearer error.
  try {
    await ctx.device.startAgent(
      ctx.config.package, ctx.agentApkPath, ctx.agentTestApkPath, ctx.iosXctestrunPath, ctx.iosAppPath,
      ctx.networkTracingEnabled ?? false,
    );
  } catch {
    // Will be recovered by ensureSessionReady below
  }

  await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config));

  await ensureSessionReady(ctx, phase, readinessAttempts);
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
        const state = await ctx.device.getAppState(ctx.config.package, { timeout: 10_000 });
        if (state !== 'foreground') {
          await ctx.device.launchApp(ctx.config.package);
        }
      } catch (err) {
        // Agent communication failures (timeout, socket disconnect) mean the
        // session is broken. Throw so ensureSessionReady triggers a proper
        // recovery (agent restart + app relaunch) instead of letting the test
        // run against a dead connection.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tapsmith] iOS verifySession recovery failed: ${message}\n`);
        throw err;
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
      const appInHierarchy = hierarchyContainsPackage(hierarchy.hierarchyXml, ctx.config.package);
      if (!appInHierarchy) {
        throw new Error(
          `foreground package mismatch (expected ${ctx.config.package}, got ${currentPackage || '(none)'})`,
        );
      }
      await ctx.device.pressBack();
      await ctx.device.waitForIdle(DEFAULT_READY_TIMEOUT_MS);
    } else {
      await waitForAndroidAppHierarchy(ctx, hierarchy.hierarchyXml, ctx.config.package);
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
  const start = Date.now();
  const deadline = start + IOS_APP_READY_TIMEOUT_MS;
  // An "empty hierarchy" almost never means an empty tree: the daemon maps
  // agent snapshot failures (e.g. "Unable to lookup in current state" while
  // the app is still launching) to an empty string + errorMessage. Track the
  // last problem so the final error reports the real cause instead of the
  // misleading "hierarchy is empty".
  let lastProblem = '';
  let relaunched = false;
  while (Date.now() < deadline) {
    try {
      const h = await ctx.client.getUiHierarchy(IOS_APP_READY_POLL_DEADLINE_MS);
      if (h.hierarchyXml && h.hierarchyXml.trim().length > 0) return;
      lastProblem = h.errorMessage || '(hierarchy genuinely empty)';
    } catch (err) {
      // Agent may not be ready yet
      lastProblem = err instanceof Error ? err.message : String(err);
    }
    // Distinguish "app alive, still loading" from "app never made it to the
    // foreground" (crashed mid-launch / stuck behind SpringBoard): after a
    // grace window, relaunch once and keep polling. Guarded to a single shot
    // so a crash loop still surfaces as a failure, with a stderr breadcrumb.
    if (
      !relaunched &&
      ctx.config.package &&
      Date.now() - start >= IOS_APP_READY_RELAUNCH_AFTER_MS
    ) {
      try {
        const state = await ctx.device.getAppState(ctx.config.package, { timeout: 5_000 });
        // Consume the one-shot only once the probe answered: a transient
        // probe failure (caught below) must not permanently disable the
        // relaunch — the next poll tick gets to probe again.
        relaunched = true;
        if (state !== 'foreground') {
          process.stderr.write(
            `[tapsmith] iOS app not in foreground (${state}) after ` +
            `${Math.round((Date.now() - start) / 1000)}s waiting for readiness; relaunching once\n`,
          );
          await ctx.device.launchApp(ctx.config.package);
        }
      } catch {
        // Keep polling — the relaunch probe itself may hit a still-busy agent.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HIERARCHY_POLL_INTERVAL_MS));
  }
  throw new Error(
    `iOS app not ready ${IOS_APP_READY_TIMEOUT_MS}ms after launch: ` +
    `${lastProblem || 'accessibility hierarchy is empty'}`,
  );
}

async function waitForAndroidAppHierarchy(
  ctx: SessionPreflightContext,
  initialHierarchyXml: string,
  packageName: string,
): Promise<void> {
  let hierarchyXml = initialHierarchyXml;
  if (hierarchyContainsPackage(hierarchyXml, packageName)) return;

  if (isAndroidSystemOverlay(hierarchyXml)) {
    const dismissedHierarchy = await dismissAndroidSystemOverlay(ctx, packageName);
    if (dismissedHierarchy) {
      hierarchyXml = dismissedHierarchy;
      if (hierarchyContainsPackage(hierarchyXml, packageName)) return;
    }
  }

  const deadline = Date.now() + HIERARCHY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const h = await ctx.client.getUiHierarchy();
      hierarchyXml = h.hierarchyXml;
      if (hierarchyContainsPackage(hierarchyXml, packageName)) return;
      const blockingDialog = detectBlockingSystemDialog(hierarchyXml);
      if (blockingDialog) {
        throw new BlockingDialogError(`blocking system dialog detected (${blockingDialog})`);
      }
      if (isAndroidSystemOverlay(hierarchyXml)) {
        const dismissedHierarchy = await dismissAndroidSystemOverlay(ctx, packageName);
        if (dismissedHierarchy) {
          hierarchyXml = dismissedHierarchy;
          if (hierarchyContainsPackage(hierarchyXml, packageName)) return;
        }
      }
    } catch (err) {
      if (err instanceof BlockingDialogError) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, HIERARCHY_POLL_INTERVAL_MS));
  }

  throw new Error(`Android app hierarchy for ${packageName} not ready after launch`);
}

function hierarchyContainsPackage(hierarchyXml: string, packageName: string): boolean {
  return hierarchyXml.includes(`package="${packageName}"`);
}

async function dismissAndroidSystemOverlay(
  ctx: SessionPreflightContext,
  packageName: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ctx.device.pressBack();
      await ctx.device.waitForIdle(1_000);
      const h = await ctx.client.getUiHierarchy();
      if (hierarchyContainsPackage(h.hierarchyXml, packageName) || !isAndroidSystemOverlay(h.hierarchyXml)) {
        return h.hierarchyXml;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isAndroidSystemOverlay(hierarchyXml: string): boolean {
  return hierarchyXml.includes('package="com.android.systemui"') && (
    hierarchyXml.includes('resource-id="com.android.systemui:id/notification_panel"') ||
    hierarchyXml.includes('resource-id="com.android.systemui:id/notification_stack_scroller"') ||
    hierarchyXml.includes('resource-id="com.android.systemui:id/quick_settings_container"') ||
    hierarchyXml.includes('resource-id="com.android.systemui:id/qs_frame"')
  );
}

async function recoverSession(ctx: SessionPreflightContext): Promise<void> {
  // First try ADB-level dismissal — works even when the agent is dead (Android only)
  if (ctx.deviceSerial && ctx.config.platform !== 'ios') {
    dismissSystemDialogsViaAdb(ctx.deviceSerial);
  }

  // Then try agent-level dismissal if the agent is reachable
  await dismissBlockingSystemUi(ctx);
  await ctx.device.startAgent(ctx.config.package ?? '', ctx.agentApkPath, ctx.agentTestApkPath, ctx.iosXctestrunPath, ctx.iosAppPath, ctx.networkTracingEnabled ?? false);
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
  // forceColdLaunch: the between-file reset is the boundary that keeps warm
  // in-process delivery safe on iOS simulators. Long all-warm sessions
  // accumulate native navigation-stack state that diverges observably from a
  // cold launch (a11y trees stop being flattened, element ids go stale);
  // cold-relaunching here bounds the warm window to a single test file and
  // pins each file's starting state to a fresh process. No effect on Android
  // or physical iOS, which always deliver warm.
  await ctx.device.openDeepLink(resetDeepLink, { forceColdLaunch: true });

  const waitMs = ctx.config.resetAppWaitMs ?? DEFAULT_SOFT_RESET_WAIT_MS;
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

function launchOptions(config: Pick<TapsmithConfig, 'activity'>): LaunchAppOptions {
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

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
