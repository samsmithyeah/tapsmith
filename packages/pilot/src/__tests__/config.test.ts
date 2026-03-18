import { describe, it, expect } from 'vitest';
import { defineConfig, type PilotConfig } from '../config.js';

describe('defineConfig()', () => {
  it('returns defaults when called with no arguments', () => {
    const config = defineConfig();
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
    expect(config.testMatch).toEqual(['**/*.test.ts', '**/*.spec.ts']);
    expect(config.daemonAddress).toBe('localhost:50051');
    expect(config.rootDir).toBe(process.cwd());
    expect(config.outputDir).toBe('pilot-results');
    expect(config.apk).toBeUndefined();
    expect(config.device).toBeUndefined();
    expect(config.daemonBin).toBeUndefined();
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
    expect(config.shard).toBeUndefined();
  });

  it('returns defaults when called with empty object', () => {
    const config = defineConfig({});
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
  });

  it('overrides timeout while keeping other defaults', () => {
    const config = defineConfig({ timeout: 15_000 });
    expect(config.timeout).toBe(15_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
  });

  it('overrides retries', () => {
    const config = defineConfig({ retries: 3 });
    expect(config.retries).toBe(3);
    expect(config.timeout).toBe(30_000);
  });

  it('overrides screenshot mode', () => {
    const config = defineConfig({ screenshot: 'always' });
    expect(config.screenshot).toBe('always');
  });

  it('overrides screenshot mode to never', () => {
    const config = defineConfig({ screenshot: 'never' });
    expect(config.screenshot).toBe('never');
  });

  it('overrides testMatch', () => {
    const config = defineConfig({ testMatch: ['**/*.pilot.ts'] });
    expect(config.testMatch).toEqual(['**/*.pilot.ts']);
  });

  it('overrides daemonAddress', () => {
    const config = defineConfig({ daemonAddress: 'remote:9090' });
    expect(config.daemonAddress).toBe('remote:9090');
  });

  it('overrides rootDir', () => {
    const config = defineConfig({ rootDir: '/custom/path' });
    expect(config.rootDir).toBe('/custom/path');
  });

  it('overrides outputDir', () => {
    const config = defineConfig({ outputDir: 'my-results' });
    expect(config.outputDir).toBe('my-results');
  });

  it('sets optional apk', () => {
    const config = defineConfig({ apk: '/path/to/app.apk' });
    expect(config.apk).toBe('/path/to/app.apk');
  });

  it('sets optional device', () => {
    const config = defineConfig({ device: 'emulator-5554' });
    expect(config.device).toBe('emulator-5554');
  });

  it('sets optional daemonBin', () => {
    const config = defineConfig({ daemonBin: '/usr/local/bin/pilot-core' });
    expect(config.daemonBin).toBe('/usr/local/bin/pilot-core');
  });

  it('overrides multiple fields at once', () => {
    const config = defineConfig({
      timeout: 10_000,
      retries: 2,
      screenshot: 'always',
      apk: 'app.apk',
      device: 'pixel6',
      daemonAddress: 'host:1234',
      rootDir: '/src',
      outputDir: 'out',
      testMatch: ['*.test.ts'],
    });
    expect(config.timeout).toBe(10_000);
    expect(config.retries).toBe(2);
    expect(config.screenshot).toBe('always');
    expect(config.apk).toBe('app.apk');
    expect(config.device).toBe('pixel6');
    expect(config.daemonAddress).toBe('host:1234');
    expect(config.rootDir).toBe('/src');
    expect(config.outputDir).toBe('out');
    expect(config.testMatch).toEqual(['*.test.ts']);
  });

  it('overrides workers and fullyParallel', () => {
    const config = defineConfig({ workers: 4, fullyParallel: true });
    expect(config.workers).toBe(4);
    expect(config.fullyParallel).toBe(true);
  });

  it('overrides shard', () => {
    const config = defineConfig({ shard: { current: 2, total: 4 } });
    expect(config.shard).toEqual({ current: 2, total: 4 });
  });

  it('returns a plain object (not frozen or sealed)', () => {
    const config = defineConfig();
    config.timeout = 999;
    expect(config.timeout).toBe(999);
  });

  it('does not share references between calls', () => {
    const a = defineConfig();
    const b = defineConfig();
    a.timeout = 1;
    expect(b.timeout).toBe(30_000);
  });
});
