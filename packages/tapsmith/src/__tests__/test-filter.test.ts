import { describe, it, expect } from 'vitest';
import { findSelectionMiss, matchesTestFilter, noTestsMatchFilterMessage, passesSelectionFilters } from '../test-filter.js';

describe('matchesTestFilter', () => {
  const fullName = 'Login screen > submits the form';

  it('matches an exact full name', () => {
    expect(matchesTestFilter(fullName, 'Login screen > submits the form')).toBe(true);
  });

  it('matches a describe prefix', () => {
    expect(matchesTestFilter(fullName, 'Login screen')).toBe(true);
  });

  it('matches a bare substring of the test name (no describe prefix)', () => {
    expect(matchesTestFilter(fullName, 'submits the form')).toBe(true);
    expect(matchesTestFilter(fullName, 'submits')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesTestFilter(fullName, 'SUBMITS THE FORM')).toBe(true);
    expect(matchesTestFilter(fullName, 'login screen')).toBe(true);
  });

  it('does not match an unrelated string', () => {
    expect(matchesTestFilter(fullName, 'logout')).toBe(false);
  });

  it('does not match on a typo', () => {
    expect(matchesTestFilter(fullName, 'submit form')).toBe(false);
  });

  it('treats an empty filter as a match (caller decides whether to apply it)', () => {
    expect(matchesTestFilter(fullName, '')).toBe(true);
  });
});

describe('passesSelectionFilters', () => {
  it('passes everything with no filter', () => {
    expect(passesSelectionFilters('a > b', {})).toBe(true);
  });

  it('intersects root and project grep and unions the inverts', () => {
    const filters = { grep: [/smoke/], projectGrep: [/android/], grepInvert: [/wip/], projectGrepInvert: [/slow/] };
    expect(passesSelectionFilters('smoke android', filters)).toBe(true);
    expect(passesSelectionFilters('smoke ios', filters)).toBe(false);
    expect(passesSelectionFilters('smoke android wip', filters)).toBe(false);
    expect(passesSelectionFilters('smoke android slow', filters)).toBe(false);
  });

  it('is not thrown off by a stateful global regex', () => {
    const filters = { grep: [/smoke/g] };
    expect(passesSelectionFilters('smoke', filters)).toBe(true);
    expect(passesSelectionFilters('smoke', filters)).toBe(true);
  });
});

describe('findSelectionMiss', () => {
  const names: Record<string, string[]> = {
    '/p/a.test.ts': ['logs in', 'checkout > pays'],
    '/p/b.test.ts': ['signs up'],
    '/p/e.test.ts': [],
  };
  const namesOf = (file: string): string[] | undefined => names[file];

  it('returns undefined as soon as a test passes the filters', () => {
    expect(findSelectionMiss([
      { file: '/p/a.test.ts', filters: { grep: [/checkout > pays/] } },
      { file: '/p/b.test.ts', filters: { grep: [/checkout > pays/] } },
    ], namesOf)).toBeUndefined();
  });

  it('reports the tests it checked when nothing passes', () => {
    expect(findSelectionMiss([
      { file: '/p/a.test.ts', filters: { grep: [/zzzz/] } },
      { file: '/p/b.test.ts', filters: { grep: [/zzzz/] } },
    ], namesOf)).toEqual({ fileCount: 2, testNames: ['logs in', 'checkout > pays', 'signs up'] });
  });

  it('applies each entry its own filters (a file in two projects)', () => {
    expect(findSelectionMiss([
      { file: '/p/b.test.ts', filters: { projectGrep: [/ios/] } },
      { file: '/p/b.test.ts', filters: { projectGrep: [/signs/] } },
    ], namesOf)).toBeUndefined();
  });

  it('cannot conclude anything when a file fails to load: the run reports that file', () => {
    expect(findSelectionMiss([
      { file: '/p/a.test.ts', filters: { grep: [/zzzz/] } },
      { file: '/p/broken.test.ts', filters: { grep: [/zzzz/] } },
    ], namesOf)).toBeUndefined();
  });

  it('reports a run whose files hold no tests at all', () => {
    expect(findSelectionMiss([{ file: '/p/e.test.ts', filters: { grep: [/x/] } }], namesOf))
      .toEqual({ fileCount: 1, testNames: [] });
  });
});

describe('noTestsMatchFilterMessage', () => {
  it('names the filters, what was checked and the tests there are', () => {
    const message = noTestsMatchFilterMessage(
      { fileCount: 2, testNames: ['logs in', 'checkout > pays'] },
      /zzzz/,
      [/wip/, /slow/i],
    );
    expect(message).toMatch(/^No tests found: no test matches grep \/zzzz\/, grep-invert \/wip\/, \/slow\/i\./);
    expect(message).toContain('Checked 2 tests in 2 test files');
    expect(message).toContain('"describe > test"');
    expect(message).toContain('  - logs in\n  - checkout > pays');
  });

  it('points at project filters when the root has none', () => {
    expect(noTestsMatchFilterMessage({ fileCount: 1, testNames: ['a'] }, undefined, undefined))
      .toMatch(/^No tests found: no test matches the projects' grep \/ grepInvert\./);
  });

  it('lists at most ten tests', () => {
    const names = Array.from({ length: 14 }, (_, i) => `t${i}`);
    const message = noTestsMatchFilterMessage({ fileCount: 1, testNames: names }, /x/, undefined);
    expect(message).toContain('  - t9\n  … and 4 more');
    expect(message).not.toContain('t10');
  });

  it('says so when the files hold no tests', () => {
    expect(noTestsMatchFilterMessage({ fileCount: 3, testNames: [] }, /x/, undefined))
      .toContain('The 3 test files hold no tests.');
  });
});
