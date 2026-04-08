import { describe, expect, it, vi } from 'vitest';
import { ensureSessionReady, launchConfiguredApp } from '../session-preflight.js';

function makeContext(overrides: Partial<Parameters<typeof ensureSessionReady>[0]> = {}) {
  const device = {
    startAgent: vi.fn(async () => undefined),
    terminateApp: vi.fn(async () => undefined),
    launchApp: vi.fn(async () => undefined),
    openDeepLink: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    currentPackage: vi.fn(async () => 'com.example.app'),
    tap: vi.fn(async () => undefined),
    pressBack: vi.fn(async () => undefined),
    clearAppData: vi.fn(async () => undefined),
    restartApp: vi.fn(async () => undefined),
    getAppState: vi.fn(async () => 'foreground' as const),
  };

  const client = {
    ping: vi.fn(async () => ({ version: '0.1.0', agentConnected: true })),
    getUiHierarchy: vi.fn(async () => ({
      requestId: '1',
      hierarchyXml: '<hierarchy />',
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

  it('restarts the session once when the agent is disconnected', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.client.ping)
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: false })
      .mockResolvedValueOnce({ version: '0.1.0', agentConnected: true });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();

    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.device.launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      waitForIdle: false,
    });
  });

  it('fails when the foreground package never matches', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device.currentPackage).mockResolvedValue('com.other.app');

    await expect(ensureSessionReady(ctx, 'startup')).rejects.toThrow(
      'foreground package mismatch',
    );
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
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

    expect(ctx.device.openDeepLink).toHaveBeenNthCalledWith(1, 'example:///__reset');
    expect(ctx.device.openDeepLink).toHaveBeenNthCalledWith(2, 'example:///');
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(1, 321);
    expect(ctx.device.waitForIdle).toHaveBeenNthCalledWith(2, 321);
    expect(ctx.device.restartApp).not.toHaveBeenCalled();
    expect(ctx.device.clearAppData).not.toHaveBeenCalled();
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

  it('fails on package mismatch when app is not in hierarchy', async () => {
    const ctx = makeContext();
    vi.mocked(ctx.device.currentPackage).mockResolvedValue('com.google.android.apps.nexuslauncher');

    await expect(ensureSessionReady(ctx, 'startup')).rejects.toThrow(
      'foreground package mismatch',
    );
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

  it('iOS soft reset skips home deep link when reset URL has no path', async () => {
    const ctx = makeContext({
      config: {
        package: 'com.example.app',
        activity: undefined,
        platform: 'ios',
        resetAppDeepLink: 'example:///',
      },
    });
    vi.mocked(ctx.client.getUiHierarchy).mockResolvedValue({
      requestId: '1',
      hierarchyXml: '<hierarchy><node /></hierarchy>',
      errorMessage: '',
    });

    await expect(launchConfiguredApp(ctx, 'file reset')).resolves.toBeUndefined();

    // Only one deep link call — home URL equals reset URL so it's skipped
    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(1);
    expect(ctx.device.openDeepLink).toHaveBeenCalledWith('example:///');
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

    expect(ctx.device.openDeepLink).toHaveBeenCalledTimes(2);
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
        hierarchyXml: '<hierarchy />',
        errorMessage: '',
      })
      .mockResolvedValueOnce({
        requestId: '1',
        hierarchyXml: '<hierarchy />',
        errorMessage: '',
    });

    await expect(ensureSessionReady(ctx, 'startup')).resolves.toBeUndefined();
    expect(ctx.device.startAgent).toHaveBeenCalledTimes(1);
    expect(ctx.client.getUiHierarchy).toHaveBeenCalledTimes(3);
  });
});
