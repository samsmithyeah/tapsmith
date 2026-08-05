import { describe, expect, it, vi } from 'vitest';
import { ensureSessionReady, launchConfiguredApp } from '../session-preflight.js';
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
    restartApp: vi.fn(async () => undefined),
    getAppState: vi.fn(async () => 'foreground' as const),
    setNotificationPermission: vi.fn(async () => undefined),
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

  it('launches the configured app before verifying readiness', async () => {
    const ctx = makeContext();

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.terminateApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
  });

  it('re-applies the notification permission after the per-file pm clear', async () => {
    // Regression: `pm clear` resets runtime permission grants and user-set
    // flags, so the state applied at session setup must be re-applied for
    // every file after the first — otherwise only the first file runs with
    // the configured permission.
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: '.MainActivity',
        permissions: { notifications: 'granted' },
      },
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.setNotificationPermission).toHaveBeenCalledWith('com.example.app', 'granted');
    const clearOrder = vi.mocked(ctx.device.clearAppData).mock.invocationCallOrder[0];
    const applyOrder = vi.mocked(ctx.device.setNotificationPermission).mock.invocationCallOrder[0];
    expect(applyOrder).toBeGreaterThan(clearOrder);
  });

  it('does not touch permissions on per-file reset when none are configured', async () => {
    const ctx = makeContext();

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.setNotificationPermission).not.toHaveBeenCalled();
  });

  it('skips clearAppData when skipDataClear is set (appState restore owns isolation)', async () => {
    // Regression: the per-file preflight must NOT pm-clear an app whose scope
    // restores a non-empty appState. On Android pm clear wipes the
    // AndroidKeyStore keys that decrypt saved credentials (device-bound, not in
    // the archive), so the app comes back signed out after restore.
    const ctx = makeContext();

    await expect(
      launchConfiguredApp(ctx, 'file reset', { skipDataClear: true }),
    ).resolves.toBeUndefined();

    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    // The app is still launched so the session is ready; the scope's
    // restoreAppState then resets data the keystore-preserving way.
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
  });

  it('still validates sessions without a configured package', async () => {
    const ctx = makeContext({
      config: { package: undefined, activity: undefined },
    });

    await expect(launchConfiguredApp(ctx, 'startup')).resolves.toBeUndefined();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
  });

  it('uses iOS soft reset when configured', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
        resetAppWaitMs: 321,
      },
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.openDeepLink).toHaveBeenNthCalledWith(1, 'example:///__reset', { forceColdLaunch: true });
    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(1);
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 321);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(1);
    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
  });

  it('falls back to iOS hard reset when soft reset fails', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.device.openDeepLink).mockRejectedValueOnce(new Error('deep link failed'));

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: true });
    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
  });

  it('uses soft reset on Android when configured', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: '.MainActivity',
        platform: 'android',
        resetAppDeepLink: 'example:///__reset',
      },
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: true });
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
  });

  it('falls back to Android hard reset when soft reset fails', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: '.MainActivity',
        platform: 'android',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.device.openDeepLink).mockRejectedValueOnce(new Error('deep link failed'));

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///__reset', { forceColdLaunch: true });
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

  it('iOS clearAppData + restartApp path when no deep link configured', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    // iOS verifySession polls hierarchy instead of waitForIdle
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.terminateApp).not.toHaveBeenCalled();
    expect(ctx.device.launchApp).not.toHaveBeenCalled();
    expect(ctx.device.openDeepLink).not.toHaveBeenCalled();
  });

  it('iOS clearAppData path recovers when restartApp fails', async () => {
    const ctx = makeContext({
      config: { package: 'com.example.app', activity: undefined, platform: 'ios' },
    });
    vi.mocked(ctx.device.restartApp).mockRejectedValueOnce(new Error('agent stale'));
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.clearAppData).toHaveBeenCalledWith('com.example.app');
    expect(ctx.device.restartApp).toHaveBeenCalledWith('com.example.app');
    // Should still succeed via ensureSessionReady
    expect(ctx.client.ping).toHaveBeenCalled();
  });

  it('iOS soft reset does not infer a second home deep link', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example://reset',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(1);
    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example://reset', { forceColdLaunch: true });
  });

  it('iOS soft reset uses default wait time when resetAppWaitMs not set', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    // Default is 750ms
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 750);
  });

  it('iOS soft reset falls back to setTimeout when waitForIdle rejects', async () => {
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
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(1);
  });

  it('iOS soft reset is skipped when allowSoftReset is false', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///__reset',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset', { allowSoftReset: false })).resolves.toBeUndefined();

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

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

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
