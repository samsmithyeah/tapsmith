import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateConfig, generateExampleTest, runInit } from '../init.js';
import type { InitCommandOptions } from '../cli-program.js';

describe('generateConfig()', () => {
  it('generates single-platform Android config', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: './app.apk', packageName: 'com.example.app', useEmulators: true, usePhysicalDevices: false, avd: 'Pixel_7' },
      undefined,
      false,
    );

    expect(config).toContain("import { defineConfig } from 'tapsmith'");
    expect(config).toContain("package: 'com.example.app',");
    expect(config).toContain("apk: './app.apk',");
    expect(config).toContain("avd: 'Pixel_7',");
    expect(config).not.toContain('launchEmulators');
    expect(config).not.toContain('projects');
    expect(config).not.toContain('trace');
  });

  it('generates single-platform iOS config', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      { appPath: './MyApp.app', bundleId: 'com.example.app', simulator: 'iPhone 17', usePhysicalDevice: false },
      false,
    );

    expect(config).toContain("app: './MyApp.app',");
    expect(config).toContain("simulator: 'iPhone 17',");
    expect(config).not.toContain('projects');
  });

  it('generates dual-platform config with projects', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', packageName: 'com.example.app', useEmulators: false, usePhysicalDevices: true },
      { appPath: './MyApp.app', bundleId: 'com.example.app', simulator: 'iPhone 17', usePhysicalDevice: false },
      true,
    );

    expect(config).toContain('projects: [');
    expect(config).toContain("name: 'android',");
    expect(config).toContain("name: 'ios',");
    expect(config).toContain("platform: 'android',");
    expect(config).toContain("platform: 'ios',");
    expect(config).toContain("trace: { mode: 'retain-on-failure' },");
  });

  it('puts package name per-project in dual-platform config', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', packageName: 'com.example.android', useEmulators: false, usePhysicalDevices: true },
      { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: false },
      false,
    );

    expect(config).not.toMatch(/^  package:/m);
    expect(config).toContain("package: 'com.example.android',");
    expect(config).toContain("package: 'com.example.ios',");
  });

  it('includes iOS device project when physical device configured', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', useEmulators: false, usePhysicalDevices: true },
      {
        appPath: './MyApp.app',
        simulator: 'iPhone 17',
        usePhysicalDevice: true,
        deviceAppPath: './MyApp-device.app',
      },
      false,
    );

    expect(config).toContain("name: 'ios-device',");
    expect(config).toContain('workers: 1,');
    expect(config).toContain("app: './MyApp-device.app',");
  });

  it('includes network tracing when enabled', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: './app.apk', useEmulators: false, usePhysicalDevices: true },
      undefined,
      true,
    );

    expect(config).toContain("trace: { mode: 'retain-on-failure' },");
  });

  it('escapes single quotes in paths', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: "./path with 'quotes'/app.apk", packageName: 'com.example', useEmulators: false, usePhysicalDevices: true },
      undefined,
      false,
    );

    expect(config).toContain("apk: './path with \\'quotes\\'/app.apk',");
    expect(config).not.toContain("apk: './path with 'quotes'/app.apk',");
  });
});

describe('generateExampleTest()', () => {
  it('generates valid test file', () => {
    const test = generateExampleTest();

    expect(test).toContain("import { test, expect } from 'tapsmith'");
    expect(test).toContain('test(');
    expect(test).toContain('async ({ device })');
    expect(test).toContain('toBeVisible');
    // Must use a real role — 'any' is not a known role and throws at runtime,
    // which would make every scaffolded project / `tapsmith verify` fail.
    expect(test).not.toContain("getByRole('any')");
    expect(test).toContain("getByRole('text')");
  });
});

// ─── --json never runs the wizard (PILOT-270, PILOT-266 item 1) ───

describe('runInit() --json without --yes', () => {
  const opts = (over: Partial<InitCommandOptions> = {}): InitCommandOptions => ({
    yes: false, json: true, force: false, networkCapture: false, exampleTest: true, agentsMd: true, ...over,
  });
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  afterEach(() => {
    vi.restoreAllMocks();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  async function run(isTTY: boolean, over: Partial<InitCommandOptions> = {}): Promise<{ out: string; exit: unknown }> {
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const exit = await runInit(opts(over)).then(() => undefined, (err: unknown) => (err as Error).message);
    return { out, exit };
  }

  it('in a terminal, refuses with JSON_REQUIRES_YES instead of starting the interactive wizard', async () => {
    const { out, exit } = await run(true);
    expect(exit).toBe('exit 1');
    expect(JSON.parse(out)).toEqual({
      error: { code: 'JSON_REQUIRES_YES', message: expect.stringContaining('--json'), fix: expect.stringContaining('npx tapsmith init --yes --json') },
    });
  });

  it('in a terminal, a setup flag without --yes runs non-interactively instead of refusing', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-tty-')));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const { out, exit } = await run(true, { platform: 'android', apk: path.join(dir, 'missing.apk') });
      expect(exit).toBe('exit 1');
      const code = (JSON.parse(out) as { error: { code: string } }).error.code;
      expect(code).not.toBe('JSON_REQUIRES_YES');
      expect(code).not.toBe('NON_INTERACTIVE_TTY');
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a terminal, keeps reporting NON_INTERACTIVE_TTY', async () => {
    const { out, exit } = await run(false);
    expect(exit).toBe('exit 1');
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('NON_INTERACTIVE_TTY');
  });
});
