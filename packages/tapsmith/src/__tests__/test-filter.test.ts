import { describe, it, expect } from 'vitest';
import { isFilteredOutSkip, matchesTestFilter } from '../test-filter.js';

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

describe('isFilteredOutSkip', () => {
  it('drops the synthetic skip of a test outside the filter', () => {
    expect(isFilteredOutSkip({ status: 'skipped', fullName: 'other > t' }, 'share')).toBe(true);
  });

  it('keeps a skip of a test the filter selected, e.g. a runtime test.skip() in a group run (PILOT-546)', () => {
    expect(isFilteredOutSkip({ status: 'skipped', fullName: 'share > sheet' }, 'share')).toBe(false);
  });

  it('keeps every non-skipped result, and everything when there is no filter', () => {
    expect(isFilteredOutSkip({ status: 'passed', fullName: 'other > t' }, 'share')).toBe(false);
    expect(isFilteredOutSkip({ status: 'skipped', fullName: 'other > t' }, undefined)).toBe(false);
  });
});
