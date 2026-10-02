import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnvScan } from '../env-scan.js';

// ─── Mocks ───

// The wizard's prompts, answered by message so the test reads as a script and
// records which questions were asked.
const answers = new Map<RegExp, unknown>();
const asked: string[] = [];
vi.mock('enquirer', () => ({
  default: class {
    prompt(question: { message: string }): Promise<Record<string, unknown>> {
      asked.push(question.message);
      for (const [pattern, answer] of answers) {
        if (pattern.test(question.message)) return Promise.resolve({ _: answer });
      }
      return Promise.reject(new Error(`unexpected prompt: ${question.message}`));
    }
  },
}));

const bundleIds = new Map<string, string>();
vi.mock('../init-detect.js', () => ({
  detectAndroidPackage: () => undefined,
  detectIosBundleId: (appPath: string) => bundleIds.get(appPath),
}));

vi.mock('../setup-ios-device.js', () => {
  const ok = (label: string) => () => ({ ok: true, label });
  return {
    checkXcodeCommandLineTools: ok('Xcode CLT'),
    checkDevicectl: ok('devicectl'),
    checkIproxy: ok('iproxy'),
    checkSigningIdentities: ok('signing'),
    checkDeviceConnection: ok('device'),
  };
});

const { configureIos } = await import('../init.js');

const env: EnvScan = {
  nodeVersion: '22.0.0',
  daemonBin: undefined,
  agentApk: false,
  agentTestApk: false,
  adbVersion: undefined,
  androidHome: undefined,
  xcodeVersion: '26.0',
  simulators: [{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26.0' }],
  avds: [],
  avdImages: [],
  isMacOS: true,
};

const SIM_APP = './ios/Debug-iphonesimulator/MyApp.app';
const DEVICE_APP = './ios/Release-iphoneos/MyApp.app';

function script(deviceType: string, extra: Array<[RegExp, unknown]> = []): void {
  // Extras first: the first matching pattern answers.
  for (const [pattern, answer] of extra) answers.set(pattern, answer);
  answers.set(/How will you run iOS tests/, deviceType);
  answers.set(/simulator build\)/, SIM_APP);
  answers.set(/Which simulator/, 'iPhone 17');
  answers.set(/Build the iOS agent/, false);
  answers.set(/device build \.app/, DEVICE_APP);
}

// ─── Tests ───

describe('configureIos() (PILOT-251)', () => {
  beforeEach(() => {
    answers.clear();
    asked.length = 0;
    bundleIds.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('physical only: never asks for a simulator build, and reads the bundle id from the device build', async () => {
    bundleIds.set(DEVICE_APP, 'com.example.device');
    script('physical');

    const ios = await configureIos(env);

    expect(asked.some((m) => /simulator build|Which simulator/.test(m))).toBe(false);
    expect(ios).toEqual({
      appPath: undefined,
      bundleId: 'com.example.device',
      deviceBundleId: undefined,
      simulator: undefined,
      usePhysicalDevice: true,
      deviceAppPath: DEVICE_APP,
    });
  });

  it('physical only: asks for the bundle id when the device build has none to read', async () => {
    script('physical', [[/bundle identifier/, 'com.example.typed']]);

    const ios = await configureIos(env);

    expect(ios.bundleId).toBe('com.example.typed');
  });

  it('both: collects the simulator and device builds, bundle id from the simulator build', async () => {
    bundleIds.set(SIM_APP, 'com.example.sim');
    script('both');

    const ios = await configureIos(env);

    expect(ios).toEqual({
      appPath: SIM_APP,
      bundleId: 'com.example.sim',
      deviceBundleId: undefined,
      simulator: 'iPhone 17',
      usePhysicalDevice: true,
      deviceAppPath: DEVICE_APP,
    });
    expect(asked.some((m) => /bundle identifier/.test(m))).toBe(false);
  });

  it('both: same id in both builds is kept once', async () => {
    bundleIds.set(SIM_APP, 'com.example.app');
    bundleIds.set(DEVICE_APP, 'com.example.app');
    script('both');

    const ios = await configureIos(env);

    expect(ios.bundleId).toBe('com.example.app');
    expect(ios.deviceBundleId).toBeUndefined();
  });

  it('both: keeps the device build\'s own id when it differs from the simulator build\'s', async () => {
    bundleIds.set(SIM_APP, 'com.example.app.dev');
    bundleIds.set(DEVICE_APP, 'com.example.app');
    script('both');

    const ios = await configureIos(env);

    expect(ios.bundleId).toBe('com.example.app.dev');
    expect(ios.deviceBundleId).toBe('com.example.app');
  });

  it('both: asks for the simulator build\'s id when only the device build\'s can be read', async () => {
    bundleIds.set(DEVICE_APP, 'com.example.app');
    script('both', [[/simulator build's bundle identifier/, 'com.example.app.dev']]);

    const ios = await configureIos(env);

    expect(ios.bundleId).toBe('com.example.app.dev');
    expect(ios.deviceBundleId).toBe('com.example.app');
  });

  it('both: one id kept once when the typed simulator id matches the device build\'s', async () => {
    bundleIds.set(DEVICE_APP, 'com.example.app');
    script('both', [[/simulator build's bundle identifier/, 'com.example.app']]);

    const ios = await configureIos(env);

    expect(ios.bundleId).toBe('com.example.app');
    expect(ios.deviceBundleId).toBeUndefined();
  });

  it('simulators: never asks for a device build', async () => {
    bundleIds.set(SIM_APP, 'com.example.sim');
    script('simulators');

    const ios = await configureIos(env);

    expect(asked.some((m) => /device build|Build the iOS agent/.test(m))).toBe(false);
    expect(ios).toEqual({
      appPath: SIM_APP,
      bundleId: 'com.example.sim',
      deviceBundleId: undefined,
      simulator: 'iPhone 17',
      usePhysicalDevice: false,
      deviceAppPath: undefined,
    });
  });
});
