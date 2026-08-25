import { describe, expect, it, vi } from 'vitest';
import { ensureSessionReady, executeAppReset, launchConfiguredApp } from '../session-preflight.js';
import type { AppResetPolicy } from '../app-reset.js';
import { onActionProgress, type ActionProgressEvent } from '../action-progress.js';

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
  };

  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy><node package="com.example.app" /></hierarchy>',
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
        hierarchyXml: '<hierarchy><node package="com.example.app" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'before test', undefined, { onRecovery })).resolves.toBeUndefined();

    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app');
    expect(onRecovery).not.toHaveBeenCalled();
    expect(ctx.device.startAgent).not.toHaveBeenCalled();
  });

  it('startup launch clears + launches and reports a `clear` prepared state', async () => {
    const ctx = makeContext();

    const prepared = await launchConfiguredApp(ctx, 'startup launch');

    expect(ctx.device.terminateApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
    expect(prepared).toMatchObject({ policy: { mode: 'clear', scope: 'file' }, source: 'startup launch' });
  });

  it('startup launch with skipAppReset only launches (fresh install has nothing to clear)', async () => {
    const ctx = makeContext();

    const prepared = await launchConfiguredApp(ctx, 'worker startup launch', { skipAppReset: true });

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
    expect(report.steps.map((s) => s.name)).toEqual(['restoreAppState', 'restartApp', 'ensureSessionReady']);
  });

  it('appState "" means clear', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'file', appState: '' }, { phase: 'file reset' });

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restoreAppState).not.toHaveBeenCalled();
    expect(report.modeUsed).toBe('clear');
  });

  it('restart policy only restarts', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, { mode: 'restart', scope: 'test' }, { phase: 'before test' });

    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'restart' });
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

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(report.origin).toBe('inline');
  });

  it('warm without a reset hook falls back to restart and says so', async () => {
    const ctx = makeContext();

    const report = await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(report).toMatchObject({ modeUsed: 'restart', fellBack: true });
    expect(report.reason).toMatch(/no reset hook/);
  });

  it('attaches the failing step to the thrown error path', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device.restartApp).mockRejectedValueOnce(new Error('boom'));

    await expect(executeAppReset(ctx, { mode: 'restart', scope: 'file' }, { phase: 'file reset' })).rejects.toThrow('boom');
  });
  it('still validates sessions without a configured package', async () => {
    const ctx = makeContext({
      config: { package: undefined, activity: undefined },
    });

    await expect(launchConfiguredApp(ctx, 'startup')).resolves.toMatchObject({ policy: CLEAR_FILE });
    expect(ctx.device.launchApp).not.toHaveBeenCalled();

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });
    expect(report).toMatchObject({ origin: 'skipped', reason: 'no package configured' });
  });
  it('uses the iOS warm reset hook; file-scope resets deliver it cold', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
        resetAppWaitMs: 321,
      },
    });

    const report = await executeAppReset(ctx, WARM_FILE, { phase: 'file reset', forceCold: true });

    expect(ctx.device.openDeepLink).toHaveBeenNthCalledWith(1, 'example:///__reset', { forceColdLaunch: true });
    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(1);
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 321);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(1);
    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(report).toMatchObject({ origin: 'inline', modeUsed: 'warm', fellBack: false });
  });

  it('per-test warm resets deliver the hook warm (no forced cold launch)', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios', resetAppDeepLink: 'example:///__reset' },
    });

    await executeAppReset(ctx, WARM_TEST, { phase: 'before test' });

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: false });
  });
  it('falls back to iOS hard reset when the warm reset fails', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.device.openDeepLink).mockRejectedValueOnce(new Error('deep link failed'));

    const report = await executeAppReset(ctx, WARM_FILE, { phase: 'file reset', forceCold: true });

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: true });
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(report).toMatchObject({ modeUsed: 'clear', fellBack: true });
    expect(report.reason).toMatch(/warm reset failed \(deep link failed\); fell back to clear/);
    expect(report.steps.some((s) => s.name === 'openDeepLink' && !s.ok)).toBe(true);
  });
  it('uses the warm reset hook on Android when configured', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: '.MainActivity',
        platform: 'android',
        resetAppDeepLink: 'example:///__reset',
      },
    });

    await executeAppReset(ctx, WARM_FILE, { phase: 'file reset', forceCold: true });

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: true });
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
  });
  it('falls back to Android hard reset when the warm reset fails', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: '.MainActivity',
        platform: 'android',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.device.openDeepLink).mockRejectedValueOnce(new Error('deep link failed'));

    await executeAppReset(ctx, WARM_FILE, { phase: 'file reset' });

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: false });
    expect(ctx.device.terminateApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
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
        hierarchyXml: '<hierarchy><node package="com.example.app" /></hierarchy>',
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
        hierarchyXml: '<hierarchy><node package="com.example.app" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();

    expect(ctx.device.pressBack).toHaveBeenCalledTimes(1);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(2);
  });

  it('iOS clear policy: clearAppData + restartApp', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    // iOS verifySession polls hierarchy instead of waitForIdle
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
    expect(report.steps.map((s) => s.name)).toEqual(['clearAppData', 'restartApp', 'ensureSessionReady', 'waitForAppReady']);
  });
  it('iOS clear policy recovers when restartApp fails', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    vi.mocked(ctx.device.restartApp).mockRejectedValueOnce(new Error('agent stale'));
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    const report = await executeAppReset(ctx, CLEAR_FILE, { phase: 'file reset' });

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    // Should still succeed via ensureSessionReady
    expect(ctx.client.ping).toHaveBeenCalled();
    expect(report.origin).toBe('inline');
  });
  it('iOS warm reset uses default wait time when resetAppWaitMs not set', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    await executeAppReset(ctx, WARM_FILE, { phase: 'file reset' });

    // Default is 750ms
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 750);
  });
  it('iOS warm reset falls back to setTimeout when waitForIdle rejects', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
        resetAppWaitMs: 100,
      },
    });
    vi.mocked(ctx.device.waitForIdle).mockRejectedValue(new Error('timeout'));
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue(iosHierarchy);

    await executeAppReset(ctx, WARM_FILE, { phase: 'file reset' });

    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(1);
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

    await launchConfiguredApp(ctx, 'recovery');

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

    await launchConfiguredApp(ctx, 'startup');

    // 3 hierarchy calls: 2 empty + 1 non-empty
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
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
        hierarchyXml: '<hierarchy><node package="com.example.app" /></hierarchy>',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy><node package="com.example.app" /></hierarchy>',
        errorMessage: '',
      });

    await expect(ensureSessionReady(ctx, 'startup', undefined, { retryBackoffMs: [0] })).resolves.toBeUndefined();
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
  });
});
