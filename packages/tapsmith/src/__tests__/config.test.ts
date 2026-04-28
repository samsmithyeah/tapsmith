import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineConfig,
  resolveDeviceStrategy,
  isExplicitWorkers,
  loadConfig,
} from '../config.js';

describe('defineConfig()', () => {
  it('returns defaults when called with no arguments', () => {
    const config = defineConfig();
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
    expect(config.testMatch).toEqual(['**/*.test.ts', '**/*.spec.ts']);
    expect(config.daemonAddress).toBe('localhost:50051');
    expect(config.rootDir).toBe(process.cwd());
    expect(config.outputDir).toBe('tapsmith-results');
    expect(config.apk).toBeUndefined();
    expect(config.activity).toBeUndefined();
    expect(config.device).toBeUndefined();
    expect(config.deviceStrategy).toBeUndefined();
    expect(config.daemonBin).toBeUndefined();
    expect(config.workers).toBe(1);
    expect(config.shard).toBeUndefined();
    expect(config.launchEmulators).toBe(false);
    expect(config.avd).toBeUndefined();
  });

  it('returns defaults when called with empty object', () => {
    const config = defineConfig({});
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(0);
    expect(config.screenshot).toBe('only-on-failure');
  });

  it('defaults launchEmulators to true when avd is set', () => {
    const config = defineConfig({ avd: 'Pixel_9_API_35' });
    expect(config.launchEmulators).toBe(true);
  });

  it('respects explicit launchEmulators: false when avd is set', () => {
    const config = defineConfig({ avd: 'Pixel_9_API_35', launchEmulators: false });
    expect(config.launchEmulators).toBe(false);
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
    const config = defineConfig({ testMatch: ['**/*.tapsmith.ts'] });
    expect(config.testMatch).toEqual(['**/*.tapsmith.ts']);
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

  it('sets optional activity', () => {
    const config = defineConfig({ activity: 'com.example.app.MainActivity' });
    expect(config.activity).toBe('com.example.app.MainActivity');
  });

  it('sets optional device', () => {
    const config = defineConfig({ device: 'emulator-5554' });
    expect(config.device).toBe('emulator-5554');
  });

  it('sets optional daemonBin', () => {
    const config = defineConfig({ daemonBin: '/usr/local/bin/tapsmith-core' });
    expect(config.daemonBin).toBe('/usr/local/bin/tapsmith-core');
  });

  it('overrides multiple fields at once', () => {
    const config = defineConfig({
      timeout: 10_000,
      retries: 2,
      screenshot: 'always',
      apk: 'app.apk',
      activity: 'com.example.app.MainActivity',
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
    expect(config.activity).toBe('com.example.app.MainActivity');
    expect(config.device).toBe('pixel6');
    expect(config.daemonAddress).toBe('host:1234');
    expect(config.rootDir).toBe('/src');
    expect(config.outputDir).toBe('out');
    expect(config.testMatch).toEqual(['*.test.ts']);
  });

  it('overrides workers', () => {
    const config = defineConfig({ workers: 4 });
    expect(config.workers).toBe(4);
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

  it('allows explicit deviceStrategy override', () => {
    const config = defineConfig({ deviceStrategy: 'prefer-connected' });
    expect(config.deviceStrategy).toBe('prefer-connected');
  });
});

describe('isExplicitWorkers() / loadConfig()', () => {
  it('defineConfig({}) is not explicit about workers', () => {
    expect(isExplicitWorkers(defineConfig())).toBe(false);
  });

  it('defineConfig({ workers: 2 }) is explicit about workers', () => {
    expect(isExplicitWorkers(defineConfig({ workers: 2 }))).toBe(true);
  });

  async function withTempConfig<T>(
    contents: string,
    fileName: string,
    fn: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'tapsmith-config-test-'));
    try {
      writeFileSync(join(dir, fileName), contents);
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('loadConfig flags a raw object-literal config with workers as explicit', async () => {
    // Catches the regression where users who export a plain object literal
    // (not via defineConfig) lose explicit-workers detection because the
    // Symbol-based flag is only stamped inside defineConfig.
    const contents = 'export default { workers: 3 };\n';
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.workers).toBe(3);
      expect(isExplicitWorkers(config)).toBe(true);
    });
  });

  it('loadConfig does not flag a raw object-literal config without workers', async () => {
    const contents = 'export default { timeout: 5000 };\n';
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.timeout).toBe(5000);
      expect(isExplicitWorkers(config)).toBe(false);
    });
  });

  // The fixtures below simulate what `defineConfig` produces without
  // actually importing it — the dynamic import in loadConfig can't resolve
  // the tapsmith package's .ts source from a temp-dir .mjs fixture. Since
  // EXPLICIT_WORKERS is `Symbol.for('tapsmith.explicitWorkers')`, any module
  // can stamp it via Symbol.for and loadConfig's check will see the same
  // symbol. This tests the whole path that matters: "symbol survives the
  // loadConfig spread, rawHasExplicitWorkers trusts it when present".

  it('loadConfig preserves explicit-workers=true when defineConfig stamped the symbol', async () => {
    const contents = `
      const EXPLICIT_WORKERS = Symbol.for('tapsmith.explicitWorkers');
      const config = { workers: 4 };
      Object.defineProperty(config, EXPLICIT_WORKERS, { value: true, enumerable: false });
      export default config;
    `;
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.workers).toBe(4);
      expect(isExplicitWorkers(config)).toBe(true);
    });
  });

  it('loadConfig reports NOT explicit when defineConfig was called without a workers override', async () => {
    // Regression: defineConfig({}) stamps the symbol to false AND populates
    // workers=1 from the default merge. A naive "workers !== undefined"
    // fallback would misclassify this as explicit and fire the spurious
    // budget warning on every config that relies on per-project `workers:`
    // overrides instead of a top-level one.
    const contents = `
      const EXPLICIT_WORKERS = Symbol.for('tapsmith.explicitWorkers');
      // Simulate defineConfig({ timeout: 5000 }) — defaults merged in,
      // symbol stamped to false because the user didn't set workers.
      const config = { timeout: 5000, workers: 1 };
      Object.defineProperty(config, EXPLICIT_WORKERS, { value: false, enumerable: false });
      export default config;
    `;
    await withTempConfig(contents, 'tapsmith.config.mjs', async (dir) => {
      const config = await loadConfig(dir);
      expect(config.timeout).toBe(5000);
      expect(config.workers).toBe(1);
      expect(isExplicitWorkers(config)).toBe(false);
    });
  });
});

describe('resolveDeviceStrategy()', () => {
  it('defaults to prefer-connected when avd is not set', () => {
    expect(resolveDeviceStrategy(defineConfig())).toBe('prefer-connected');
  });

  it('defaults to avd-only when avd is set', () => {
    expect(resolveDeviceStrategy(defineConfig({ avd: 'Pixel_9_API_35' }))).toBe('avd-only');
  });

  it('respects explicit override when avd is set', () => {
    expect(
      resolveDeviceStrategy(
        defineConfig({ avd: 'Pixel_9_API_35', deviceStrategy: 'prefer-connected' }),
      ),
    ).toBe('prefer-connected');
  });
});
