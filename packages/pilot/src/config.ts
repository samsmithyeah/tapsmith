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

export type ScreenshotMode = 'always' | 'only-on-failure' | 'never';

export interface PilotConfig {
  /** Path to the APK under test. */
  apk?: string;

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

  /** Target device serial. If unset, daemon picks the first available. */
  device?: string;

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
}

const DEFAULT_CONFIG: PilotConfig = {
  timeout: 30_000,
  retries: 0,
  screenshot: 'only-on-failure',
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  daemonAddress: 'localhost:50051',
  rootDir: process.cwd(),
  outputDir: 'pilot-results',
};

/**
 * Define a Pilot configuration. Merges the provided overrides with defaults.
 */
export function defineConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Load pilot.config.ts from the given directory (or cwd). Falls back to
 * defaults if no config file exists.
 */
export async function loadConfig(dir?: string): Promise<PilotConfig> {
  const root = dir ?? process.cwd();
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
