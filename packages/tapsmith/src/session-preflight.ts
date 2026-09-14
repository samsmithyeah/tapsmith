import { DEFAULT_APP_RESET_COLD_EVERY, type TapsmithConfig } from './config.js';
import type { Device } from './device.js';
import { appResetAction, parseHooksMarker, satisfies, type AppResetPolicy, type AppResetReport, type AppResetStep, type PreparedState, type ResetCapabilities } from './app-reset.js';
import type { AppState, LaunchAppOptions, TapsmithGrpcClient } from './grpc-client.js';
import { detectBlockingSystemDialog, dismissSystemDialogsViaAdb } from './emulator.js';
import { withActionProgress, type ActionProgressHandle } from './action-progress.js';

type SessionDevice = Pick<Device, 'startAgent' | 'terminateApp' | 'launchApp' | 'restartApp' | 'waitForIdle' | 'currentPackage' | 'getByText' | 'pressBack' | 'clearAppData' | 'restoreAppState' | 'openDeepLink' | 'getAppState' | '_resetApp'>
type SessionClient = Pick<TapsmithGrpcClient, 'ping' | 'getUiHierarchy'>

export interface SessionPreflightContext {
  label: string
  config: Pick<TapsmithConfig, 'package' | 'activity' | 'platform' | 'resetAppDeepLink' | 'resetAppWaitMs' | 'appReset' | 'appResetColdEvery' | 'device'>
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
  /**
   * What the running app can offer for resets (in-app hooks detected, …).
   * Filled by {@link probeResetCapabilities} after a launch and refreshed by
   * every reset; the runner resolves `appReset: 'auto'` from it. Mutable on
   * purpose — one context object is shared across a worker's files.
   */
  capabilities?: ResetCapabilities
}

/**
 * Look at the app's accessibility tree once and record whether it advertises
 * `@tapsmith/react-native` reset hooks. Cheap (one hierarchy fetch) and
 * best-effort: a failure leaves the capabilities unchanged.
 */
export async function probeResetCapabilities(
  ctx: SessionPreflightContext,
  options: { pollMs?: number } = {},
): Promise<ResetCapabilities> {
  // Mutate in place: embedders share one capabilities object between the
  // context and the runner options, so a replacement would leave the runner
  // looking at a stale copy (and never switch to per-test warm resets).
  const caps: ResetCapabilities = (ctx.capabilities ??= {});
  const deadline = Date.now() + (options.pollMs ?? HOOKS_PROBE_POLL_MS);
  let readWithoutMarker = false;
  for (;;) {
    let seen = false;
    try {
      const h = await ctx.client.getUiHierarchy();
      const marker = parseHooksMarker(h.hierarchyXml);
      seen = !!marker && marker.urlPrefix.length > 0;
      if (!seen) readWithoutMarker = true;
    } catch {
      // A failed read says nothing about the app; it neither confirms nor
      // rules out the hooks.
    }
    if (seen) {
      caps.hooksDetected = true;
      return caps;
    }
    // A session that already knows the answer has nothing to wait for. One
    // that has never seen the marker keeps looking for the budget: right
    // after a cold launch the first non-empty hierarchy can be the native
    // splash, before the React root (and the marker) has mounted, and a
    // single-shot miss there would pin every file of a sequential run to
    // clear resets with nothing to upgrade it.
    if (caps.hooksDetected !== undefined || Date.now() + HOOKS_PROBE_POLL_INTERVAL_MS > deadline) break;
    await delay(HOOKS_PROBE_POLL_INTERVAL_MS);
  }
  // Sticky: hooks compiled into the app do not vanish mid-session. A probe
  // that misses the marker (mid-transition screen, keyboard, a slow dump
  // under load) must not demote the policy from warm — that silently
  // downgraded whole files to clear resets on loaded CI runners. Only a
  // session that never saw the marker records false, and only on the
  // strength of a hierarchy it actually read: a run of failed reads leaves
  // the question open for the next probe.
  if (readWithoutMarker) caps.hooksDetected ??= false;
  return caps;
}

/** Marker poll cadence inside {@link probeResetCapabilities}. */
const HOOKS_PROBE_POLL_INTERVAL_MS = 250;
/**
 * How long a probe keeps looking for the hooks marker before concluding the
 * app has none. Only a session that has never seen the marker polls, so the
 * budget is paid once per session (per embedder process), and only by apps
 * without the hooks; an app with them answers on the first read.
 */
const HOOKS_PROBE_POLL_MS = 3_000;

export interface EnsureSessionReadyOptions {
  onRecovery?: (error: unknown) => void
  /**
   * Delay (ms) before recovery attempt N (the last entry is reused when
   * attempts exceed the list). Defaults to {@link DEFAULT_RETRY_BACKOFF_MS};
   * overridable so unit tests don't sleep for real.
   */
  retryBackoffMs?: number[]
  /**
   * Overrides for the iOS foreground probe's timing, defaulting to
   * {@link IOS_FOREGROUND_PROBE_BUDGET_MS} and
   * {@link IOS_FOREGROUND_PROBE_DEADLINE_MS}. Overridable so unit tests can
   * drive the retry ladder without burning the real budget.
   */
  iosForegroundProbe?: Partial<IosForegroundProbeTiming>
}

/**
 * Probe timing for one ladder rung of {@link ensureSessionReady}.
 *
 * A rung is clamped to a single deadline only when the previous rung already
 * spent a whole probe budget AND the `recoverSession` between them completed.
 * Nothing outside `ensureSessionReady` bounds preflight time, so without the
 * clamp a wedged agent would cost `maxAttempts x budget` (~90s) per preflight.
 *
 * Both conditions matter. A rung whose predecessor died at `ping` (probe never
 * ran) follows a terminate + launch, when `getAppState` is slowest, so it keeps
 * the full budget. A rung whose recovery THREW restarted nothing, so clamping it
 * would reintroduce the single-shot behaviour this change removes.
 */
function probeTimingForAttempt(
  clamp: boolean,
  overrides: Partial<IosForegroundProbeTiming> = {},
): Partial<IosForegroundProbeTiming> {
  if (!clamp) return overrides;
  const attemptDeadlineMs = overrides.attemptDeadlineMs ?? IOS_FOREGROUND_PROBE_DEADLINE_MS;
  return { ...overrides, budgetMs: Math.min(overrides.budgetMs ?? Infinity, attemptDeadlineMs) };
}

/** Thrown when the probe spent its whole budget without the agent answering,
 *  so the ladder can tell "already gave this agent a full budget" from "the
 *  probe never ran". */
class ProbeBudgetExhaustedError extends Error {}

/** Running total of probe time across one ladder. Each probe measures only its
 *  own run and the annotation is cleared per rung, so without this a ladder
 *  that burned 30s, recovered and then answered instantly would report
 *  `foreground probe 0.2s` and hide where the time went. */
interface ProbeLatencyTally { totalMs: number; probes: number }

/** Resolved timing for one {@link probeIosForegroundState} run. */
interface IosForegroundProbeTiming {
  /** Total wall-clock the probe may spend across attempts. */
  budgetMs: number
  /** gRPC deadline for a single attempt. */
  attemptDeadlineMs: number
  /** Pause between attempts; see {@link IOS_FOREGROUND_PROBE_RETRY_DELAY_MS}. */
  retryDelayMs: number
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
/** Time to wait for the *configured app's* nodes to appear in the Android
 *  hierarchy after a launch. Deliberately much larger than
 *  {@link HIERARCHY_READY_TIMEOUT_MS}: that one only asks UIAutomator2 for any
 *  dump at all, while this one waits for a cold RN launch to actually paint.
 *  On an oversubscribed CI runner the app process can start, run its JS bundle
 *  and still have no drawn window for tens of seconds — and a system ANR
 *  dialog from an unrelated package (Google Play services on a thrashing
 *  emulator) can own the screen for minutes before it does. This check sits
 *  outside `ensureSessionReady`'s retry envelope on the startup launch, so a
 *  single timeout kills the whole shard before one test runs; err on the side
 *  of patience, exactly as {@link IOS_APP_READY_TIMEOUT_MS} does. The poll
 *  returns the instant the app appears, so a healthy launch pays nothing.
 *
 *  NOTE: this sits INSIDE `ensureSessionReady`'s attempt loop, so a genuinely
 *  broken app costs up to DEFAULT_MAX_ATTEMPTS x this before the session is
 *  declared dead. That is the deliberate trade: a slow launch must not fail,
 *  and a broken one has a whole shard's worth of time to spare anyway. */
const ANDROID_APP_HIERARCHY_TIMEOUT_MS = 60_000;
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
/** Per-attempt gRPC deadline for the iOS foreground probe in
 *  {@link verifySession}. The XCUITest agent drains commands one at a time, so
 *  at a test boundary `getAppState` queues behind the previous test's last
 *  hierarchy dump. On a loaded macOS CI runner that alone costs 5-10s, so the
 *  old fixed 10s deadline sat right on the cliff (PILOT-350). Must stay under
 *  the daemon's own 30s agent timeout so the error we surface is ours. */
const IOS_FOREGROUND_PROBE_DEADLINE_MS = 12_000;
/** Pause between probe attempts. Must not be zero: a timeout-shaped error that
 *  rejects faster than its deadline would otherwise turn the loop into a hot
 *  spin of RPCs and stderr lines. */
const IOS_FOREGROUND_PROBE_RETRY_DELAY_MS = 500;
/** Total budget for the foreground probe across attempts. A slow-but-answering
 *  agent is not a dead one; the recovery it would otherwise trigger costs
 *  25-47s and destroys beforeAll state.
 *
 *  INVARIANT: an attempt is only admitted while a full deadline still fits, so
 *  the budget must cover `n * (DEADLINE_MS + RETRY_DELAY_MS)` plus slack for a
 *  late-firing Node timer on a pegged runner. 30s / 12s / 0.5s gives two
 *  attempts with ~5.5s of lag tolerance; trimming toward 2x the deadline
 *  silently degrades the probe back to single-shot. */
const IOS_FOREGROUND_PROBE_BUDGET_MS = 30_000;
/** Error signatures meaning "the agent did not answer in time", the only ones
 *  retried inside the budget. Transport failures (`14 UNAVAILABLE`, dropped
 *  socket) still escalate to recovery immediately, as #68 intended. A daemon
 *  that is alive but wedged also answers `DEADLINE_EXCEEDED`, so the budget
 *  bounds that case too. `Agent command timed out` is the daemon's 30s timeout,
 *  unreachable while the per-attempt deadline is shorter; kept as defence. */
const AGENT_SLOW_SIGNATURES = ['DEADLINE_EXCEEDED', 'Agent command timed out'];
const HIERARCHY_POLL_INTERVAL_MS = 500;
/** How long a cold-launched Android app gets to render its first content
 * before we proceed anyway (see {@link waitForAndroidAppReady}). */
const ANDROID_APP_READY_TIMEOUT_MS = 10_000;
const DEFAULT_SOFT_RESET_WAIT_MS = 750;
/**
 * Buttons that dismiss a system ANR/crash dialog, in the order we prefer them.
 * "Wait" before "Close app" so an app that is merely slow gets to finish
 * launching rather than being killed out from under the session.
 */
const SYSTEM_DIALOG_DISMISS_LABELS = ['Not Now', 'Wait', 'Close app', 'OK'] as const;

/** Dismissal rounds. Clearing one dialog often reveals the next (a thrashing
 *  emulator queues several), but the count is bounded so a dialog that keeps
 *  reappearing fails fast instead of spinning. */
const SYSTEM_DIALOG_DISMISS_ROUNDS = 4;


export async function ensureSessionReady(
  ctx: SessionPreflightContext,
  phase: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  options: EnsureSessionReadyOptions = {},
): Promise<void> {
  return withActionProgress('sessionReady', ctx.config.package, async (progress) => {
    let lastError: unknown;
    // Whether the recovery before THIS rung completed. Drives the probe's
    // budget clamp — see {@link probeTimingForAttempt}.
    let recovered = false;
    // Whether the previous rung's probe burned a whole budget (as opposed to
    // never running, or dying on a transport error). Together with `recovered`
    // this is what makes the clamp's premise true — see
    // {@link probeTimingForAttempt}.
    let budgetSpent = false;
    const tally: ProbeLatencyTally = { totalMs: 0, probes: 0 };
    const backoff = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Drop any annotation the previous attempt left: this attempt may fail
        // before it reaches the probe (a rejected `ping`, a disconnected
        // agent), and a stale detail would then describe the wrong attempt on
        // the end event.
        progress.setDetail(undefined);
        await verifySession(ctx, progress, probeTimingForAttempt(recovered && budgetSpent, options.iosForegroundProbe), tally);
        return;
      } catch (err) {
        lastError = err;
        budgetSpent = err instanceof ProbeBudgetExhaustedError;
        if (attempt === maxAttempts) break;
        options.onRecovery?.(err);
        // Give a transient agent-connection drop time to clear before
        // recovering — the recovery RPCs go over the same channel and an
        // immediate retry lands inside the same drop window (PILOT-282).
        await delay(backoff[attempt - 1] ?? backoff.at(-1) ?? 0);
        try {
          await recoverSession(ctx);
          recovered = true;
        } catch (recoveryErr) {
          recovered = false;
          // The recovery RPC can hit the same transient agent/ADB transport
          // blip that caused verification to fail. If the caller allowed more
          // attempts, loop back and probe the session again before giving up.
          lastError = recoveryErr;
          // The reported error is now the recovery's, not the probe's. Drop the
          // probe annotation so the end event does not read as though the probe
          // produced it (same misattribution guarded at rung start).
          progress.setDetail(undefined);
          if (attempt === maxAttempts - 1) break;
        }
      }
    }

    throw new Error(
      `${ctx.label}: session preflight failed during ${phase}: ${formatError(lastError)}`,
    );
  });
}

/**
 * Startup / recovery launch. Brings the configured app to a fresh, ready
 * state without any policy involvement:
 *  - `freshInstall`: the app was installed onto a device that did not have
 *    it, so there is no data container to clear — launch and verify only.
 *    A reinstall over an existing bundle (`adb install -r`, `simctl
 *    install`) keeps the data container and must NOT claim this.
 *  - otherwise: hard clear + relaunch (the `clear` action).
 *
 * Between-file and per-test resets are NOT this function's job any more —
 * the runner executes the declared policy via {@link executeAppReset}.
 */
export async function launchConfiguredApp(
  ctx: SessionPreflightContext,
  phase: string,
  options: { readinessAttempts?: number; freshInstall?: boolean; hooksProbeMs?: number } = {},
): Promise<PreparedState> {
  const readinessAttempts = options.readinessAttempts;
  const probe = { pollMs: options.hooksProbeMs ?? HOOKS_PROBE_POLL_MS };
  const started = Date.now();
  // Both paths leave the app in fresh-install state, i.e. they satisfy the
  // `clear` policy — the runner can skip the first file's reset. The
  // `freshInstall` path only holds that promise because the caller vouched
  // that no data container pre-existed.
  const prepared = (): PreparedState => ({
    policy: { mode: 'clear', scope: 'file' },
    preparedAt: Date.now(),
    durationMs: Date.now() - started,
    source: phase,
  });

  if (!ctx.config.package) {
    await ensureSessionReady(ctx, phase, readinessAttempts);
    return prepared();
  }

  if (options.freshInstall) {
    // Fresh install: there's no state to clear. On Android,
    // explicitly launch the app (iOS auto-launches via the XCUITest agent
    // during startAgent), then go straight to ensuring the session is ready.
    if (ctx.config.platform !== 'ios') {
      await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config));
    }
    await ensureSessionReady(ctx, phase, readinessAttempts);
    await waitForAppReady(ctx);
    await probeResetCapabilities(ctx, probe);
    return prepared();
  }

  await hardClearAndLaunch(ctx);
  await ensureSessionReady(ctx, phase, readinessAttempts);
  await waitForAppReady(ctx);
  await probeResetCapabilities(ctx, probe);
  return prepared();
}

export interface ExecuteAppResetOptions {
  /** Label for error messages / progress, e.g. "file reset for auth.test.ts". */
  phase: string
  /**
   * Force a cold (terminate + relaunch) delivery of the warm reset hook.
   * Only retries set this: the daemon owns the warm-window policy
   * (`appResetColdEvery`, warm-failure streak), so file-boundary resets no
   * longer force cold from here.
   */
  forceCold?: boolean
  /**
   * A reset that already happened (startup launch, background preparation).
   * When it satisfies `policy`, no device work runs beyond the readiness
   * check and the report says so (`origin: 'prepared'`).
   */
  prepared?: PreparedState
}

/**
 * Execute a resolved {@link AppResetPolicy} against the device. This is the
 * single implementation of "make the app satisfy policy P" — the runner
 * calls it as fixture setup, UI mode's background preparation will call it,
 * and it always ends with a session readiness check.
 *
 * Never throws for a *fallback* (warm → clear); throws when the device
 * cannot be brought to a ready state at all, with `steps` in the report up
 * to the failing one attached to the error as `report`.
 */
export async function executeAppReset(
  ctx: SessionPreflightContext,
  policy: AppResetPolicy,
  options: ExecuteAppResetOptions,
): Promise<AppResetReport> {
  const started = Date.now();
  const steps: AppResetStep[] = [];
  const step = async (name: string, fn: () => Promise<void>, detail?: string): Promise<void> => {
    const t0 = Date.now();
    try {
      await fn();
      steps.push({ name, durationMs: Date.now() - t0, ok: true, ...(detail ? { detail } : {}) });
    } catch (err) {
      steps.push({ name, durationMs: Date.now() - t0, ok: false, detail: formatError(err) });
      throw err;
    }
  };
  const finish = (partial: Omit<AppResetReport, 'policy' | 'durationMs' | 'steps'>): AppResetReport => ({
    policy,
    durationMs: Date.now() - started,
    steps,
    ...partial,
  });

  const action = appResetAction(policy);

  if (!ctx.config.package) {
    await step('ensureSessionReady', () => ensureSessionReady(ctx, options.phase));
    return finish({ origin: 'skipped', modeUsed: 'none', fellBack: false, reason: 'no package configured' });
  }

  if (options.prepared && satisfies(options.prepared.policy, policy)) {
    await step('ensureSessionReady', () => ensureSessionReady(ctx, options.phase));
    const when = new Date(options.prepared.preparedAt).toLocaleTimeString();
    return finish({
      origin: 'prepared',
      modeUsed: action.kind,
      fellBack: false,
      satisfiedBy: options.prepared,
      reason: options.prepared.durationMs > 0
        ? `satisfied by ${options.prepared.source} at ${when} (took ${formatSeconds(options.prepared.durationMs)})`
        : `satisfied by ${options.prepared.source} at ${when}`,
    });
  }

  if (action.kind === 'none') {
    await step('ensureSessionReady', () => ensureSessionReady(ctx, options.phase));
    return finish({ origin: 'skipped', modeUsed: 'none', fellBack: false, reason: 'appReset: none' });
  }

  const pkg = ctx.config.package;
  let modeUsed: AppResetReport['modeUsed'] = action.kind;
  let fellBack = false;
  let reason: string | undefined;
  let processRecreated = true;

  if (action.kind === 'restore') {
    await step('restoreAppState', () => ctx.device.restoreAppState(pkg, action.archive));
    await step('restartApp', () => ctx.device.restartApp(pkg));
  } else {
    // warm / restart / clear run the daemon's ladder: it knows whether the app
    // advertises in-app reset hooks, owns the warm-window cold policy, and
    // reports exactly which rung ran so the trace stays honest.
    let result: Awaited<ReturnType<SessionDevice['_resetApp']>> | undefined;
    await step('resetApp', async () => {
      result = await ctx.device._resetApp(pkg, {
        mode: action.kind,
        fallback: true,
        resetDeepLink: ctx.config.resetAppDeepLink,
        forceCold: options.forceCold,
        coldEveryNResets: ctx.config.appResetColdEvery ?? DEFAULT_APP_RESET_COLD_EVERY,
        // Fixture setup: the pre-reset screen is the previous test's leftover
        // state, not evidence for this test — skip the before-capture that
        // every traced action otherwise pays (screenshot + hierarchy dump).
        skipTraceCapture: true,
        // A declared warm policy promises state-clearing; when warm cannot
        // run (or land), a restart keeps persisted data and does not deliver
        // it — fall to clear. Explicit device.resetApp() calls keep the
        // gentler restart fallback.
        fallbackToClear: action.kind === 'warm',
      });
      for (const s of result.steps) {
        steps.push({ name: s.name, durationMs: s.durationMs, ok: s.ok, ...(s.detail ? { detail: s.detail } : {}) });
      }
    });
    if (result) {
      modeUsed = result.modeUsed;
      fellBack = result.fellBack;
      reason = result.reason;
      processRecreated = result.modeUsed !== 'warm' || result.coldLaunch;
      // The daemon seeing the marker is fresh proof of hooks. The reverse is
      // not: a missed read under load plans a fallback without disproving the
      // hooks, so detection only ever upgrades (sticky, like the probe).
      if (action.kind === 'warm' && result.hooksDetected) (ctx.capabilities ??= {}).hooksDetected = true;
      if (result.fellBack) {
        process.stderr.write(`[tapsmith] App reset fell back to ${result.modeUsed}: ${result.reason ?? 'unknown reason'}\n`);
      }
      if (result.modeUsed === 'warm' && !result.hooksDetected) {
        // Legacy deep-link hook: no acknowledgement, so give the app the
        // configured settle time as before.
        const waitMs = ctx.config.resetAppWaitMs ?? DEFAULT_SOFT_RESET_WAIT_MS;
        await step('settle', async () => {
          try {
            await ctx.device.waitForIdle(waitMs);
          } catch {
            await delay(waitMs);
          }
        });
      }
    }
  }

  await step('ensureSessionReady', () => ensureSessionReady(ctx, options.phase));
  if (processRecreated || ctx.config.platform === 'ios') {
    // A relaunched process is "ready" only once the app has drawn something:
    // the session check above is satisfied by a bare Activity/splash window,
    // and a deep link or hooks probe fired into a still-booting React Native
    // app is silently lost. An acknowledged warm reset needs none of this —
    // the marker epoch is the proof of rendering.
    await step('waitForAppReady', () => waitForAppReady(ctx));
  }
  if (
    action.kind !== 'warm'
    && (ctx.config.appReset ?? 'auto') === 'auto'
    && ctx.capabilities?.hooksDetected === false
  ) {
    // `auto` resolved to clear because the session-level probe never saw the
    // marker (the app may have taken longer than its budget to mount). The
    // app is freshly relaunched and rendering now: one read here is the
    // upgrade path — the next scope resolves warm. A hookless app pays one
    // hierarchy read per clear reset; a hooked one upgrades on the first.
    await probeResetCapabilities(ctx, { pollMs: 0 });
  }
  return finish({ origin: 'inline', modeUsed, fellBack, ...(reason ? { reason } : {}) });
}

type StepRunner = (name: string, fn: () => Promise<void>, detail?: string) => Promise<void>;
const runDirect: StepRunner = (_name, fn) => fn();

/**
 * The `clear` action: wipe app data and cold-launch. Does NOT include the
 * final readiness check — callers add `ensureSessionReady` (+ iOS ready wait).
 */
async function hardClearAndLaunch(ctx: SessionPreflightContext, step: StepRunner = runDirect): Promise<void> {
  const pkg = ctx.config.package!;

  if (ctx.config.platform === 'ios') {
    // On iOS, clear data then restart for isolation.
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
    await step('clearAppData', () => ctx.device.clearAppData(pkg));
    try {
      await step('restartApp', () => ctx.device.restartApp(pkg));
    } catch (err) {
      // restartApp can fail on iOS if the agent session is stale after
      // clearAppData. The app will be relaunched by ensureSessionReady's
      // recovery path, or by the test's own beforeAll/beforeEach. Surface
      // the error to stderr so a real app crash here is debuggable rather
      // than silently masked until the next test fails for an unrelated
      // reason.
      process.stderr.write(`[tapsmith] iOS restartApp after clear failed (will recover): ${formatError(err)}\n`);
    }
    return;
  }

  // Android uses separate terminate → clear → launch steps. Unlike iOS,
  // Android's terminateApp reliably kills the process before clearAppData
  // runs, and launchApp doesn't race with a dying process. iOS must use
  // the atomic restartApp path (above) to avoid reconnecting to a stale
  // process that's mid-teardown after clearAppData.
  try {
    await step('terminateApp', () => ctx.device.terminateApp(pkg));
  } catch {
    // App may not be running yet
  }

  // Clear app data before launching to ensure proper isolation. Without
  // this, state from a previous file (e.g. auth tokens in AsyncStorage)
  // leaks into the next file. Scopes that need persisted state declare
  // test.use({ appState }) which restores instead of clearing.
  await step('clearAppData', () => ctx.device.clearAppData(pkg));

  // Restart the agent BEFORE launching the app. The terminate + clearAppData
  // sequence above kills the agent process. If we launch the app first and
  // then let ensureSessionReady discover the dead agent, its recoverSession
  // path does a redundant terminateApp + launchApp cycle that can restore
  // the Activity's saved instance state Bundle (e.g. React Navigation route).
  // Best-effort: if the agent restart fails here (e.g. missing APK),
  // ensureSessionReady's recovery path will retry with a clearer error.
  try {
    await step('startAgent', () => ctx.device.startAgent(
      pkg, ctx.agentApkPath, ctx.agentTestApkPath, ctx.iosXctestrunPath, ctx.iosAppPath,
      ctx.networkTracingEnabled ?? false,
    ));
  } catch {
    // Will be recovered by ensureSessionReady below
  }

  await step('launchApp', () => ctx.device.launchApp(pkg, launchOptions(ctx.config)));
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function isAgentSlowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return AGENT_SLOW_SIGNATURES.some((sig) => message.includes(sig));
}

/**
 * Ask the iOS agent whether `pkg` is in the foreground, tolerating a
 * slow-but-alive agent (PILOT-350).
 *
 * `ping` has already confirmed the daemon holds an agent connection; this is a
 * *state* query that queues behind whatever the agent is still finishing from
 * the previous test. Keep asking for the whole budget instead of treating the
 * first missed deadline as a dead session.
 *
 * The agent drains one FIFO (`SocketServer.swift`) and an abandoned command
 * still runs to completion, so a retry never answers *earlier* than one wide
 * deadline would. What it adds is a fresh daemon-side stream, which is what
 * recovers a stale cached socket. Headroom against a busy agent comes from the
 * budget, not the attempt count.
 *
 * Reports its latency through `progress` so slow-runner drift is visible on
 * the "App ready" line before it crosses the budget.
 */
async function probeIosForegroundState(
  ctx: SessionPreflightContext,
  pkg: string,
  progress?: ActionProgressHandle,
  timing: Partial<IosForegroundProbeTiming> = {},
  tally: ProbeLatencyTally = { totalMs: 0, probes: 0 },
): Promise<AppState> {
  const budgetMs = timing.budgetMs ?? IOS_FOREGROUND_PROBE_BUDGET_MS;
  const attemptDeadlineMs = timing.attemptDeadlineMs ?? IOS_FOREGROUND_PROBE_DEADLINE_MS;
  const retryDelayMs = timing.retryDelayMs ?? IOS_FOREGROUND_PROBE_RETRY_DELAY_MS;
  const started = Date.now();
  let attempts = 0;
  let lastError: unknown;

  const report = (): void => {
    const elapsed = Date.now() - started;
    tally.totalMs += elapsed;
    tally.probes += 1;
    const suffix = attempts > 1 ? ` after ${attempts} attempts` : '';
    const across = tally.probes > 1
      ? ` (${formatSeconds(tally.totalMs)} across ${tally.probes} probes)`
      : '';
    progress?.setDetail(`foreground probe ${formatSeconds(elapsed)}${suffix}${across}`);
  };

  let exhausted = true;
  let effectiveDeadlineMs = attemptDeadlineMs;
  for (;;) {
    const remaining = budgetMs - (Date.now() - started);
    // Only start an attempt that can run to a full deadline: a sliver at the
    // end of the budget cannot tell a slow agent from a dead one, and its
    // "Deadline exceeded after 1.0s" would replace the real timeout as the
    // reported error. The first attempt is exempt so a tiny budget still asks
    // once; its deadline is clamped to the budget and reported as used.
    if (attempts > 0 && remaining < attemptDeadlineMs) break;
    attempts++;
    effectiveDeadlineMs = Math.max(1, Math.min(attemptDeadlineMs, remaining));
    try {
      const state = await ctx.device.getAppState(pkg, { timeout: effectiveDeadlineMs });
      report();
      return state;
    } catch (err) {
      lastError = err;
      // A transport-level failure means the session really is broken — throw
      // now rather than spending the rest of the budget on it.
      if (!isAgentSlowError(err)) {
        exhausted = false;
        break;
      }
      process.stderr.write(
        `[tapsmith] iOS foreground probe slow (attempt ${attempts}, ${formatSeconds(Date.now() - started)} elapsed): ${formatError(err)}\n`,
      );
      // Decide pacing and admission together: the loop-top check runs after
      // the delay, so the delay must be counted here or it either burns as a
      // hot spin or consumes the attempt it was pacing for.
      if (budgetMs - (Date.now() - started) < attemptDeadlineMs + retryDelayMs) break;
      await delay(retryDelayMs);
    }
  }

  if (!exhausted) {
    // A dropped socket is not probe latency; leave the progress line unannotated.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  report();
  // Name the budget, not just the last attempt's deadline. The original message
  // stays embedded so `isRecoverableInfrastructureError` still matches on it.
  throw new ProbeBudgetExhaustedError(
    `iOS foreground probe gave up after ${formatSeconds(Date.now() - started)}`
    + ` (${attempts} attempt${attempts === 1 ? '' : 's'},`
    + ` ${formatSeconds(effectiveDeadlineMs)} deadline each, ${formatSeconds(budgetMs)} budget):`
    + ` ${formatError(lastError)}`,
  );
}

async function verifySession(
  ctx: SessionPreflightContext,
  progress?: ActionProgressHandle,
  iosForegroundProbe?: Partial<IosForegroundProbeTiming>,
  tally?: ProbeLatencyTally,
): Promise<void> {
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
      let state: AppState;
      try {
        state = await probeIosForegroundState(ctx, ctx.config.package, progress, iosForegroundProbe, tally);
      } catch (err) {
        // A socket disconnect, or nothing answering for the whole budget, means
        // the session is broken. Throw so ensureSessionReady decides whether to
        // recover; this line must not promise a recovery that may not happen.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[tapsmith] iOS foreground probe failed: ${message}\n`);
        throw err;
      }
      if (state !== 'foreground') {
        try {
          await ctx.device.launchApp(ctx.config.package);
        } catch (err) {
          // The probe answered; the relaunch is what broke. Drop the probe
          // annotation so triage is not pointed at the deadline constant.
          progress?.setDetail(undefined);
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[tapsmith] iOS app was '${state}', relaunch failed: ${message}\n`);
          throw err;
        }
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
        // Not an infra failure by itself: a previous test may have
        // intentionally terminated or backgrounded the app (the
        // device-management tests do exactly that). Relaunch cheaply inline —
        // mirroring the iOS branch above — instead of throwing, which would
        // classify this routine state as a session recovery and (since
        // recovery destroys beforeAll-established state) escalate to a
        // whole-file retry. A genuinely broken session fails the relaunch or
        // the readiness wait below, and THAT propagates into real recovery.
        await ctx.device.launchApp(ctx.config.package);
        const relaunched = await waitForHierarchy(ctx.client);
        await waitForAndroidAppHierarchy(ctx, relaunched.hierarchyXml, ctx.config.package);
        return;
      }
      await ctx.device.pressBack();
      await ctx.device.waitForIdle(DEFAULT_READY_TIMEOUT_MS);
    } else {
      await waitForAndroidAppHierarchy(ctx, hierarchy.hierarchyXml, ctx.config.package);
    }
  }
}

/**
 * Wait for a (re)launched app to have rendered its first content. Platform
 * dispatch: iOS polls for a non-empty hierarchy ({@link waitForIosAppReady});
 * Android polls for rendered content ({@link waitForAndroidAppReady}).
 */
async function waitForAppReady(ctx: SessionPreflightContext): Promise<void> {
  if (ctx.config.platform === 'ios') return waitForIosAppReady(ctx);
  return waitForAndroidAppReady(ctx);
}

/**
 * True when the Android hierarchy has at least one node of `packageName`
 * carrying text or a content description — i.e. the app has drawn real UI,
 * not just its Activity/splash window. Exported for tests.
 */
export function androidHierarchyHasRenderedContent(hierarchyXml: string, packageName: string): boolean {
  const nodeRe = /<node\b[^>]*>/g;
  const pkgAttr = `package="${packageName}"`;
  for (const match of hierarchyXml.matchAll(nodeRe)) {
    const node = match[0];
    if (!node.includes(pkgAttr)) continue;
    if (/\btext="[^"]+"/.test(node) || /\bcontent-desc="[^"]+"/.test(node)) return true;
  }
  return false;
}

/**
 * After a cold launch on Android, `ensureSessionReady` returns as soon as
 * the app's window exists — for a React Native app that is the splash,
 * seconds before the JS bundle has rendered anything. Anything sent to the
 * app in that window (a deep link, the hooks-marker probe) is lost. Poll for
 * rendered content, bounded; a first screen with no text at all simply falls
 * through after the timeout — the tests' own auto-waiting takes over.
 */
async function waitForAndroidAppReady(ctx: SessionPreflightContext): Promise<void> {
  const pkg = ctx.config.package;
  if (!pkg) return;
  const start = Date.now();
  while (true) {
    try {
      const h = await ctx.client.getUiHierarchy(IOS_APP_READY_POLL_DEADLINE_MS);
      if (androidHierarchyHasRenderedContent(h.hierarchyXml ?? '', pkg)) return;
    } catch {
      // Agent may still be settling after the relaunch — keep polling.
    }
    if (Date.now() - start >= ANDROID_APP_READY_TIMEOUT_MS) {
      process.stderr.write(
        `[tapsmith] ${pkg} showed no rendered content ${ANDROID_APP_READY_TIMEOUT_MS}ms after launch; continuing\n`,
      );
      return;
    }
    await delay(HIERARCHY_POLL_INTERVAL_MS);
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

  const deadline = Date.now() + ANDROID_APP_HIERARCHY_TIMEOUT_MS;
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

  throw new Error(
    `Android app hierarchy for ${packageName} not ready ` +
    `${ANDROID_APP_HIERARCHY_TIMEOUT_MS}ms after launch; ` +
    `last hierarchy ${describeHierarchyForDiagnostics(hierarchyXml)}`,
  );
}

/**
 * One-line description of what the hierarchy actually held, for the timeout
 * message. Without it "hierarchy not ready" is the same sentence whether the
 * app crashed, a system ANR dialog owned the screen, or UIAutomator2 returned
 * nothing at all — three very different causes that each cost an hour of
 * logcat archaeology to tell apart.
 */
export function describeHierarchyForDiagnostics(hierarchyXml: string): string {
  const trimmed = hierarchyXml.trim();
  if (!trimmed) return 'was empty (UIAutomator2 returned nothing)';
  // A dump with no nodes at all: the app is mid-launch with no drawn window,
  // or the window list is genuinely empty. Distinct from "returned nothing".
  if (!trimmed.includes('<node')) return 'held no windows (app has not drawn yet)';

  const packages = [...new Set(
    [...trimmed.matchAll(/\bpackage="([^"]+)"/g)].map((m) => m[1]),
  )];
  const shown = packages.slice(0, 3).join(', ') || 'no package attributes';
  const more = packages.length > 3 ? ` (+${packages.length - 3} more)` : '';

  const title = androidAlertTitle(trimmed);
  return title
    ? `showed the system dialog "${title}" (packages: ${shown}${more})`
    : `showed packages: ${shown}${more}`;
}

/** Text of the `android:id/alertTitle` node, whichever order the attributes
 *  appear in. Both bounded to a single tag by `[^>]`. */
function androidAlertTitle(hierarchyXml: string): string | undefined {
  const ALERT_ID = 'resource-id="android:id/alertTitle"';
  for (const re of [
    new RegExp(`\\btext="([^"]+)"[^>]*${ALERT_ID}`),
    new RegExp(`${ALERT_ID}[^>]*\\btext="([^"]+)"`),
  ]) {
    const match = hierarchyXml.match(re);
    if (match?.[1]) return match[1];
  }
  return undefined;
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

async function dismissBlockingSystemUi(ctx: SessionPreflightContext): Promise<void> {
  let hierarchy = '';
  try {
    hierarchy = (await ctx.client.getUiHierarchy()).hierarchyXml;
  } catch {
    return;
  }

  if (!detectBlockingSystemDialog(hierarchy)) return;

  for (let round = 0; round < SYSTEM_DIALOG_DISMISS_ROUNDS; round++) {
    // Only tap a label the dump we are holding actually shows. Tapping blind
    // costs a full auto-wait timeout PER ABSENT LABEL — on a loaded emulator
    // that was ~30s of the preflight budget spent waiting for buttons that
    // were never going to appear, on exactly the runs least able to spare it.
    const label = SYSTEM_DIALOG_DISMISS_LABELS.find((l) => androidHierarchyHasText(hierarchy, l));
    if (!label) break;

    try {
      await ctx.device.getByText(label, { exact: true }).tap();
      await ctx.device.waitForIdle(1_000);
    } catch {
      // The dialog may have gone on its own between the dump and the tap.
      break;
    }

    try {
      hierarchy = (await ctx.client.getUiHierarchy()).hierarchyXml;
    } catch {
      return;
    }
    if (!detectBlockingSystemDialog(hierarchy)) return;
  }

  try {
    await ctx.device.pressBack();
    await ctx.device.waitForIdle(1_000);
  } catch {
    // Best effort
  }
}

/**
 * True when the hierarchy has a node whose `text` is exactly `text`. Matches
 * what `getByText(text, { exact: true })` resolves, so it is a safe guard
 * against blind taps. Exported for tests.
 */
export function androidHierarchyHasText(hierarchyXml: string, text: string): boolean {
  return hierarchyXml.includes(`text="${escapeXmlAttribute(text)}"`);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
