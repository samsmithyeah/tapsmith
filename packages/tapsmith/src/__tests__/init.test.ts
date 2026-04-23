import { describe, it, expect } from 'vitest';
import { generateConfig, generateExampleTest } from '../init.js';

describe('generateConfig()', () => {
  it('generates single-platform Android config', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: './app.apk', packageName: 'com.example.app', useEmulators: true, avd: 'Pixel_7' },
      undefined,
      false,
    );

    expect(config).toContain("import { defineConfig } from 'tapsmith'");
    expect(config).toContain("package: 'com.example.app',");
    expect(config).toContain("apk: './app.apk',");
    expect(config).toContain('launchEmulators: true,');
    expect(config).toContain("avd: 'Pixel_7',");
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
      { apkPath: './app.apk', packageName: 'com.example.app', useEmulators: false },
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

  it('includes iOS device project when physical device configured', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', useEmulators: false },
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
      { apkPath: './app.apk', useEmulators: false },
      undefined,
      true,
    );

    expect(config).toContain("trace: { mode: 'retain-on-failure' },");
  });

  it('escapes single quotes in paths', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: "./path with 'quotes'/app.apk", packageName: 'com.example', useEmulators: false },
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
  });
});
