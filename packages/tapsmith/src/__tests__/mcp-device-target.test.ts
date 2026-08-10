import { describe, it, expect } from 'vitest';
import { deviceClientFor } from '../mcp/tools/device-target.js';
import { selectProjectDevice, retiredUiConnections } from '../mcp/connection.js';
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

describe('selectProjectDevice', () => {
  const android = { serial: 'EMU-1', platform: 'android' };
  const ios = { serial: 'SIM-1', platform: 'ios' };

  it('picks the device for the project\'s platform', () => {
    expect(selectProjectDevice([android, ios], { name: 'ios', platform: 'ios' }))
      .toEqual({ serial: 'SIM-1' });
  });

  // A root config that declares no platform gives its projects none either.
  // Reading that as "no project was named" fell through to the generic path,
  // whose message tells the caller to pass the `project` they just passed.
  it('treats a project with no platform as matching the session\'s unqualified device', () => {
    expect(selectProjectDevice([{ serial: 'SIM-1' }], { name: 'smoke' }))
      .toEqual({ serial: 'SIM-1' });
  });

  it('does not let a platform-less project match a platform-bound device', () => {
    const chosen = selectProjectDevice([android, ios], { name: 'smoke' });
    expect(chosen).toEqual({ error: expect.stringContaining('no device for project "smoke"') });
  });

  it('names the project, not just the platform, when there is no such device', () => {
    const chosen = selectProjectDevice([android], { name: 'ios', platform: 'ios' });
    expect(chosen).toEqual({ error: expect.stringContaining('no ios device for project "ios"') });
  });

  it('asks for a serial when one platform has several devices', () => {
    const chosen = selectProjectDevice(
      [android, { serial: 'EMU-2', platform: 'android' }],
      { name: 'android', platform: 'android' },
    );
    expect(chosen).toEqual({ error: expect.stringContaining('EMU-1, EMU-2') });
  });
});

// A UI worker that dies mid-run is retired and its daemon killed, but its
// connection kept the `preparedDevice` it was handed at discovery — and that is
// what `sessionTargetDevices` reads. So a two-worker session that lost one went
// on reporting two devices, refusing every device tool as ambiguous over a
// serial that no `device` or `project` argument could route to.
describe('retiredUiConnections', () => {
  const a = { address: '127.0.0.1:50151', source: 'ui' };
  const b = { address: '127.0.0.1:50152', source: 'ui' };

  it('drops a UI connection the server no longer lists', () => {
    expect(retiredUiConnections([a, b], [{ address: a.address }])).toEqual([b]);
  });

  it('keeps every UI connection while the server still lists it', () => {
    expect(retiredUiConnections([a, b], [{ address: a.address }, { address: b.address }]))
      .toEqual([]);
  });

  // The worker list says nothing about a daemon we started, adopted, or were
  // configured with — none of them appear in it even while perfectly alive.
  it('never drops a connection from another source', () => {
    const ours = [
      { address: '127.0.0.1:50051', source: 'started' },
      { address: '127.0.0.1:50052', source: 'peer' },
      { address: '127.0.0.1:50053', source: 'orphan' },
      { address: '127.0.0.1:50054', source: 'configured' },
    ];
    expect(retiredUiConnections(ours, [])).toEqual([]);
  });
});
