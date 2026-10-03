/**
 * init's simulator agent step delegates to the runtime builder (PILOT-393):
 * the same SDK-matched cache the first test run reads, quiet so `init --json`
 * keeps a clean stdout, and init's five-minute bound.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findSimulatorXctestrun, ensureSimulatorAgent } = vi.hoisted(() => ({
  findSimulatorXctestrun: vi.fn<() => string | undefined>(),
  ensureSimulatorAgent: vi.fn<(options?: { quiet?: boolean; timeoutMs?: number }) => Promise<string>>(),
}));

vi.mock('../ios-device-resolve.js', () => ({ findSimulatorXctestrun }));
vi.mock('../ios-simulator-build.js', () => ({ ensureSimulatorAgent }));

const { initSimulatorAgent, needsSimulatorAgent } = await import('../init.js');

const CACHED = '/home/.tapsmith/ios-simulator-agent/TapsmithAgentUITests_iphonesimulator27.0-arm64.xctestrun';

beforeEach(() => {
  findSimulatorXctestrun.mockReset();
  ensureSimulatorAgent.mockReset();
});

describe('initSimulatorAgent()', () => {
  it('builds through the runtime builder, quietly and with init\'s bound', async () => {
    findSimulatorXctestrun.mockReturnValue(undefined);
    ensureSimulatorAgent.mockResolvedValue(CACHED);
    expect(await initSimulatorAgent()).toEqual({ status: 'built' });
    expect(ensureSimulatorAgent).toHaveBeenCalledWith({ quiet: true, timeoutMs: 300_000 });
  });

  it('reports present when the builder keeps the existing build', async () => {
    findSimulatorXctestrun.mockReturnValue(CACHED);
    ensureSimulatorAgent.mockResolvedValue(CACHED);
    expect(await initSimulatorAgent()).toEqual({ status: 'present' });
  });

  it('reports built when an SDK-mismatched build was replaced', async () => {
    findSimulatorXctestrun.mockReturnValue('/old/TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun');
    ensureSimulatorAgent.mockResolvedValue(CACHED);
    expect(await initSimulatorAgent()).toEqual({ status: 'built' });
  });

  it('returns the builder\'s whole failure message', async () => {
    const message = 'Failed to build iOS simulator agent from source: xcodebuild build-for-testing failed (exit code 65)\n'
      + '  /src/Agent.swift:12:5: error: cannot find \'foo\' in scope\n'
      + 'Full build log: /home/.tapsmith/ios-simulator-agent/xcodebuild.log';
    findSimulatorXctestrun.mockReturnValue(undefined);
    ensureSimulatorAgent.mockRejectedValue(new Error(message));
    expect(await initSimulatorAgent()).toEqual({ status: 'failed', error: message });
  });
});

// PILOT-465: both init paths build the simulator agent only for a plan with
// an iOS simulator target, the same rule generateConfig() writes one by.
describe('needsSimulatorAgent()', () => {
  const sim = { appPath: './ios/MyApp.app', bundleId: 'com.example.myapp', simulator: 'iPhone 17' };

  it('builds for a simulator-only plan', () => {
    expect(needsSimulatorAgent({ ...sim, usePhysicalDevice: false })).toBe(true);
  });

  it('skips a physical-only plan', () => {
    expect(needsSimulatorAgent({
      bundleId: 'com.example.myapp', usePhysicalDevice: true, deviceAppPath: './ios/Release-iphoneos/MyApp.app',
    })).toBe(false);
  });

  it('builds for a mixed simulator and physical plan', () => {
    expect(needsSimulatorAgent({ ...sim, usePhysicalDevice: true, deviceAppPath: './ios/Release-iphoneos/MyApp.app' })).toBe(true);
  });

  it('skips a plan without iOS', () => {
    expect(needsSimulatorAgent(undefined)).toBe(false);
  });
});
