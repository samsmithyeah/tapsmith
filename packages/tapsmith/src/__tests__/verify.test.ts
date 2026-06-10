import { describe, it, expect } from 'vitest';
import { parseVerifyArgs, pickVerifyTarget, summarizeVerifyReport } from '../verify.js';

describe('parseVerifyArgs()', () => {
  it('parses --json and --config', () => {
    expect(parseVerifyArgs(['--json', '--config', 't.config.ts'])).toEqual({ json: true, config: 't.config.ts' });
    expect(parseVerifyArgs(['--config=t.config.ts'])).toEqual({ json: false, config: 't.config.ts' });
    expect(parseVerifyArgs([])).toEqual({ json: false, config: undefined });
  });

  it('throws on unknown flags', () => {
    expect(() => parseVerifyArgs(['--bogus'])).toThrow(/unknown/i);
  });
});

describe('pickVerifyTarget()', () => {
  it('prefers example.test.ts', () => {
    const files = ['/p/tests/login.test.ts', '/p/tests/example.test.ts'];
    expect(pickVerifyTarget(files)).toBe('/p/tests/example.test.ts');
  });

  it('falls back to the first file', () => {
    expect(pickVerifyTarget(['/p/tests/b.test.ts', '/p/tests/a.test.ts'])).toBe('/p/tests/b.test.ts');
  });

  it('returns undefined for empty list', () => {
    expect(pickVerifyTarget([])).toBeUndefined();
  });
});

describe('summarizeVerifyReport()', () => {
  const report = {
    stats: { total: 2, passed: 1, failed: 1, skipped: 0, duration: 4200, startTime: '2026-06-10T00:00:00Z' },
    suites: [{
      name: 'example.test.ts',
      duration: 4200,
      tests: [
        { name: 'a', fullName: 'a', status: 'passed' as const, duration: 2000 },
        { name: 'b', fullName: 'b', status: 'failed' as const, duration: 2200, error: { message: 'boom' }, screenshotPath: '/s.png' },
      ],
      suites: [],
    }],
  };

  it('flattens failures from nested suites', () => {
    const summary = summarizeVerifyReport(report);
    expect(summary).toMatchObject({ ok: false, passed: 1, failed: 1, skipped: 0, duration: 4200 });
    expect(summary.failures).toEqual([{ fullName: 'b', error: 'boom', screenshotPath: '/s.png' }]);
  });

  it('reports ok on all-pass', () => {
    const allPass = { ...report, stats: { ...report.stats, failed: 0 }, suites: [{ ...report.suites[0], tests: [report.suites[0].tests[0]] }] };
    expect(summarizeVerifyReport(allPass).ok).toBe(true);
  });
});
