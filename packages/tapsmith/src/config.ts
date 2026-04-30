/**
 * Configuration for Tapsmith tests.
 *
 * Users create a `tapsmith.config.ts` at their project root:
 *
 *   import { defineConfig } from 'tapsmith';
 *   export default defineConfig({ timeout: 15000 });
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ReporterConfig } from './reporter.js';
import type { TraceMode, TraceConfig } from './trace/types.js';
import type { VideoMode, VideoConfig } from './video/types.js';

export type ScreenshotMode = 'always' | 'only-on-failure' | 'never';
export type DeviceStrategy = 'prefer-connected' | 'avd-only';
export type Platform = 'android' | 'ios';

export type { TraceMode, TraceConfig, VideoMode, VideoConfig };

export interface TapsmithConfig {
  /**
   * Target platform. Required for iOS; defaults to Android behavior when unset.
   */
  platform?: Platform;

  /** Path to the APK under test (Android). */
  apk?: string;

  /** Path to the .app bundle under test (iOS simulator). */
  app?: string;

  /**
   * Optional activity name to use when auto-launching the app under test.
   * Usually not needed. When unset, Tapsmith launches the package's default
   * launcher activity and falls back to resolving it automatically.
   */
  activity?: string;

  /** Default timeout for actions and assertions in milliseconds. */
  timeout: number;

  /** Number of times to retry a failed test. */
  retries: number;

  /** When to capture screenshots. */
  screenshot: ScreenshotMode;

  /** Glob patterns for discovering test files. */
  testMatch: string[];

  /** Address of the Tapsmith daemon. */
  daemonAddress: string;

  /** Path to the tapsmith-core binary. Defaults to 'tapsmith-core' (must be on PATH). */
  daemonBin?: string;

  /**
   * Target a specific device serial for single-device runs or debugging.
   * Prefer `avd` for parallel emulator provisioning.
   */
  device?: string;

  /**
   * How Tapsmith chooses devices when `device` is not explicitly set.
   * When unset, Tapsmith defaults to `avd-only` if `avd` is configured and
   * `prefer-connected` otherwise.
   * `prefer-connected` uses any healthy connected device first.
   * `avd-only` ignores non-matching devices and only uses the configured AVD.
   */
  deviceStrategy?: DeviceStrategy;

  /** Working directory for test discovery. */
  rootDir: string;

  /** Directory to write screenshots and artifacts to. */
  outputDir: string;

  /** Android package name of the app under test. Launched automatically before tests. */
  package?: string;

  /** Path to the Tapsmith agent APK. Used for auto-install if agent is not on device. */
  agentApk?: string;

  /** Path to the Tapsmith agent test APK. Used for auto-install if agent is not on device. */
  agentTestApk?: string;

  /** Path to the iOS agent .xctestrun file. Used for auto-launch of the iOS agent. */
  iosXctestrun?: string;

  /**
   * Optional deep link used to soft-reset the app between files on platforms
   * where hard restarts are slow or unstable. Intended for app-specific test
   * hooks such as a reset route in a first-party test app.
   */
  resetAppDeepLink?: string;

  /**
   * How long to wait after opening `resetAppDeepLink` before continuing.
   * Defaults to 750ms when the deep link is configured.
   */
  resetAppWaitMs?: number;

  /**
   * Delay in milliseconds between keystrokes when typing text.
   * Helps prevent dropped characters on slow CI simulators/emulators.
   * Defaults to 0 (no delay).
   */
  typingDelay?: number;

  /**
   * iOS simulator name or UDID. Analogous to `avd` for Android.
   * Run `xcrun simctl list devices` to see available simulators.
   */
  simulator?: string;

  /**
   * Test reporter configuration.
   *
   * Can be a reporter name ('list', 'dot', 'line', 'json', 'junit', 'html',
   * 'github', 'blob'), a tuple with options (['json', { outputFile: 'r.json' }]),
   * an array of these, or undefined for auto-detection (list locally, dot in CI).
   */
  reporter?: ReporterConfig;

  /**
   * Number of parallel workers. Each worker gets its own device and daemon.
   * Defaults to 1 (sequential execution).
   */
  workers: number;

  /**
   * Shard specification for splitting tests across CI machines.
   * Usually set via the `--shard=x/y` CLI flag.
   */
  shard?: { current: number; total: number };

  /**
   * Automatically launch emulators to fill the requested worker count.
   * When true, the dispatcher starts Android emulators for any workers that
   * don't already have a healthy connected device.
   * Defaults to true when `avd` is set, false otherwise.
   */
  launchEmulators: boolean;

  /**
   * Android Virtual Device (AVD) name to use when launching emulators.
   * When set, Tapsmith automatically launches emulator instances of this AVD
   * to fill the requested worker count. Set `launchEmulators: false` to disable.
   * Run `emulator -list-avds` to see available AVDs.
   */
  avd?: string;

  /**
   * Trace recording configuration.
   *
   * Can be a mode string ('off', 'on', 'retain-on-failure', etc.) or an
   * object with granular options. Defaults to 'off'.
   *
   * @example
   * // String shorthand
   * trace: 'on'
   *
   * @example
   * // Object form with granular control
   * trace: { mode: 'retain-on-failure', screenshots: true, snapshots: true }
   */
  trace?: TraceMode | Partial<TraceConfig>;

  /**
   * Continuous video recording of the device screen during test execution
   * (PILOT-114). Mirrors Playwright's `video` config.
   *
   * Defaults to `'off'`. The supported modes are the same as `trace`.
   *
   * Implementation: Android via `adb shell screenrecord` (3-min hard cap per
   * recording — videos beyond 3 minutes are truncated by the device-side
   * encoder); iOS Simulator via `xcrun simctl io recordVideo`; iOS physical
   * devices via `ffmpeg -f avfoundation` (requires `ffmpeg` on PATH).
   *
   * @example
   * // String shorthand
   * video: 'retain-on-failure'
   *
   * @example
   * // Object form — `size` is honoured on Android only; iOS records at
   * // native resolution and emits a one-time warning when `size` is set.
   * video: { mode: 'on', size: { width: 1280, height: 720 } }
   */
  video?: VideoMode | Partial<VideoConfig>;

  /**
   * Named test groups with dependency ordering, mirroring Playwright's projects.
   * Setup projects run first; dependent projects run after their dependencies complete.
   *
   * @example
   * projects: [
   *   { name: 'setup', testMatch: ['auth.setup.ts'] },
   *   { name: 'authenticated', dependencies: ['setup'], use: { appState: './auth.tar.gz' } },
   * ]
   */
  projects?: ProjectConfig[];

  /** Base URL for API requests made via the `request` fixture. */
  baseURL?: string;

  /**
   * Extra HTTP headers sent with every `request` fixture call.
   * Per-request headers override these when names collide.
   */
  extraHTTPHeaders?: Record<string, string>;

  /**
   * Run only tests whose fullName (`describe > test`) matches at least one of
   * these regular expressions. Mirrors Playwright's `grep` /  `--grep` CLI flag.
   * Combined with `grepInvert` via logical AND.
   */
  grep?: RegExp | RegExp[];

  /**
   * Skip tests whose fullName (`describe > test`) matches any of these regular
   * expressions. Mirrors Playwright's `grepInvert` / `--grep-invert` CLI flag.
   */
  grepInvert?: RegExp | RegExp[];
}

// ─── Per-scope option overrides ───

/**
 * Options that can be overridden per-describe via `test.use()` or per-project
 * via `projects[].use`.
 *
 * Device-shaping fields (`platform`, `avd`, `simulator`, `app`, `apk`, etc.)
 * may only be overridden at the project level — they have no effect from
 * `test.use()` since the device is bound to the worker before any test runs.
 */
export type UseOptions = Partial<Pick<TapsmithConfig,
  | 'timeout'
  | 'screenshot'
  | 'retries'
  | 'trace'
  | 'video'
  | 'platform'
  | 'device'
  | 'avd'
  | 'simulator'
  | 'apk'
  | 'app'
  | 'package'
  | 'activity'
  | 'agentApk'
  | 'agentTestApk'
  | 'iosXctestrun'
  | 'deviceStrategy'
  | 'launchEmulators'
  | 'resetAppDeepLink'
  | 'resetAppWaitMs'
  | 'baseURL'
  | 'extraHTTPHeaders'
>> & {
  /**
   * Path to a saved app state archive (created by `device.saveAppState()`).
   * When set, the runner restores this state before running tests in the scope,
   * mirroring Playwright's `storageState` pattern for reusable auth.
   */
  appState?: string;
}

/**
 * Merge a project's `use` options over the root config to produce the
 * effective configuration for running that project's tests. Undefined
 * project values are skipped so they don't clobber root defaults.
 */
export function effectiveConfigForProject(
  config: TapsmithConfig,
  project: { use?: UseOptions } | undefined,
): TapsmithConfig {
  if (!project?.use) return config;
  const merged = { ...config } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(project.use)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as unknown as TapsmithConfig;
}

// ─── Projects ───

export interface ProjectConfig {
  /** Unique project name, used for dependency references and reporter output. */
  name: string;
  /** Glob patterns for test file discovery. Inherits global `testMatch` if unset. */
  testMatch?: string[];
  /** Glob patterns to exclude from test file discovery. */
  testIgnore?: string[];
  /** Projects that must complete successfully before this project runs. */
  dependencies?: string[];
  /** Per-project option overrides applied as a base layer under file-level `test.use()`. */
  use?: UseOptions;
  /**
   * Number of parallel workers (devices) for this project. When unset,
   * the global `workers` budget is split proportionally across projects
   * that don't specify a count. Explicit values are additive — they don't
   * consume from the global budget.
   *
   * @example
   * projects: [
   *   { name: 'android', workers: 2, use: { platform: 'android', avd: 'Pixel_6' } },
   *   { name: 'ios',     workers: 1, use: { platform: 'ios', simulator: 'iPhone 16' } },
   * ]
   */
  workers?: number;
  /**
   * Per-project grep filter, intersected with the root `grep`. Mirrors
   * Playwright's per-project `grep`.
   */
  grep?: RegExp | RegExp[];
  /**
   * Per-project grep-invert filter, unioned with the root `grepInvert`.
   * Mirrors Playwright's per-project `grepInvert`.
   */
  grepInvert?: RegExp | RegExp[];
}

const DEFAULT_CONFIG: TapsmithConfig = {
  timeout: 30_000,
  retries: 0,
  screenshot: 'only-on-failure',
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  daemonAddress: 'localhost:50051',
  rootDir: process.cwd(),
  outputDir: 'tapsmith-results',
  workers: 1,
  launchEmulators: false,
};

/**
 * Define a Tapsmith configuration. Merges the provided overrides with defaults.
 */
export function defineConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  const merged = applyConfigDefaults({ ...DEFAULT_CONFIG, ...overrides }, overrides);
  return withExplicitWorkers(merged, overrides.workers !== undefined);
}

function applyConfigDefaults(
  config: TapsmithConfig,
  raw: Partial<TapsmithConfig>,
): TapsmithConfig {
  if (raw.launchEmulators === undefined && config.avd) {
    config.launchEmulators = true;
  }
  return config;
}

/**
 * Normalize a `grep` / `grepInvert` value (RegExp, RegExp[], or undefined)
 * into a plain RegExp[]. Returns an empty array when undefined.
 */
export function normalizeGrep(value: RegExp | RegExp[] | undefined): RegExp[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolve the effective device selection strategy for a config.
 * When an AVD is configured, default to using only that AVD unless the user
 * explicitly opts back into preferring already-connected devices.
 */
export function resolveDeviceStrategy(
  config: Pick<TapsmithConfig, 'deviceStrategy' | 'avd'>,
): DeviceStrategy {
  if (config.deviceStrategy) {
    return config.deviceStrategy;
  }
  return config.avd ? 'avd-only' : 'prefer-connected';
}

/**
 * Load tapsmith.config.ts from the given directory (or cwd). Falls back to
 * defaults if no config file exists.
 */
/**
 * Hidden symbol marking whether `workers` was explicitly set by the user
 * (in the config file or via CLI). Used by the multi-bucket budget warning
 * to distinguish "user asked for N" from "default of 1".
 */
export const EXPLICIT_WORKERS = Symbol.for('tapsmith.explicitWorkers');

function withExplicitWorkers(config: TapsmithConfig, explicit: boolean): TapsmithConfig {
  Object.defineProperty(config, EXPLICIT_WORKERS, {
    value: explicit,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return config;
}

export function isExplicitWorkers(config: TapsmithConfig): boolean {
  return (config as unknown as Record<symbol, boolean>)[EXPLICIT_WORKERS] === true;
}

/**
 * A user's raw config was "explicit" about workers if either (a) it went
 * through `defineConfig` which stamped the EXPLICIT_WORKERS symbol, or (b)
 * it's a plain object literal that directly set `workers`.
 *
 * Subtlety: we must check whether the symbol is *present* on `raw`, not
 * just its value. `defineConfig()` without a `workers` override stamps the
 * symbol to `false` AND populates `raw.workers = 1` from the default merge.
 * A naive `symbolValue || workers !== undefined` check would then treat
 * every `defineConfig({})` without a workers field as explicit — reintroducing
 * the spurious budget warning the symbol was designed to prevent.
 *
 * So: if the symbol is present at all on `raw`, trust its value (defineConfig
 * already did the right thing). Only fall back to "workers is defined on
 * raw" when the symbol is missing entirely — meaning the user exported a
 * raw object literal instead of using defineConfig.
 */
function rawHasExplicitWorkers(raw: Partial<TapsmithConfig>): boolean {
  const symbolPresent = Object.getOwnPropertySymbols(raw).includes(EXPLICIT_WORKERS);
  if (symbolPresent) return isExplicitWorkers(raw as TapsmithConfig);
  return raw.workers !== undefined;
}

export async function loadConfig(dir?: string, configFile?: string): Promise<TapsmithConfig> {
  const root = dir ?? process.cwd();

  if (configFile) {
    const configPath = path.resolve(root, configFile);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const mod = await import(configPath);
    const raw: Partial<TapsmithConfig> = mod.default ?? mod;
    const merged = applyConfigDefaults(
      { ...DEFAULT_CONFIG, ...raw, rootDir: raw.rootDir ?? root },
      raw,
    );
    return withExplicitWorkers(merged, rawHasExplicitWorkers(raw));
  }

  const candidates = ['tapsmith.config.ts', 'tapsmith.config.js', 'tapsmith.config.mjs'];

  for (const name of candidates) {
    const configPath = path.resolve(root, name);
    if (fs.existsSync(configPath)) {
      try {
        // For .ts files we rely on tsx / ts-node being available at runtime.
        const mod = await import(configPath);
        const raw: Partial<TapsmithConfig> = mod.default ?? mod;
        const merged = applyConfigDefaults(
          { ...DEFAULT_CONFIG, ...raw, rootDir: raw.rootDir ?? root },
          raw,
        );
        return withExplicitWorkers(merged, rawHasExplicitWorkers(raw));
      } catch (err) {
        console.warn(`Warning: failed to load ${configPath}: ${err}`);
      }
    }
  }

  return withExplicitWorkers({ ...DEFAULT_CONFIG, rootDir: root }, false);
}
