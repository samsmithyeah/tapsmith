/**
 * Configuration for Pilot tests.
 *
 * Users create a `pilot.config.ts` at their project root:
 *
 *   import { defineConfig } from 'pilot';
 *   export default defineConfig({ timeout: 15000 });
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ReporterConfig } from './reporter.js';
import type { TraceMode, TraceConfig } from './trace/types.js';

export type ScreenshotMode = 'always' | 'only-on-failure' | 'never';
export type DeviceStrategy = 'prefer-connected' | 'avd-only';
export type Platform = 'android' | 'ios';

export type { TraceMode, TraceConfig };

export interface PilotConfig {
  /**
   * Target platform. Auto-detected from `apk` (Android) or `app` (iOS) if not set.
   */
  platform?: Platform;

  /** Path to the APK under test (Android). */
  apk?: string;

  /** Path to the .app bundle under test (iOS simulator). */
  app?: string;

  /**
   * Optional activity name to use when auto-launching the app under test.
   * Usually not needed. When unset, Pilot launches the package's default
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

  /** Address of the Pilot daemon. */
  daemonAddress: string;

  /** Path to the pilot-core binary. Defaults to 'pilot-core' (must be on PATH). */
  daemonBin?: string;

  /**
   * Target a specific device serial for single-device runs or debugging.
   * Prefer `avd` + `launchEmulators` for parallel emulator provisioning.
   */
  device?: string;

  /**
   * How Pilot chooses devices when `device` is not explicitly set.
   * When unset, Pilot defaults to `avd-only` if `avd` is configured and
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

  /** Path to the Pilot agent APK. Used for auto-install if agent is not on device. */
  agentApk?: string;

  /** Path to the Pilot agent test APK. Used for auto-install if agent is not on device. */
  agentTestApk?: string;

  /** Path to the iOS agent .xctestrun file. Used for auto-launch of the iOS agent. */
  iosXctestrun?: string;

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
   * Defaults to false.
   */
  launchEmulators: boolean;

  /**
   * Android Virtual Device (AVD) name to use when launching emulators.
   * Strongly recommended when `launchEmulators` is true so Pilot can launch
   * repeated instances of the same emulator definition for parallel runs.
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
}

// ─── Per-scope option overrides ───

/** Options that can be overridden per-describe via `test.use()` or per-project via `projects[].use`. */
export type UseOptions = Partial<Pick<PilotConfig, 'timeout' | 'screenshot' | 'retries' | 'trace'>> & {
  /**
   * Path to a saved app state archive (created by `device.saveAppState()`).
   * When set, the runner restores this state before running tests in the scope,
   * mirroring Playwright's `storageState` pattern for reusable auth.
   */
  appState?: string;
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
}

const DEFAULT_CONFIG: PilotConfig = {
  timeout: 30_000,
  retries: 0,
  screenshot: 'only-on-failure',
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  daemonAddress: 'localhost:50051',
  rootDir: process.cwd(),
  outputDir: 'pilot-results',
  workers: 1,
  launchEmulators: false,
};

/**
 * Define a Pilot configuration. Merges the provided overrides with defaults.
 */
export function defineConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Resolve the effective device selection strategy for a config.
 * When an AVD is configured, default to using only that AVD unless the user
 * explicitly opts back into preferring already-connected devices.
 */
export function resolveDeviceStrategy(
  config: Pick<PilotConfig, 'deviceStrategy' | 'avd'>,
): DeviceStrategy {
  if (config.deviceStrategy) {
    return config.deviceStrategy;
  }
  return config.avd ? 'avd-only' : 'prefer-connected';
}

/**
 * Load pilot.config.ts from the given directory (or cwd). Falls back to
 * defaults if no config file exists.
 */
export async function loadConfig(dir?: string, configFile?: string): Promise<PilotConfig> {
  const root = dir ?? process.cwd();

  if (configFile) {
    const configPath = path.resolve(root, configFile);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const mod = await import(configPath);
    const raw: Partial<PilotConfig> = mod.default ?? mod;
    return { ...DEFAULT_CONFIG, ...raw, rootDir: raw.rootDir ?? root };
  }

  const candidates = ['pilot.config.ts', 'pilot.config.js', 'pilot.config.mjs'];

  for (const name of candidates) {
    const configPath = path.resolve(root, name);
    if (fs.existsSync(configPath)) {
      try {
        // For .ts files we rely on tsx / ts-node being available at runtime.
        const mod = await import(configPath);
        const raw: Partial<PilotConfig> = mod.default ?? mod;
        return { ...DEFAULT_CONFIG, ...raw, rootDir: raw.rootDir ?? root };
      } catch (err) {
        console.warn(`Warning: failed to load ${configPath}: ${err}`);
      }
    }
  }

  return { ...DEFAULT_CONFIG, rootDir: root };
}
