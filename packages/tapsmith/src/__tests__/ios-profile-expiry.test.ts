import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatExpiryWarning,
  profileExpiryInfoAt,
  EXPIRY_WARNING_DAYS,
  type ProfileExpiryInfo,
} from '../ios-profile-expiry.js';

const base: Omit<ProfileExpiryInfo, 'daysUntilExpiry' | 'expiresAt' | 'expired'> = {
  profilePath: '/tmp/embedded.mobileprovision',
};

function info(daysUntilExpiry: number): ProfileExpiryInfo {
  return {
    ...base,
    daysUntilExpiry,
    expired: daysUntilExpiry < 0,
    expiresAt: new Date(Date.now() + daysUntilExpiry * 86_400_000).toISOString(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatExpiryWarning', () => {
  it('returns undefined when outside the warning window', () => {
    expect(formatExpiryWarning(info(EXPIRY_WARNING_DAYS + 1))).toBeUndefined();
    expect(formatExpiryWarning(info(30))).toBeUndefined();
  });

  it('warns when inside the warning window', () => {
    const msg = formatExpiryWarning(info(2));
    expect(msg).toMatch(/2 day/);
    expect(msg).toMatch(/tapsmith ios build-agent/);
  });

  it('distinguishes expires-today from expires-soon', () => {
    expect(formatExpiryWarning(info(0))).toMatch(/within 24 hours/);
  });

  it('reports expired profiles with days since expiry', () => {
    const msg = formatExpiryWarning(info(-5));
    expect(msg).toMatch(/expired 5 day/);
  });
});

describe('profileExpiryInfoAt (PILOT-264: day rounding around the expiry)', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const HOUR = 3_600_000;
  const at = (offsetMs: number) =>
    profileExpiryInfoAt(new Date(now + offsetMs), '/p/embedded.mobileprovision', now);

  it('an hour past expiry is expired, zero whole days ago — "less than a day ago", not "1 day(s) ago"', () => {
    const info = at(-HOUR);
    expect(info).toMatchObject({ expired: true, daysUntilExpiry: 0 });
    const msg = formatExpiryWarning(info);
    expect(msg).toMatch(/expired less than a day ago/);
    expect(msg).not.toMatch(/1 day/);
  });

  it('25 hours past expiry reads "expired 1 day(s) ago"', () => {
    const info = at(-25 * HOUR);
    expect(info).toMatchObject({ expired: true, daysUntilExpiry: -1 });
    expect(formatExpiryWarning(info)).toMatch(/expired 1 day\(s\) ago/);
  });

  it('an hour before expiry is not expired and warns it expires within 24 hours', () => {
    const info = at(HOUR);
    expect(info).toMatchObject({ expired: false, daysUntilExpiry: 0 });
    expect(formatExpiryWarning(info)).toMatch(/within 24 hours/);
  });

  it('25 hours before expiry is 1 whole day left', () => {
    expect(at(25 * HOUR)).toMatchObject({ expired: false, daysUntilExpiry: 1 });
  });

  it('daysUntilExpiry is never -0', () => {
    expect(Object.is(at(-HOUR).daysUntilExpiry, -0)).toBe(false);
  });

  it('keeps the absolute timestamp and profile path', () => {
    expect(at(HOUR)).toMatchObject({
      expiresAt: new Date(now + HOUR).toISOString(),
      profilePath: '/p/embedded.mobileprovision',
    });
  });
});
