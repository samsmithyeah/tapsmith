import { describe, expect, it, vi } from 'vitest';
import { androidHierarchyHasRenderedContent, ensureSessionReady, executeAppReset, launchConfiguredApp, probeResetCapabilities } from '../session-preflight.js';
import type { AppResetPolicy } from '../app-reset.js';
import { onActionProgress, type ActionProgressEvent } from '../action-progress.js';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';

function makeContext(overrides: Partial<Parameters<typeof ensureSessionReady>[0]> = {}) {
  const device = {
    startAgent: vi.fn(async () => undefined),
    terminateApp: vi.fn(async () => undefined),
    launchApp: vi.fn(async () => undefined),
    openDeepLink: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    currentPackage: vi.fn(async () => 'com.example.app'),
    getByText: vi.fn(() => ({ tap: vi.fn(async () => undefined) }) as never),
    pressBack: vi.fn(async () => undefined),
    clearAppData: vi.fn(async () => undefined),
    restoreAppState: vi.fn(async () => undefined),
    restartApp: vi.fn(async () => undefined),
    getAppState: vi.fn(async () => 'foreground' as const),
    _resetApp: vi.fn(async (_pkg: string, opts: { mode?: 'warm' | 'restart' | 'clear' }) => resetResult(opts.mode ?? 'warm')),
  };

  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
      errorMessage: '',
    })),
  };

  return {
    label: 'Worker 0 (emulator-5554)',
    config: { package: 'com.example.app', activity: '.MainActivity' },
    device,
    client,
    ...overrides,
  };
}

const iosHierarchy = { requestId: '1', hierarchyXml: '<hierarchy><node /></hierarchy>', errorMessage: '' };

/** A daemon ResetApp outcome as Device._resetApp reports it. */
function resetResult(
  mode: 'warm' | 'restart' | 'clear',
  overrides: Partial<import('../device.js').AppResetResult> = {},
): import('../device.js').AppResetResult {
  return {
    modeRequested: mode,
    modeUsed: mode,
    fellBack: false,
    coldLaunch: mode !== 'warm',
    durationMs: 120,
    hooksDetected: false,
    steps: [{ name: mode === 'warm' ? 'warm-deep-link' : mode, durationMs: 120, ok: true }],
    ...overrides,
  };
}
const CLEAR_FILE: AppResetPolicy = { mode: 'clear', scope: 'file' };
const WARM_FILE: AppResetPolicy = { mode: 'warm', scope: 'file' };
const WARM_TEST: AppResetPolicy = { mode: 'warm', scope: 'test' };

describe('session-preflight', () => {
  it('accepts a healthy session', async () => {
    const ctx = makeContext();
    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();
    expect(ctx.client.ping).toHaveBeenCalledTimes(1);
    expect(ctx.device.waitForIdle).toHaveBeenCalledWith(5_000);
  });

  it('emits sessionReady progress events around the readiness check (PILOT-232)', async () => {
    const events: ActionProgressEvent[] = [];
    const unsubscribe = onActionProgress((ev) => events.push(ev));
    try {
      await ensureSessionReady(makeContext(), 'startup');
      expect(events.map((e) => `${e.kind}:${e.action}`)).toEqual(['start:sessionReady', 'end:sessionReady']);
      expect(events[0].target).toBe('com.example.app');
      expect(events[1].success).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('restarts the session once when the agent is disconnected', async () => {
    const ctx = makeContext();
    const onRecovery = vi.fn();
    vi.mocked(ctx.client.ping)
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: false })
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });

    await expect(ensureSessionReady(ctx, 'startup', undefined, { onRecovery })).resolves.toBeUndefined();

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
  });

  it('continues when recovery itself hits a transient transport error', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.ping)
      .mockRejectedValueOnce(new Error('Agent connection dropped (empty response); reconnecting'))
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });
    vi.mocked(ctx.device.startAgent)
      .mockRejectedValueOnce(new Error('Failed to connect to agent socket'));

    await expect(ensureSessionReady(ctx, 'startup', 3, { retryBackoffMs: [0] })).resolves.toBeUndefined();

    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.client.ping).toHaveBeenCalledTimes(2);
  });

  it('recovers on the third attempt when a transient drop outlasts the first recovery (PILOT-282)', async () => {
    // A transient agent-connection drop lasts a few seconds: the first verify
    // AND the verify after the first recovery both land inside the drop
    // window. The default attempt budget must ride it out instead of failing
    // the test at 0ms while an interactive session recovers moments later.
    const ctx = makeContext();
    vi.mocked(ctx.client.ping)
      .mockRejectedValueOnce(new Error('Agent connection lost during read'))
      .mockRejectedValueOnce(new Error('Agent connection lost during read'))
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });

    await expect(
      ensureSessionReady(ctx, 'before test', undefined, { retryBackoffMs: [0] }),
    ).resolves.toBeUndefined();

    expect(ctx.client.ping).toHaveBeenCalledTimes(3);
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(2);
  });

  it('relaunches inline when another app is in the foreground — not a recovery', async () => {
    // A previous test may have intentionally terminated or backgrounded the
    // app, so a foreign foreground package must relaunch cheaply WITHOUT
    // signalling session recovery (recovery escalates to a whole-file retry).
    const ctx = makeContext();
    const onRecovery = vi.fn();
    vi.mocked(ctx.device.currentPackage).mockResolvedValue('com.other.app');
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.other.app" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '2',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'before test', undefined, { onRecovery })).resolves.toBeUndefined();

    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app');
    expect(onRecovery).not.toHaveBeenCalled();
    expect(ctx.device.startAgent).not.toHaveBeenCalled();
  });

  it('startup launch clears + launches and reports a `clear` prepared state', async () => {
    const ctx = makeContext();

    const prepared = await launchConfiguredApp(ctx, 'startup launch', { hooksProbeMs: 0 });

    expect(ctx.device.terminateApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
    expect(prepared).toMatchObject({ policy: { mode: 'clear', scope: 'file' }, source: 'startup launch' });
  });

  it('startup launch after a fresh install only launches (nothing to clear)', async () => {
    const ctx = makeContext();

    const prepared = await launchConfiguredApp(ctx, 'worker startup launch', { freshInstall: true, hooksProbeMs: 0 });

    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
    expect(prepared.policy).toEqual({ mode: 'clear', scope: 'file' });
  });
  it('restore policy never clears app data (appState restore owns isolation)', async () => {
    // Regression: a scope that restores a non-empty appState must NOT pm-clear
    // first. On Android pm clear wipes the AndroidKeyStore keys that decrypt
    // saved credentials (device-bound, not in the archive), so the app would
    // come back signed out after the restore.
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { ...CLEAR_FILE, appState: '/abs/auth.tar.gz' }, { phase: 'file reset' });

    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.restoreAppState).toHaveBeenCalledWith('com.example.app', '/abs/auth.tar.gz');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'restore', fellBack: false });
    expect(report.steps.map((s) => s.name)).toEqual(['restoreAppState', 'restartApp', 'ensureSessionReady', 'waitForAppReady']);
  });

  it('appState "" means clear', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'file', appState: '' }, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
    expect(ctx.device.restoreAppState).not.toHaveBeenCalled();
    expect(report.modeUsed).toBe('clear');
  });
  it('restart policy asks the daemon for a restart and passes the policy inputs through', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: '.MainActivity', resetAppDeepLink: 'app:///__reset', appResetColdEvery: 4 },
    });

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'test' }, { phase: 'before test', forceCold: true });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', {
      mode: 'restart',
      fallback: true,
      resetDeepLink: 'app:///__reset',
      forceCold: true,
      coldEveryNResets: 4,
      skipTraceCapture: true,
      fallbackToClear: false,
    });
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'restart', fellBack: false });
    expect(report.steps.map((s) => s.name)).toEqual(['restart', 'resetApp', 'ensureSessionReady', 'waitForAppReady']);
  });

  it('defaults the cold valve to 10 resets', async () => {
    const ctx = makeContext();

    await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ coldEveryNResets: 10, forceCold: undefined }));
  });
  it('none policy only verifies the session', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { mode: 'none', scope: 'file' }, { phase: 'file reset' });

    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
    expect(ctx.client.ping).toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'skipped', modeUsed: 'none', reason: 'appReset: none' });
  });

  it('a prepared device that satisfies the policy skips the reset', async () => {
    const ctx = makeContext();
    const prepared = { policy: CLEAR_FILE, preparedAt: Date.now(), durationMs: 9_800, source: 'startup launch' };

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'file' }, { phase: 'file reset', prepared });

    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.client.ping).toHaveBeenCalled();
    expect(report.origin).toBe('prepared');
    expect(report.reason).toMatch(/satisfied by startup launch at .* \(took 9\.8s\)/);
  });

  it('a prepared device that does not satisfy the policy is ignored', async () => {
    const ctx = makeContext();
    const prepared = { policy: { mode: 'restart' as const, scope: 'file' as const }, preparedAt: Date.now(), durationMs: 1, source: 'x' };

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset', prepared });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
    expect(report.origin).toBe('inline');
  });

  it('surfaces a daemon fallback in the report and on stderr', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', {
      modeUsed: 'restart',
      fellBack: true,
      coldLaunch: true,
      reason: 'warm reset requested but the app exposes no reset hook (@tapsmith/react-native or resetAppDeepLink); restarted instead',
      steps: [{ name: 'restart', durationMs: 90, ok: true }],
    }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(report).toMatchObject({ modeUsed: 'restart', fellBack: true });
      expect(report.reason).toMatch(/no reset hook/);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('App reset fell back to restart'));
    } finally {
      stderr.mockRestore();
    }
  });

  it('a warm policy asks the daemon to fall back to clear, not restart', async () => {
    // The declared policy's promise is state-clearing; a restart keeps
    // persisted data. Explicit device.resetApp() calls are unaffected — this
    // flag is set only on the runner's policy path.
    const ctx = makeContext();
    await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });
    expect(ctx.device._resetApp).toHaveBeenCalledWith(
      'com.example.app',
      expect.objectContaining({ mode: 'warm', fallbackToClear: true }),
    );

    await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });
    expect(ctx.device._resetApp).toHaveBeenLastCalledWith(
      'com.example.app',
      expect.objectContaining({ mode: 'clear', fallbackToClear: false }),
    );
  });
  it('propagates a daemon reset failure', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device._resetApp).mockRejectedValueOnce(new Error('App reset failed: RESET_FAILED'));

    await expect(executeAppReset(ctx, { mode: 'restart', scope: 'file' }, { phase: 'file reset' })).rejects.toThrow('RESET_FAILED');
  });
  it('still validates sessions without a configured package', async () => {
    const ctx = makeContext({
      config: { package: undefined, activity: undefined },
    });

    await expect(launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 })).resolves.toMatchObject({ policy: CLEAR_FILE });
    expect(ctx.device.launchApp).not.toHaveBeenCalled();

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });
    expect(report).toMatchObject({ origin: 'skipped', reason: 'no package configured' });
  });
  it('warm via the legacy deep link settles for resetAppWaitMs after the daemon returns', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
        resetAppWaitMs: 321,
      },
    });

    const report = await executeAppReset(ctx, WARM_FILE, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'warm', resetDeepLink: 'example:///__reset' }));
    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 321);
    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'warm', fellBack: false });
    expect(report.steps.map((s) => s.name)).toEqual(['warm-deep-link', 'resetApp', 'settle', 'ensureSessionReady', 'waitForAppReady']);
  });

  describe('Android app readiness after a cold launch', () => {
    const splash = { requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" class="android.widget.FrameLayout" text="" content-desc="" /></hierarchy>', errorMessage: '' };
    const rendered = { requestId: '2', hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>', errorMessage: '' };

    it('androidHierarchyHasRenderedContent needs text or a content description from the app itself', () => {
      expect(androidHierarchyHasRenderedContent(splash.hierarchyXml, 'com.example.app')).toBe(false);
      expect(androidHierarchyHasRenderedContent(rendered.hierarchyXml, 'com.example.app')).toBe(true);
      expect(androidHierarchyHasRenderedContent('<hierarchy><node package="com.example.app" content-desc="Menu" /></hierarchy>', 'com.example.app')).toBe(true);
      // System UI text does not count: the app has not drawn anything yet.
      expect(androidHierarchyHasRenderedContent('<hierarchy><node package="com.android.systemui" text="10:06" /><node package="com.example.app" /></hierarchy>', 'com.example.app')).toBe(false);
    });

    it('a clear reset polls until the app has rendered content (regression: deep link lost into a booting RN app)', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      // ensureSessionReady's own fetch sees the window; the readiness wait then
      // sees the splash twice before the JS bundle renders.
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(rendered);

      const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(report.steps.map((s) => s.name)).toEqual(['clear', 'resetApp', 'ensureSessionReady', 'waitForAppReady']);
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(4);
    });

    it('an acknowledged warm reset does not poll for content (the epoch proves rendering)', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 3, epochAfter: 4 }));

      const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(report.steps.map((s) => s.name)).not.toContain('waitForAppReady');
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(1);
    });

    it('a warm reset the daemon delivered cold waits like a relaunch', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, coldLaunch: true }));

      const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(report.steps.map((s) => s.name)).toContain('waitForAppReady');
    });

    it('startup launch waits for rendered content before probing for hooks', async () => {
      const ctx = makeContext({ config: { package: 'com.example.app', activity: undefined, platform: 'android' } });
      const marker = { requestId: '3', hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;boot=abc;url=app:///" /></hierarchy>', errorMessage: '' };
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(splash)
        .mockResolvedValueOnce(marker)
        .mockResolvedValue(marker);

      await launchConfiguredApp(ctx, 'startup', { freshInstall: true, hooksProbeMs: 0 });

      expect((ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities?.hooksDetected).toBe(true);
    });
  });

  it('warm via in-app hooks needs no settle wait (the epoch is the ack)', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'android' },
    });
    vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 3, epochAfter: 4 }));

    const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

    expect(report.steps.map((s) => s.name)).not.toContain('settle');
    // ensureSessionReady's own idle wait is the only one.
    expect(ctx.device.waitForIdle).toHaveBeenCalledTimes(1);
  });
  it('dismisses system overlay via pressBack when app is underneath', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device.currentPackage).mockResolvedValue('com.google.android.apps.nexuslauncher');
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<node package="com.example.app" /><node package="com.google.android.apps.nexuslauncher" />',
      errorMessage: '',
    });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();
    expect(ctx.device.pressBack).toHaveBeenCalled();
    expect(ctx.device.startAgent).not.toHaveBeenCalled();
  });

  it('escalates to recovery when the inline relaunch itself fails', async () => {
    const ctx = makeContext();
    const onRecovery = vi.fn();
    vi.mocked(ctx.device.currentPackage)
      .mockResolvedValueOnce('com.google.android.apps.nexuslauncher')
      .mockResolvedValue('com.example.app');
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.google.android.apps.nexuslauncher" /></hierarchy>',
      errorMessage: '',
    });
    // First launch attempt (the inline relaunch) fails — a genuinely broken
    // session; the second (recoverSession's) succeeds.
    vi.mocked(ctx.device.launchApp)
      .mockRejectedValueOnce(new Error('launch failed: agent dead'))
      .mockResolvedValue(undefined);

    await expect(
      ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] }),
    ).resolves.toBeUndefined();

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
  });

  it('waits for the Android app hierarchy after a cold launch splash', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.android.systemui" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '2',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();

    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
  });

  it('dismisses Android notification shade overlays before waiting for the app hierarchy', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.android.systemui" resource-id="com.android.systemui:id/notification_panel" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '2',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();

    expect(ctx.device.pressBack).toHaveBeenCalledTimes(1);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
  });

  describe('iOS foreground probe tolerates a slow agent (PILOT-350)', () => {
    const deadline = () => new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 12.001s,remote_addr=127.0.0.1:50051');

    function iosContext() {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
      });
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);
      return ctx;
    }

    /**
     * Drive the probe on a clock that simulates each attempt burning its own
     * deadline (plus `lagMs`) WITHOUT sleeping for it, while still advancing
     * with real time so the probe's own `delay()` pacing is charged to the
     * budget exactly as it is in production.
     *
     * Simulating the deadline keeps attempt counts exact — they do not depend
     * on how late a real `setTimeout` fires on a loaded runner — and tracking
     * real time keeps the retry delay a live part of the budget arithmetic, so
     * a test on the shipped constants fails if the delay grows past its slack.
     */
    function withFakeClock(ctx: ReturnType<typeof iosContext>, lagMs = 0) {
      const origin = performance.now();
      const base = 1_000_000;
      let simulated = 0;
      const spy = vi.spyOn(Date, 'now').mockImplementation(
        () => base + (performance.now() - origin) + simulated,
      );
      vi.mocked(ctx.device.getAppState).mockImplementation(
        async (_pkg: string, opts?: { timeout?: number }) => {
          simulated += (opts?.timeout ?? 0) + lagMs;
          throw deadline();
        },
      );
      return spy;
    }

    it('re-probes after a missed deadline instead of recovering the session', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('foreground');

      await expect(
        ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0], iosForegroundProbe: { retryDelayMs: 0 } }),
      ).resolves.toBeUndefined();

      expect(ctx.device.getAppState).toHaveBeenCalledTimes(2);
      // The whole point: no agent restart + relaunch for a slow-but-alive agent.
      expect(onRecovery).not.toHaveBeenCalled();
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
      expect(ctx.device.launchApp).not.toHaveBeenCalled();
    });

    it('relaunches a displaced app found by the retry, same as a first-try answer', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('background');

      await expect(ensureSessionReady(ctx, 'before test', undefined, { iosForegroundProbe: { retryDelayMs: 0 } })).resolves.toBeUndefined();

      expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app');
      expect(ctx.device.startAgent).not.toHaveBeenCalled();
    });

    it('a daemon-side agent timeout is retried too, not treated as a dead session', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(new Error('Agent command timed out after 30s'))
        .mockResolvedValueOnce('foreground');

      await expect(
        ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0], iosForegroundProbe: { retryDelayMs: 0 } }),
      ).resolves.toBeUndefined();

      expect(onRecovery).not.toHaveBeenCalled();
    });

    it('a transport failure still recovers immediately — no budget spent on a dead socket', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(new Error('Agent connection dropped (empty response); reconnecting'))
        .mockResolvedValue('foreground');

      await expect(
        ensureSessionReady(ctx, 'before test', undefined, { onRecovery, retryBackoffMs: [0] }),
      ).resolves.toBeUndefined();

      // One attempt before the session was declared broken (not a budget's worth),
      // then recovery, then the post-recovery verification's own probe.
      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
      expect(ctx.device.getAppState).toHaveBeenCalledTimes(2);
    });

    it('a rung after a completed recovery gets one deadline, not another full budget', async () => {
      const ctx = iosContext();
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 2, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 900, attemptDeadlineMs: 200, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/session preflight failed during before test/);
      } finally {
        clock.mockRestore();
      }

      // Rung 1 spends the 900ms budget (4 probes); rung 2 follows a recovery
      // that restarted the agent, so it gets a single deadline (1 probe).
      // Unclamped this is a second full budget — the ~90s-per-preflight
      // regression the clamp exists to prevent.
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBe(5);
    });

    it('a rung whose recovery THREW keeps the full budget — nothing was restarted', async () => {
      const ctx = iosContext();
      // Recovery fails, so the agent was never restarted: clamping rung 2 here
      // would hand a merely-slow agent the single-shot behaviour PILOT-350
      // removes, one rung further down the ladder.
      vi.mocked(ctx.device.startAgent).mockRejectedValue(new Error('Failed to connect to agent socket'));
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 3, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 900, attemptDeadlineMs: 200, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/session preflight failed during before test/);
      } finally {
        clock.mockRestore();
      }

      // Two rungs, each spending a full 4-probe budget.
      expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBe(8);
    });

    it('an agent that never answers within the budget still escalates to recovery', async () => {
      const ctx = iosContext();
      const onRecovery = vi.fn();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());

      await expect(
        ensureSessionReady(ctx, 'before test', 2, {
          onRecovery,
          retryBackoffMs: [0],
          iosForegroundProbe: { budgetMs: 0 },
        }),
      ).rejects.toThrow(/session preflight failed during before test/);

      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    });

    it('narrows the per-attempt deadline to what is left of the budget', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockResolvedValue('foreground');

      await ensureSessionReady(ctx, 'before test', undefined, {
        iosForegroundProbe: { budgetMs: 400, attemptDeadlineMs: 12_000 },
      });

      const [, options] = vi.mocked(ctx.device.getAppState).mock.calls[0];
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(400);
    });

    it('caps each attempt at the per-attempt deadline, not the whole budget', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('foreground');

      await ensureSessionReady(ctx, 'before test', undefined, {
        iosForegroundProbe: { budgetMs: 1_000, attemptDeadlineMs: 100, retryDelayMs: 20 },
      });

      // Both attempts are capped at the per-attempt deadline. Without the cap
      // the probe collapses into a single wide-deadline call and stops
      // refreshing the daemon-side agent stream.
      const timeouts = vi.mocked(ctx.device.getAppState).mock.calls.map(([, o]) => o?.timeout);
      expect(timeouts).toHaveLength(2);
      for (const t of timeouts) expect(t).toBeLessThanOrEqual(100);
    });

    it('paces its retries — a fast-rejecting timeout does not become a hot spin', async () => {
      const ctx = iosContext();
      // Rejects instantly every time. Unpaced, the loop re-enters as fast as the
      // event loop allows and issues tens of thousands of RPCs (and stderr
      // lines) inside one budget.
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());
      const onRecovery = vi.fn();

      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          onRecovery,
          iosForegroundProbe: { budgetMs: 1_200, attemptDeadlineMs: 200, retryDelayMs: 50 },
        }),
      ).rejects.toThrow(/session preflight failed during before test/);

      // Paced, the attempt count is bounded by budget / retryDelay (~24 here).
      // Unpaced it is ~10^5 — the loop re-enters as fast as the event loop
      // allows, each iteration issuing an RPC and writing a stderr line.
      const attempts = vi.mocked(ctx.device.getAppState).mock.calls.length;
      expect(attempts).toBeGreaterThan(1);
      expect(attempts).toBeLessThan(40);
      expect(onRecovery).not.toHaveBeenCalled();
    });

    it('reports the budget it gave up on, not just the last attempt deadline', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());

      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 600, attemptDeadlineMs: 200, retryDelayMs: 20 },
        }),
      ).rejects.toThrow(/iOS foreground probe gave up after .*attempts?, 0\.2s deadline each, 0\.6s budget/);

      // Assert the ACTUAL classifier, not a looser substring: the file-retry
      // loops in cli.ts / worker-runner.ts / ui-worker.ts key off this, and
      // `RECOVERABLE_INFRASTRUCTURE_PATTERNS` wants the '4 ' status prefix, so
      // a regex on the bare code would pass while classification broke.
      const err = await ensureSessionReady(ctx, 'before test', 1, {
        iosForegroundProbe: { budgetMs: 600, attemptDeadlineMs: 200, retryDelayMs: 20 },
      }).catch((e: unknown) => e);
      expect(isRecoverableInfrastructureError(err)).toBe(true);
    });

    it('names the deadline an attempt actually used, not the unclamped constant', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());

      // Budget below the per-attempt deadline: the one attempt's deadline is
      // clamped to the budget, so the give-up line must not quote 12.0s.
      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 300, attemptDeadlineMs: 12_000, retryDelayMs: 0 },
        }),
      ).rejects.toThrow(/0\.3s deadline each, 0\.3s budget/);
    });

    it('does not annotate a failed recovery with the probe latency', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());
      vi.mocked(ctx.device.startAgent).mockRejectedValue(new Error('Failed to connect to agent socket'));

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 3, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 0, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/Failed to connect to agent socket/);
      } finally {
        unsubscribe();
      }

      // The reported error came from recoverSession, not the probe; the end
      // event must not read as though the probe produced it.
      const end = events.find((e) => e.kind === 'end');
      expect(end?.detail).toBeUndefined();
    });

    it('a failed relaunch is not reported as a probe failure', async () => {
      const ctx = iosContext();
      // The probe ANSWERS (app displaced), then the relaunch throws. Neither
      // the breadcrumb nor the progress annotation may point at the probe.
      vi.mocked(ctx.device.getAppState).mockResolvedValue('background');
      vi.mocked(ctx.device.launchApp).mockRejectedValue(new Error('Launch app failed: LAUNCH_FAILED'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      let written = '';
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, { iosForegroundProbe: { retryDelayMs: 0 } }),
        ).rejects.toThrow(/LAUNCH_FAILED/);
        written = stderr.mock.calls.map(([c]) => String(c)).join('');
      } finally {
        unsubscribe();
        stderr.mockRestore();
      }

      expect(written).toMatch(/relaunch failed/);
      expect(written).not.toMatch(/foreground probe failed/);
      const end = events.find((e) => e.kind === 'end');
      expect(end?.detail).toBeUndefined();
    });

    it('a rung whose predecessor never spent a probe budget keeps the full budget', async () => {
      const ctx = iosContext();
      // Rung 1 dies at ping, so no probe ran. Rung 2 runs right after
      // recoverSession's terminate + launch — when getAppState is slowest — and
      // must not be cut to a single deadline.
      vi.mocked(ctx.client.ping)
        .mockResolvedValueOnce({ version: '0.1.0', agentConnected: false })
        .mockResolvedValue({ version: '0.1.0', agentConnected: true });
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 2, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 900, attemptDeadlineMs: 200, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/session preflight failed during before test/);
      } finally {
        clock.mockRestore();
      }

      // Rung 2 spends a full 4-probe budget; clamped it would be 1.
      expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBe(4);
    });

    it('reports cumulative probe time once the ladder has probed more than once', async () => {
      const ctx = iosContext();
      // Rung 1 burns its budget, recovery succeeds, rung 2 answers instantly.
      // The annotation must not read as though only 0.0s went on probing.
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValue('foreground');

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await ensureSessionReady(ctx, 'before test', 2, {
          retryBackoffMs: [0],
          iosForegroundProbe: { budgetMs: 0, retryDelayMs: 0 },
        });
      } finally {
        unsubscribe();
      }

      const end = events.find((e) => e.kind === 'end');
      expect(end?.success).toBe(true);
      expect(end?.detail).toMatch(/across 2 probes/);
    });

    it('prints a breadcrumb naming the relaunch when the relaunch is what failed', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState).mockResolvedValue('background');
      vi.mocked(ctx.device.launchApp).mockRejectedValue(new Error('Launch app failed: LAUNCH_FAILED'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let written = '';
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, { iosForegroundProbe: { retryDelayMs: 0 } }),
        ).rejects.toThrow(/LAUNCH_FAILED/);
        written = stderr.mock.calls.map(([c]) => String(c)).join('');
      } finally {
        stderr.mockRestore();
      }

      expect(written).toMatch(/relaunch failed/);
      expect(written).not.toMatch(/foreground probe failed/);
    });

    it('the shipped budget admits a second attempt even when the rejection lands seconds late', async () => {
      // Drives the REAL constants: the budget must leave room for a full second
      // attempt after the first deadline plus event-loop lag, or the probe
      // silently degrades to the single-shot behaviour PILOT-350 removed.
      const ctx = iosContext();
      // The deadline fires, then 3s of lag before the rejection lands.
      const nowSpy = withFakeClock(ctx, 3_000);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, {}),
        ).rejects.toThrow(/iOS foreground probe gave up/);

        expect(vi.mocked(ctx.device.getAppState).mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('never starts a sliver attempt that cannot run to a full deadline', async () => {
      const ctx = iosContext();
      // Each attempt burns its whole deadline, so the budget leaves a 40ms
      // remainder after two attempts. That remainder must not become a third
      // attempt whose sub-deadline error masks the real timeout.
      const clock = withFakeClock(ctx);
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 1, {
            iosForegroundProbe: { budgetMs: 240, attemptDeadlineMs: 100, retryDelayMs: 0 },
          }),
        ).rejects.toThrow(/DEADLINE_EXCEEDED/);
      } finally {
        clock.mockRestore();
      }

      const timeouts = vi.mocked(ctx.device.getAppState).mock.calls.map(([, o]) => o?.timeout);
      expect(timeouts).toEqual([100, 100]);
    });

    it('a transport failure AFTER a slow attempt reports the socket error, not the budget', async () => {
      const ctx = iosContext();
      // The mixed sequence takes the same early break as a first-attempt
      // transport failure but with attempts > 1; it must still surface the
      // socket error rather than the "gave up after ... budget" wrapper, or
      // triage is pointed at the deadline constant.
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockRejectedValue(new Error('Agent connection dropped (empty response); reconnecting'));

      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 5_000, attemptDeadlineMs: 100, retryDelayMs: 0 },
        }),
      ).rejects.toThrow(/Agent connection dropped/);
      await expect(
        ensureSessionReady(ctx, 'before test', 1, {
          iosForegroundProbe: { budgetMs: 5_000, attemptDeadlineMs: 100, retryDelayMs: 0 },
        }),
      ).rejects.not.toThrow(/gave up after/);
    });

    it('does not annotate a transport failure with a probe latency', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValue(new Error('Agent connection dropped (empty response); reconnecting'));

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await expect(ensureSessionReady(ctx, 'before test', 1, {})).rejects.toThrow();
      } finally {
        unsubscribe();
      }

      // A dropped socket is not probe latency; `— foreground probe 0.3s` on
      // that line points triage at the deadline constant.
      const end = events.find((e) => e.kind === 'end');
      expect(end?.success).toBe(false);
      expect(end?.detail).toBeUndefined();
    });

    it('reports the probe latency on the App ready progress event', async () => {
      const ctx = iosContext();
      vi.mocked(ctx.device.getAppState)
        .mockRejectedValueOnce(deadline())
        .mockResolvedValueOnce('foreground');

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await ensureSessionReady(ctx, 'before test', undefined, { iosForegroundProbe: { retryDelayMs: 0 } });
      } finally {
        unsubscribe();
      }

      const end = events.find((e) => e.kind === 'end');
      expect(end?.detail).toMatch(/^foreground probe \d+\.\ds after 2 attempts$/);
    });

    it('does not attribute an earlier attempt\'s probe to a later attempt that never probed', async () => {
      const ctx = iosContext();
      // Attempt 1 probes and exhausts its budget; attempt 2 dies at ping, before
      // the probe runs. The end event must not carry attempt 1's annotation.
      vi.mocked(ctx.device.getAppState).mockRejectedValue(deadline());
      vi.mocked(ctx.client.ping)
        .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true })
        .mockRejectedValue(new Error('Agent connection dropped (empty response); reconnecting'));

      const events: ActionProgressEvent[] = [];
      const unsubscribe = onActionProgress((ev) => events.push(ev));
      try {
        await expect(
          ensureSessionReady(ctx, 'before test', 2, {
            retryBackoffMs: [0],
            iosForegroundProbe: { budgetMs: 0 },
          }),
        ).rejects.toThrow();
      } finally {
        unsubscribe();
      }

      const end = events.find((e) => e.kind === 'end');
      expect(end?.success).toBe(false);
      expect(end?.detail).toBeUndefined();
    });
  });

  it('iOS clear policy runs the daemon ladder then the readiness waits', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    // iOS verifySession polls hierarchy instead of waitForIdle
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

    expect(ctx.device._resetApp).toHaveBeenCalledWith('com.example.app', expect.objectContaining({ mode: 'clear' }));
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(report.steps.map((s) => s.name)).toEqual(['clear', 'resetApp', 'ensureSessionReady', 'waitForAppReady']);
  });
  it('startup/recovery launch never uses the warm hook', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    await launchConfiguredApp(ctx, 'recovery', { hooksProbeMs: 0 });

    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
  });
  it('iOS launchConfiguredApp polls hierarchy until non-empty', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '', errorMessage: '' })
      .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '  ', errorMessage: '' })
      .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '<hierarchy><node /></hierarchy>', errorMessage: '' });

    await launchConfiguredApp(ctx, 'startup', { hooksProbeMs: 0 });

    // 3 hierarchy calls (2 empty + 1 non-empty) + the reset-capabilities probe
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(4);
  });
  it('dismisses blocking system dialogs before relaunching', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.ping)
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true })
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });
    vi.mocked(ctx.client.getUiHierarchy)
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<node text="Pixel Launcher isn&apos;t responding" /><node text="Wait" /><node text="Close app" />',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<node text="Pixel Launcher isn&apos;t responding" /><node text="Wait" /><node text="Close app" />',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
  });

  describe('reset capabilities', () => {
    it('detects the in-app hooks marker after a launch and records it on the context', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=app:///" /></hierarchy>',
        errorMessage: '',
      });

      await launchConfiguredApp(ctx, 'startup launch', { freshInstall: true, hooksProbeMs: 0 });

      expect(ctx.capabilities).toEqual({ hooksDetected: true });
    });

    it('a marker without a URL prefix does not count as usable hooks', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=" /></hierarchy>',
        errorMessage: '',
      });
      expect(await probeResetCapabilities(ctx, { pollMs: 0 })).toEqual({ hooksDetected: false });
    });

    it('a clear reset under appReset auto re-reads the marker so a missed startup probe upgrades', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android' },
      });
      ctx.capabilities = { hooksDetected: false };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
        errorMessage: '',
      });

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.capabilities.hooksDetected).toBe(true);
    });

    it('an explicit appReset: clear does not spend a hierarchy read on hook detection', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android', appReset: 'clear' },
      });
      ctx.capabilities = { hooksDetected: false };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
        errorMessage: '',
      });

      await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

      expect(ctx.capabilities.hooksDetected).toBe(false);
    });

    it('a probe whose every read fails records nothing (not "no hooks")', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockRejectedValue(new Error('agent busy'));

      expect(await probeResetCapabilities(ctx, { pollMs: 300 })).toEqual({});
      expect(vi.mocked(ctx.client.getUiHierarchy).mock.calls.length).toBeGreaterThan(1);
    });

    it('a warm reset refreshes hooksDetected from the daemon answer', async () => {
      const ctx = makeContext({
        config: { package: 'com.example.app', activity: '.MainActivity', platform: 'android' },
      });
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', { hooksDetected: true, epochBefore: 1, epochAfter: 2 }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect(ctx.capabilities?.hooksDetected).toBe(true);
    });

    it('a probe that misses the marker never demotes hooksDetected (sticky under load)', async () => {
      const ctx = makeContext();
      (ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities = { hooksDetected: true };
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" text="mid-transition, no marker" /></hierarchy>',
        errorMessage: '',
      });

      const caps = await probeResetCapabilities(ctx);

      expect(caps.hooksDetected).toBe(true);
    });

    it('a fallback reset (daemon saw no marker this time) does not demote hooksDetected', async () => {
      const ctx = makeContext();
      (ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities = { hooksDetected: true };
      vi.mocked(ctx.device._resetApp).mockResolvedValueOnce(resetResult('warm', {
        modeUsed: 'restart', fellBack: true, coldLaunch: true, hooksDetected: false,
      }));

      await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

      expect((ctx as { capabilities?: { hooksDetected?: boolean } }).capabilities?.hooksDetected).toBe(true);
    });

    it('a session-level probe keeps looking for the marker while the app is still mounting', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy)
        .mockResolvedValueOnce({ requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" text="splash" /></hierarchy>', errorMessage: '' })
        .mockRejectedValueOnce(new Error('agent busy'))
        .mockResolvedValueOnce({
          requestId: '3',
          hierarchyXml: '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;url=exp://x/" /></hierarchy>',
          errorMessage: '',
        });

      expect(await probeResetCapabilities(ctx, { pollMs: 5_000 })).toEqual({ hooksDetected: true });
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
    });

    it('the probe gives up on the marker at the poll budget and records false once', async () => {
      const ctx = makeContext();
      vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
        requestId: '1', hierarchyXml: '<hierarchy><node package="com.example.app" text="no marker" /></hierarchy>', errorMessage: '',
      });

      expect(await probeResetCapabilities(ctx, { pollMs: 600 })).toEqual({ hooksDetected: false });
      const polled = vi.mocked(ctx.client.getUiHierarchy).mock.calls.length;
      expect(polled).toBeGreaterThan(1);

      // Already concluded: a later probe is single-shot (watch/MCP re-probe per file).
      await probeResetCapabilities(ctx, { pollMs: 5_000 });
      expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(polled + 1);
    });

    it('a probe failure leaves the capabilities as they were', async () => {
      const ctx = makeContext();
      ctx.capabilities = { hooksDetected: true };
      vi.mocked(ctx.client.getUiHierarchy).mockRejectedValueOnce(new Error('agent busy'));
      expect(await probeResetCapabilities(ctx)).toEqual({ hooksDetected: true });
    });
  });
});
