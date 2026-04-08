import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFileSync signatures make proper mock typing impractical
const mockedExecFileSync = vi.mocked(childProcess.execFileSync) as any;
const mockedSpawnSync = vi.mocked(childProcess.spawnSync);

import { freeStaleAgentPort } from '../port-utils.js';

// ─── Tests ───
//
// freeStaleAgentPort is safety-critical: it sends SIGKILL to PIDs found
// listening on a port. The pattern guard (`PilotAgen|pilot-core|xctest`) is
// the only thing preventing it from killing arbitrary user processes that
// happen to be on the chosen port. These tests pin that guard.

describe('freeStaleAgentPort', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spyOn on process.kill needs loose typing
  let killSpy: any;

  beforeEach(() => {
    vi.resetAllMocks();
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    // Force darwin path so lsof is used; spawnSync (linux fuser) returns empty.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  function mockPidsAndComm(pid: number, comm: string): void {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'lsof') return `${pid}\n`;
      if (cmd === 'ps' && args?.includes('comm=')) return `${comm}\n`;
      throw new Error(`unexpected cmd: ${cmd}`);
    });
    // Linux branch fallback (unused on darwin path but defined for safety)
    mockedSpawnSync.mockReturnValue({
      pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null,
    } as unknown as ReturnType<typeof childProcess.spawnSync>);
  }

  it('does nothing when no PIDs are listening on the port', () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'lsof') throw new Error('no process');
      throw new Error(`unexpected: ${cmd}`);
    });
    freeStaleAgentPort(18701);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills a stale PilotAgent process on the port', () => {
    mockPidsAndComm(12345, 'PilotAgentUITes');
    freeStaleAgentPort(18701);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  it('kills a stale pilot-core daemon on the port', () => {
    mockPidsAndComm(12345, 'pilot-core');
    freeStaleAgentPort(18701);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  it('kills a stale xctest runner on the port', () => {
    mockPidsAndComm(12345, 'xctest');
    freeStaleAgentPort(18701);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  // ─── Safety guard: never kill unrelated processes ───
  //
  // Each of these is a process name that could realistically be on the same
  // ephemeral port range as agent ports. The regex must reject all of them.

  it.each([
    ['node'],
    ['Node Helper'],
    ['bash'],
    ['zsh'],
    ['Slack Helper'],
    ['Google Chrome Helper'],
    ['Code Helper (Renderer)'],
    ['firefox'],
    ['Python'],
    ['ruby'],
    ['java'],
    ['ssh'],
    ['nginx'],
    ['postgres'],
    ['docker'],
    ['Discord Helper'],
    ['Spotify'],
  ])('does NOT kill unrelated process: %s', (comm) => {
    mockPidsAndComm(12345, comm);
    freeStaleAgentPort(18701);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('kills only the matching process when multiple PIDs share a port', () => {
    let psCallCount = 0;
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'lsof') return '111\n222\n333\n';
      if (cmd === 'ps') {
        psCallCount++;
        const pid = (args as string[])[1];
        // Only PID 222 is a stale PilotAgent; the others are unrelated.
        if (pid === '111') return 'node\n';
        if (pid === '222') return 'PilotAgentUITes\n';
        if (pid === '333') return 'Slack Helper\n';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    freeStaleAgentPort(18701);

    expect(psCallCount).toBe(3);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGKILL');
  });

  it('survives ps failures without killing anything', () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'lsof') return '12345\n';
      if (cmd === 'ps') throw new Error('process gone');
      throw new Error(`unexpected: ${cmd}`);
    });
    freeStaleAgentPort(18701);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
