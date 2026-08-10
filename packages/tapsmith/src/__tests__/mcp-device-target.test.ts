import { describe, it, expect } from 'vitest';
import { deviceClientFor } from '../mcp/tools/device-target.js';
import type { TestDispatcher } from '../mcp/test-dispatcher.js';

// A device tool used to fall back to the first pooled daemon whenever no
// `device` was given. A session holds one daemon per platform, so that answered
// for whichever platform resolved first — a screenshot taken while debugging an
// iOS failure could be the Android emulator's. `project` is how a caller says
// which it means: it is what run_tests already takes, and unlike a serial it is
// the same next session.

function dispatcherWith(projects: Array<{ name: string; platform?: string }>): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => projects.map((p) => p.name),
    getTestTree: () => [],
    getSessionInfo: () => ({
      timeout: 0,
      retries: 0,
      projects: projects.map((p) => ({
        name: p.name,
        platform: p.platform,
        testFiles: [],
        dependencies: [],
      })),
    }),
    toggleWatch: () => ({ enabled: false }),
  };
}

describe('deviceClientFor project routing', () => {
  it('rejects a project the config does not declare, and says what it does', async () => {
    const dispatcher = dispatcherWith([
      { name: 'android', platform: 'android' },
      { name: 'ios', platform: 'ios' },
    ]);
    await expect(deviceClientFor({ project: 'iOS' }, dispatcher)).rejects.toThrow(
      /Unknown project "iOS".*android, ios/s,
    );
  });

  it('says so when a config declares no projects at all', async () => {
    await expect(deviceClientFor({ project: 'ios' }, dispatcherWith([]))).rejects.toThrow(
      /declares none/,
    );
  });

  it('points at `device` when the session cannot resolve project names', async () => {
    // No dispatcher: the tool has no way to map a name to a platform, so the
    // caller needs the escape hatch rather than a confusing "unknown project".
    await expect(deviceClientFor({ project: 'ios' }, undefined)).rejects.toThrow(
      /Pass `device` instead/,
    );
  });
});
