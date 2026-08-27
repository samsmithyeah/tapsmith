import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

const mockedAppendFileSync = vi.mocked(fs.appendFileSync);
const mockedMkdirSync = vi.mocked(fs.mkdirSync);

import { timingEnabled, timingLog, timeSync, timeAsync, _resetTimingPathForTests } from '../timing.js';

const LOG_PATH = '/tmp/timing-test/run.log';

function lines(): string[] {
  return mockedAppendFileSync.mock.calls.map((call) => String(call[1]));
}

describe('timing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTimingPathForTests();
    delete process.env.TAPSMITH_TIMING_LOG;
  });

  afterEach(() => {
    delete process.env.TAPSMITH_TIMING_LOG;
    _resetTimingPathForTests();
  });

  describe('when TAPSMITH_TIMING_LOG is unset', () => {
    it('is disabled and writes nothing', () => {
      expect(timingEnabled()).toBe(false);
      timingLog('kind=provision name=x dur_ms=1');
      expect(mockedAppendFileSync).not.toHaveBeenCalled();
    });

    it('still runs and returns the timed callee', () => {
      expect(timeSync('provision', 'x', () => 42)).toBe(42);
      expect(mockedAppendFileSync).not.toHaveBeenCalled();
    });
  });

  describe('when TAPSMITH_TIMING_LOG is set', () => {
    beforeEach(() => {
      process.env.TAPSMITH_TIMING_LOG = LOG_PATH;
    });

    it('creates the parent directory once and appends a tagged line', () => {
      timingLog('kind=provision name=simctl_list dur_ms=7 ok=true');
      timingLog('kind=provision name=simctl_boot dur_ms=9 ok=true');

      expect(mockedMkdirSync).toHaveBeenCalledTimes(1);
      expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/timing-test', { recursive: true });
      // Same line shape as the daemon's timing.rs, so one log aggregates both.
      expect(lines()[0]).toBe(
        `[TIMING] pid=${process.pid} kind=provision name=simctl_list dur_ms=7 ok=true\n`,
      );
      expect(mockedAppendFileSync.mock.calls[0][0]).toBe(LOG_PATH);
    });

    it('logs ok=true with a duration for a successful call', () => {
      expect(timeSync('provision', 'work', () => 'done')).toBe('done');
      expect(lines()[0]).toMatch(/kind=provision name=work dur_ms=\d+ ok=true\n$/);
    });

    it('logs ok=false and rethrows when the timed call throws', () => {
      expect(() => timeSync('provision', 'work', () => {
        throw new Error('boom');
      })).toThrow('boom');
      expect(lines()[0]).toMatch(/kind=provision name=work dur_ms=\d+ ok=false\n$/);
    });

    it('times async calls the same way', async () => {
      await expect(timeAsync('provision', 'async_work', async () => 'ok')).resolves.toBe('ok');
      expect(lines()[0]).toMatch(/kind=provision name=async_work dur_ms=\d+ ok=true\n$/);

      await expect(timeAsync('provision', 'async_fail', async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect(lines()[1]).toMatch(/kind=provision name=async_fail dur_ms=\d+ ok=false\n$/);
    });

    it('never lets a write failure break the caller', () => {
      mockedAppendFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      expect(() => timingLog('kind=provision name=x dur_ms=1')).not.toThrow();
      expect(timeSync('provision', 'x', () => 1)).toBe(1);
    });
  });
});
