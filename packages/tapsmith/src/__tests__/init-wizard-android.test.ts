import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvScan } from '../env-scan.js';
import { stripAnsi } from '../cli-json.js';

// ─── Mocks ───

// The wizard's prompts, answered by message so the test reads as a script and
// records every question asked (with its choices, initial and validate).
interface Question {
  type: string;
  message: string;
  initial?: unknown;
  choices?: Array<{ name: string; message: string }>;
  validate?: (val: string) => true | string;
}
const answers = new Map<RegExp, unknown>();
const questions: Question[] = [];
vi.mock('enquirer', () => ({
  default: class {
    prompt(question: Question): Promise<Record<string, unknown>> {
      questions.push(question);
      for (const [pattern, answer] of answers) {
        if (pattern.test(question.message)) {
          return Promise.resolve({ _: typeof answer === 'function' ? (answer as (q: Question) => unknown)(question) : answer });
        }
      }
      return Promise.reject(new Error(`unexpected prompt: ${question.message}`));
    }
  },
}));

let apkCandidates: string[] = [];
const packages = new Map<string, string>();
vi.mock('../init-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../init-detect.js')>();
  return {
    ...actual,
    findApkCandidates: () => apkCandidates,
    detectAndroidPackage: (apkPath: string) => packages.get(apkPath),
    findIosAppCandidates: () => [],
    findIosDeviceAppCandidates: () => [],
    detectIosBundleId: () => undefined,
  };
});

const { configureAndroid } = await import('../init.js');

const env: EnvScan = {
  nodeVersion: '22.0.0',
  daemonBin: undefined,
  agentApk: false,
  agentTestApk: false,
  adbVersion: '1.0.41',
  androidHome: undefined,
  xcodeVersion: undefined,
  simulators: [],
  avds: ['Pixel_API_36'],
  avdImages: [{ name: 'Pixel_API_36', tagId: 'google_apis' }],
  isMacOS: false,
};

const DEBUG_APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
const RELEASE_APK = 'android/app/build/outputs/apk/release/app-release.apk';
const OTHER = 'Enter another path';

function script(extra: Array<[RegExp, unknown]> = []): void {
  // Extras first: the first matching pattern answers.
  for (const [pattern, answer] of extra) answers.set(pattern, answer);
  answers.set(/How will you run Android tests/, 'emulators');
  answers.set(/Which AVD/, 'Pixel_API_36');
}

const question = (pattern: RegExp): Question | undefined => questions.find((q) => pattern.test(q.message));
let logged: string[] = [];

// ─── Tests ───

describe('configureAndroid() build detection (PILOT-513)', () => {
  beforeEach(() => {
    answers.clear();
    questions.length = 0;
    packages.clear();
    apkCandidates = [];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(stripAnsi(args.join(' '))); });
  });

  it('offers the one APK it found, pre-selected, and reads its package', async () => {
    apkCandidates = [RELEASE_APK];
    packages.set(RELEASE_APK, 'com.acme.app');
    script([[/Where is your Android APK/, RELEASE_APK]]);

    const android = await configureAndroid(env);

    const q = question(/Where is your Android APK/);
    expect(q?.type).toBe('select');
    expect(q?.choices?.map((c) => c.name)[0]).toBe(RELEASE_APK);
    expect(q?.choices?.[q.choices.length - 1].message).toMatch(new RegExp(OTHER));
    expect(android.apkPath).toBe(RELEASE_APK);
    expect(android.packageName).toBe('com.acme.app');
    expect(question(/package name/)).toBeUndefined();
  });

  it('lists every APK, debug builds first, when it finds several', async () => {
    apkCandidates = [DEBUG_APK, RELEASE_APK].sort().reverse();
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);

    await configureAndroid(env);

    const names = question(/Where is your Android APK/)?.choices?.map((c) => c.name);
    expect(names?.slice(0, 2)).toEqual([DEBUG_APK, RELEASE_APK]);
  });

  it('asks for a typed path, validated and trimmed, when the user picks another path', async () => {
    apkCandidates = [RELEASE_APK];
    script([
      // The last choice is "Enter another path…".
      [/Where is your Android APK/, (q: Question) => q.choices?.at(-1)?.name],
      [/Path to your Android APK/, '  ./custom/app.apk  '],
      [/package name/, 'com.acme.custom'],
    ]);

    const android = await configureAndroid(env);

    const q = question(/Path to your Android APK/);
    expect(q?.validate).toBeTypeOf('function');
    expect(q?.initial).toBeUndefined();
    expect(android.apkPath).toBe('./custom/app.apk');
    expect(android.packageName).toBe('com.acme.custom');
  });

  it('with no APK found, asks for its path with no placeholder default, and says how to build one', async () => {
    script([
      [/Where is your Android APK/, './built/app.apk'],
      [/package name/, 'com.acme.app'],
    ]);

    const android = await configureAndroid(env);

    const q = question(/Where is your Android APK/);
    expect(q?.type).toBe('input');
    expect(q?.initial).toBeUndefined();
    expect(q?.validate).toBeTypeOf('function');
    expect(logged.join('\n')).toMatch(/No APK found under android\//);
    expect(android.apkPath).toBe('./built/app.apk');
  });

  it('never defaults the package name to a placeholder when it cannot be read', async () => {
    apkCandidates = [DEBUG_APK];
    script([
      [/Where is your Android APK/, DEBUG_APK],
      [/package name/, ' com.acme.typed '],
    ]);

    const android = await configureAndroid(env);

    const q = question(/package name/);
    expect(q?.initial).toBeUndefined();
    expect(q?.validate?.('   ')).not.toBe(true);
    expect(android.packageName).toBe('com.acme.typed');
    expect(JSON.stringify(questions)).not.toContain('com.example');
  });

  it('warns with the PATH fix when ADB is missing', async () => {
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);

    await configureAndroid({ ...env, adbVersion: undefined });

    const out = logged.join('\n');
    expect(out).toMatch(/ADB not found/);
    expect(out).toContain('Install Android platform-tools');
  });

  it('names the installed platform-tools directory when adb is under ANDROID_HOME but not on PATH', async () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sdk-'));
    const platformTools = path.join(sdk, 'platform-tools');
    fs.mkdirSync(platformTools);
    fs.writeFileSync(path.join(platformTools, process.platform === 'win32' ? 'adb.exe' : 'adb'), '');
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);
    try {
      await configureAndroid({ ...env, adbVersion: undefined, androidHome: sdk });
    } finally {
      fs.rmSync(sdk, { recursive: true, force: true });
    }

    const out = logged.join('\n');
    expect(out).toContain(`adb is in ${platformTools} but not on PATH`);
    expect(out).toContain(`export PATH="${platformTools}:$PATH"`);
    expect(out).not.toMatch(/Install Android platform-tools/);
  });

  it('says nothing about ADB when it is present', async () => {
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);

    await configureAndroid(env);

    expect(logged.join('\n')).not.toMatch(/ADB/);
  });
});
