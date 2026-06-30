import { describe, it, expect } from 'vitest';
import { matchesTestFilter } from '../test-filter.js';

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
