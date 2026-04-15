import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatExpiryWarning,
  EXPIRY_WARNING_DAYS,
  type ProfileExpiryInfo,
} from '../ios-profile-expiry.js';

const base: Omit<ProfileExpiryInfo, 'daysUntilExpiry' | 'expiresAt'> = {
  profilePath: '/tmp/embedded.mobileprovision',
};

function info(daysUntilExpiry: number): ProfileExpiryInfo {
  return {
    ...base,
    daysUntilExpiry,
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
    expect(msg).toMatch(/pilot build-ios-agent/);
  });

  it('distinguishes expires-today from expires-soon', () => {
    expect(formatExpiryWarning(info(0))).toMatch(/TODAY/);
  });

  it('reports expired profiles with days since expiry', () => {
    const msg = formatExpiryWarning(info(-5));
    expect(msg).toMatch(/expired 5 day/);
  });
});
