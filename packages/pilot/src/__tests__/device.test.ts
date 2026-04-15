import { describe, it, expect, vi } from 'vitest';
import { Device } from '../device.js';
import { selectorToProto } from '../selectors.js';
import type { PilotGrpcClient, ActionResponse } from '../grpc-client.js';

// ─── Mock helpers ───

function successResponse(): ActionResponse {
  return {
    requestId: '1',
    success: true,
    errorType: '',
    errorMessage: '',
    screenshot: Buffer.alloc(0),
  };
}

function failureResponse(msg = 'Action failed'): ActionResponse {
  return {
    requestId: '1',
    success: false,
    errorType: 'ERROR',
    errorMessage: msg,
    screenshot: Buffer.alloc(0),
  };
}

function makeMockClient(overrides: Partial<PilotGrpcClient> = {}): PilotGrpcClient {
  return {
    doubleTap: vi.fn(async () => successResponse()),
    dragAndDrop: vi.fn(async () => successResponse()),
    pinchZoom: vi.fn(async () => successResponse()),
    focus: vi.fn(async () => successResponse()),
    blur: vi.fn(async () => successResponse()),
    selectOption: vi.fn(async () => successResponse()),
    highlight: vi.fn(async () => successResponse()),
    pressKey: vi.fn(async () => successResponse()),
    launchApp: vi.fn(async () => successResponse()),
    openDeepLink: vi.fn(async () => successResponse()),
    getCurrentPackage: vi.fn(async () => ({ requestId: '1', packageName: 'com.example.app' })),
    getCurrentActivity: vi.fn(async () => ({ requestId: '1', activity: '.MainActivity' })),
    terminateApp: vi.fn(async () => successResponse()),
    getAppState: vi.fn(async () => ({ requestId: '1', state: 'foreground' })),
    clearAppData: vi.fn(async () => successResponse()),
    grantPermission: vi.fn(async () => successResponse()),
    revokePermission: vi.fn(async () => successResponse()),
    setClipboard: vi.fn(async () => successResponse()),
    getClipboard: vi.fn(async () => ({ requestId: '1', text: 'clipboard text' })),
    setOrientation: vi.fn(async () => successResponse()),
    getOrientation: vi.fn(async () => ({ requestId: '1', orientation: 'portrait' })),
    isKeyboardShown: vi.fn(async () => ({ requestId: '1', shown: false })),
    hideKeyboard: vi.fn(async () => successResponse()),
    openNotifications: vi.fn(async () => successResponse()),
    openQuickSettings: vi.fn(async () => successResponse()),
    setColorScheme: vi.fn(async () => successResponse()),
    getColorScheme: vi.fn(async () => ({ requestId: '1', scheme: 'light' })),
    wakeDevice: vi.fn(async () => successResponse()),
    unlockDevice: vi.fn(async () => successResponse()),
    startAgent: vi.fn(async () => successResponse()),
    restartApp: vi.fn(async () => successResponse()),
    saveAppState: vi.fn(async () => successResponse()),
    restoreAppState: vi.fn(async () => successResponse()),
    waitForIdle: vi.fn(async () => successResponse()),
    ...overrides,
  } as unknown as PilotGrpcClient;
}

// ─── getBy* locator factories ───

describe('Device locator factories', () => {
  it('getByText() defaults to substring match (textContains)', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByText('Submit');
    expect(selectorToProto(handle._selector)).toEqual({ textContains: 'Submit' });
  });

  it('getByText({exact: true}) uses exact text match', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByText('Submit', { exact: true });
    expect(selectorToProto(handle._selector)).toEqual({ text: 'Submit' });
  });

  it('getByRole() builds a role selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByRole('button', { name: 'Save' });
    expect(selectorToProto(handle._selector)).toEqual({
      role: { role: 'button', name: 'Save' },
    });
  });

  it('getByRole() defaults name to empty string', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByRole('checkbox');
    expect(selectorToProto(handle._selector)).toEqual({
      role: { role: 'checkbox', name: '' },
    });
  });

  it('getByDescription() builds a contentDesc selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByDescription('Close');
    expect(selectorToProto(handle._selector)).toEqual({ contentDesc: 'Close' });
  });

  it('getByPlaceholder() builds a hint selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByPlaceholder('Enter email');
    expect(selectorToProto(handle._selector)).toEqual({ hint: 'Enter email' });
  });

  it('getByTestId() builds a testId selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.getByTestId('submit-btn');
    expect(selectorToProto(handle._selector)).toEqual({ testId: 'submit-btn' });
  });

  it('locator({id}) builds an id selector serialized as resourceId', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.locator({ id: 'com.app:id/btn' });
    expect(selectorToProto(handle._selector)).toEqual({ resourceId: 'com.app:id/btn' });
  });

  it('locator({xpath}) builds an xpath selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.locator({ xpath: '//Button[@text="OK"]' });
    expect(selectorToProto(handle._selector)).toEqual({ xpath: '//Button[@text="OK"]' });
  });

  it('locator({className}) builds a className selector', () => {
    const client = makeMockClient();
    const device = new Device(client);
    const handle = device.locator({ className: 'android.widget.Button' });
    expect(selectorToProto(handle._selector)).toEqual({ className: 'android.widget.Button' });
  });

  it('locator() throws when no field is set', () => {
    const client = makeMockClient();
    const device = new Device(client);
    expect(() => device.locator({})).toThrow(/exactly one/);
  });

  it('locator() throws when multiple fields are set', () => {
    const client = makeMockClient();
    const device = new Device(client);
    expect(() => device.locator({ id: 'a', xpath: '//b' })).toThrow(/exactly one/);
  });
});

// ─── Device Management (PILOT-10) ───

// ─── launchApp() ───

describe('Device.launchApp()', () => {
  it('delegates to client.launchApp with package name', async () => {
    const launchApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ launchApp });
    const device = new Device(client);
    await device.launchApp('com.example.app');
    expect(launchApp).toHaveBeenCalledWith('com.example.app', undefined);
  });

  it('passes options through', async () => {
    const launchApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ launchApp });
    const device = new Device(client);
    await device.launchApp('com.example.app', { activity: '.MainActivity', clearData: true });
    expect(launchApp).toHaveBeenCalledWith('com.example.app', {
      activity: '.MainActivity',
      clearData: true,
    });
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      launchApp: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.launchApp('com.example.app')).rejects.toThrow('Launch app failed');
  });
});

// ─── openDeepLink() ───

describe('Device.openDeepLink()', () => {
  it('delegates to client.openDeepLink', async () => {
    const openDeepLink = vi.fn(async () => successResponse());
    const client = makeMockClient({ openDeepLink });
    const device = new Device(client);
    await device.openDeepLink('myapp://settings');
    expect(openDeepLink).toHaveBeenCalledWith('myapp://settings');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      openDeepLink: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.openDeepLink('myapp://x')).rejects.toThrow('Open deep link failed');
  });
});

// ─── currentPackage() / currentActivity() ───

describe('Device.currentPackage()', () => {
  it('returns the package name', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const pkg = await device.currentPackage();
    expect(pkg).toBe('com.example.app');
  });
});

describe('Device.currentActivity()', () => {
  it('returns the activity name', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const activity = await device.currentActivity();
    expect(activity).toBe('.MainActivity');
  });
});

// ─── terminateApp() ───

describe('Device.terminateApp()', () => {
  it('delegates to client.terminateApp', async () => {
    const terminateApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ terminateApp });
    const device = new Device(client);
    await device.terminateApp('com.example.app');
    expect(terminateApp).toHaveBeenCalledWith('com.example.app');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      terminateApp: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.terminateApp('com.example.app')).rejects.toThrow('Terminate app failed');
  });
});

// ─── getAppState() ───

describe('Device.getAppState()', () => {
  it('returns the app state', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const state = await device.getAppState('com.example.app');
    expect(state).toBe('foreground');
  });
});

// ─── sendToBackground() / bringToForeground() ───

describe('Device.sendToBackground()', () => {
  it('presses HOME key', async () => {
    const pressKey = vi.fn(async () => successResponse());
    const client = makeMockClient({ pressKey });
    const device = new Device(client);
    await device.sendToBackground();
    expect(pressKey).toHaveBeenCalledWith('HOME');
  });
});

describe('Device.bringToForeground()', () => {
  it('launches the app', async () => {
    const launchApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ launchApp });
    const device = new Device(client);
    await device.bringToForeground('com.example.app');
    expect(launchApp).toHaveBeenCalledWith('com.example.app', undefined);
  });
});

// ─── clearAppData() ───

describe('Device.clearAppData()', () => {
  it('delegates to client.clearAppData', async () => {
    const clearAppData = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearAppData });
    const device = new Device(client);
    await device.clearAppData('com.example.app');
    expect(clearAppData).toHaveBeenCalledWith('com.example.app');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearAppData: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.clearAppData('com.example.app')).rejects.toThrow('Clear app data failed');
  });
});

// ─── restartApp() ───

describe('Device.restartApp()', () => {
  it('delegates to client.restartApp with waitForIdle true by default', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client);
    await device.restartApp('com.example.app');
    expect(restartApp).toHaveBeenCalledWith('com.example.app', true);
  });

  it('passes waitForIdle false when specified', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client);
    await device.restartApp('com.example.app', { waitForIdle: false });
    expect(restartApp).toHaveBeenCalledWith('com.example.app', false);
  });

  it('uses config.package when packageName is omitted', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client, { package: 'com.example.configured' });
    await device.restartApp();
    expect(restartApp).toHaveBeenCalledWith('com.example.configured', true);
  });

  it('accepts options as the first argument when using config.package', async () => {
    const restartApp = vi.fn(async () => successResponse());
    const client = makeMockClient({ restartApp });
    const device = new Device(client, { package: 'com.example.configured' });
    await device.restartApp({ waitForIdle: false });
    expect(restartApp).toHaveBeenCalledWith('com.example.configured', false);
  });

  it('throws a helpful error when no package is available', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    await expect(device.restartApp()).rejects.toThrow(
      'Package name is required. Pass one explicitly or set `package` in your Pilot config.',
    );
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      restartApp: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.restartApp('com.example.app')).rejects.toThrow('Restart app failed');
  });
});

// ─── Permission management ───

describe('Device.grantPermission()', () => {
  it('delegates to client.grantPermission', async () => {
    const grantPermission = vi.fn(async () => successResponse());
    const client = makeMockClient({ grantPermission });
    const device = new Device(client);
    await device.grantPermission('com.example.app', 'android.permission.CAMERA');
    expect(grantPermission).toHaveBeenCalledWith('com.example.app', 'android.permission.CAMERA');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      grantPermission: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.grantPermission('com.example.app', 'android.permission.CAMERA')).rejects.toThrow('Grant permission failed');
  });
});

describe('Device.revokePermission()', () => {
  it('delegates to client.revokePermission', async () => {
    const revokePermission = vi.fn(async () => successResponse());
    const client = makeMockClient({ revokePermission });
    const device = new Device(client);
    await device.revokePermission('com.example.app', 'android.permission.CAMERA');
    expect(revokePermission).toHaveBeenCalledWith('com.example.app', 'android.permission.CAMERA');
  });
});

// ─── Clipboard ───

describe('Device.setClipboard()', () => {
  it('delegates to client.setClipboard', async () => {
    const setClipboard = vi.fn(async () => successResponse());
    const client = makeMockClient({ setClipboard });
    const device = new Device(client);
    await device.setClipboard('Hello, world!');
    expect(setClipboard).toHaveBeenCalledWith('Hello, world!');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      setClipboard: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.setClipboard('x')).rejects.toThrow('Set clipboard failed');
  });
});

describe('Device.getClipboard()', () => {
  it('returns clipboard text', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const text = await device.getClipboard();
    expect(text).toBe('clipboard text');
  });
});

// ─── Orientation ───

describe('Device.setOrientation()', () => {
  it('delegates to client.setOrientation', async () => {
    const setOrientation = vi.fn(async () => successResponse());
    const client = makeMockClient({ setOrientation });
    const device = new Device(client);
    await device.setOrientation('landscape');
    expect(setOrientation).toHaveBeenCalledWith('landscape');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      setOrientation: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.setOrientation('landscape')).rejects.toThrow('Set orientation failed');
  });
});

describe('Device.getOrientation()', () => {
  it('returns the orientation', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const orientation = await device.getOrientation();
    expect(orientation).toBe('portrait');
  });
});

// ─── Keyboard ───

describe('Device.isKeyboardShown()', () => {
  it('returns keyboard visibility', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const shown = await device.isKeyboardShown();
    expect(shown).toBe(false);
  });

  it('returns true when keyboard is shown', async () => {
    const client = makeMockClient({
      isKeyboardShown: vi.fn(async () => ({ requestId: '1', shown: true })),
    });
    const device = new Device(client);
    const shown = await device.isKeyboardShown();
    expect(shown).toBe(true);
  });
});

describe('Device.hideKeyboard()', () => {
  it('delegates to client.hideKeyboard', async () => {
    const hideKeyboard = vi.fn(async () => successResponse());
    const client = makeMockClient({ hideKeyboard });
    const device = new Device(client);
    await device.hideKeyboard();
    expect(hideKeyboard).toHaveBeenCalled();
  });
});

// ─── Navigation convenience ───

describe('Device.pressHome()', () => {
  it('presses HOME key', async () => {
    const pressKey = vi.fn(async () => successResponse());
    const client = makeMockClient({ pressKey });
    const device = new Device(client);
    await device.pressHome();
    expect(pressKey).toHaveBeenCalledWith('HOME');
  });
});

describe('Device.openNotifications()', () => {
  it('delegates to client.openNotifications', async () => {
    const openNotifications = vi.fn(async () => successResponse());
    const client = makeMockClient({ openNotifications });
    const device = new Device(client);
    await device.openNotifications();
    expect(openNotifications).toHaveBeenCalled();
  });
});

describe('Device.openQuickSettings()', () => {
  it('delegates to client.openQuickSettings', async () => {
    const openQuickSettings = vi.fn(async () => successResponse());
    const client = makeMockClient({ openQuickSettings });
    const device = new Device(client);
    await device.openQuickSettings();
    expect(openQuickSettings).toHaveBeenCalled();
  });
});

describe('Device.pressRecentApps()', () => {
  it('presses APP_SWITCH key', async () => {
    const pressKey = vi.fn(async () => successResponse());
    const client = makeMockClient({ pressKey });
    const device = new Device(client);
    await device.pressRecentApps();
    expect(pressKey).toHaveBeenCalledWith('APP_SWITCH');
  });
});

// ─── Color scheme ───

describe('Device.setColorScheme()', () => {
  it('delegates to client.setColorScheme', async () => {
    const setColorScheme = vi.fn(async () => successResponse());
    const client = makeMockClient({ setColorScheme });
    const device = new Device(client);
    await device.setColorScheme('dark');
    expect(setColorScheme).toHaveBeenCalledWith('dark');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      setColorScheme: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.setColorScheme('dark')).rejects.toThrow('Set color scheme failed');
  });
});

describe('Device.getColorScheme()', () => {
  it('returns the color scheme', async () => {
    const client = makeMockClient();
    const device = new Device(client);
    const scheme = await device.getColorScheme();
    expect(scheme).toBe('light');
  });
});

// ─── wake() / unlock() ───

describe('Device.wake()', () => {
  it('delegates to client.wakeDevice', async () => {
    const wakeDevice = vi.fn(async () => successResponse());
    const client = makeMockClient({ wakeDevice });
    const device = new Device(client);
    await device.wake();
    expect(wakeDevice).toHaveBeenCalled();
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      wakeDevice: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.wake()).rejects.toThrow('Wake device failed');
  });
});

describe('Device.unlock()', () => {
  it('delegates to client.unlockDevice', async () => {
    const unlockDevice = vi.fn(async () => successResponse());
    const client = makeMockClient({ unlockDevice });
    const device = new Device(client);
    await device.unlock();
    expect(unlockDevice).toHaveBeenCalled();
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      unlockDevice: vi.fn(async () => failureResponse('')),
    });
    const device = new Device(client);
    await expect(device.unlock()).rejects.toThrow('Unlock device failed');
  });
});

// ─── startAgent() with APK paths ───

describe('Device.startAgent()', () => {
  it('delegates to client.startAgent with package name', async () => {
    const startAgent = vi.fn(async () => successResponse());
    const client = makeMockClient({ startAgent });
    const device = new Device(client);
    await device.startAgent('com.example.app');
    expect(startAgent).toHaveBeenCalledWith('com.example.app', undefined, undefined, undefined, undefined, false);
  });

  it('passes APK paths through', async () => {
    const startAgent = vi.fn(async () => successResponse());
    const client = makeMockClient({ startAgent });
    const device = new Device(client);
    await device.startAgent('com.example.app', '/path/agent.apk', '/path/test.apk');
    expect(startAgent).toHaveBeenCalledWith('com.example.app', '/path/agent.apk', '/path/test.apk', undefined, undefined, false);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      startAgent: vi.fn(async () => failureResponse('Agent not installed')),
    });
    const device = new Device(client);
    await expect(device.startAgent('com.example.app')).rejects.toThrow('Agent not installed');
  });
});

// ─── saveAppState() ───

describe('Device.saveAppState()', () => {
  it('delegates to client.saveAppState with package name and path', async () => {
    const saveAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ saveAppState });
    const device = new Device(client);
    await device.saveAppState('com.example.app', './auth-state.tar.gz');
    expect(saveAppState).toHaveBeenCalledWith('com.example.app', './auth-state.tar.gz');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      saveAppState: vi.fn(async () => failureResponse('Permission denied')),
    });
    const device = new Device(client);
    await expect(device.saveAppState('com.example.app', './state.tar.gz')).rejects.toThrow('Permission denied');
  });

  it('uses default package name from config', async () => {
    const saveAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ saveAppState });
    const device = new Device(client, { package: 'com.default.app' });
    await device.saveAppState(undefined as unknown as string, './state.tar.gz');
    expect(saveAppState).toHaveBeenCalledWith('com.default.app', './state.tar.gz');
  });
});

// ─── restoreAppState() ───

describe('Device.restoreAppState()', () => {
  it('delegates to client.restoreAppState with package name and path', async () => {
    const restoreAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ restoreAppState });
    const device = new Device(client);
    await device.restoreAppState('com.example.app', './auth-state.tar.gz');
    expect(restoreAppState).toHaveBeenCalledWith('com.example.app', './auth-state.tar.gz');
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      restoreAppState: vi.fn(async () => failureResponse('Archive not found')),
    });
    const device = new Device(client);
    await expect(device.restoreAppState('com.example.app', './state.tar.gz')).rejects.toThrow('Archive not found');
  });

  it('uses default package name from config', async () => {
    const restoreAppState = vi.fn(async () => successResponse());
    const client = makeMockClient({ restoreAppState });
    const device = new Device(client, { package: 'com.default.app' });
    await device.restoreAppState(undefined as unknown as string, './state.tar.gz');
    expect(restoreAppState).toHaveBeenCalledWith('com.default.app', './state.tar.gz');
  });
});
