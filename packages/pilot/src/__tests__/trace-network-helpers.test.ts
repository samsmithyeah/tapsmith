import { describe, it, expect } from 'vitest';
import { isNetworkTracingEnabled, networkHostsForPac } from '../trace/types.js';

describe('isNetworkTracingEnabled', () => {
  it('returns false when trace is undefined or off', () => {
    expect(isNetworkTracingEnabled(undefined)).toBe(false);
    expect(isNetworkTracingEnabled('off')).toBe(false);
    expect(isNetworkTracingEnabled({ mode: 'off' })).toBe(false);
  });

  it('returns true when trace mode is on and network not disabled', () => {
    expect(isNetworkTracingEnabled('on')).toBe(true);
    expect(isNetworkTracingEnabled({ mode: 'on' })).toBe(true);
    expect(isNetworkTracingEnabled({ mode: 'retain-on-failure' })).toBe(true);
  });

  it('returns false when network sub-channel is explicitly disabled', () => {
    expect(isNetworkTracingEnabled({ mode: 'on', network: false })).toBe(false);
  });
});

describe('networkHostsForPac', () => {
  it('returns an empty list when tracing is off', () => {
    expect(networkHostsForPac(undefined)).toEqual([]);
    expect(networkHostsForPac('off')).toEqual([]);
  });

  it('returns an empty list when tracing is on but no allowlist is configured', () => {
    expect(networkHostsForPac('on')).toEqual([]);
    expect(networkHostsForPac({ mode: 'on' })).toEqual([]);
  });

  it('returns the configured allowlist when tracing is on', () => {
    expect(
      networkHostsForPac({ mode: 'on', networkHosts: ['*.myapp.com', 'api.example.com'] }),
    ).toEqual(['*.myapp.com', 'api.example.com']);
  });

  it('returns an empty list when network sub-channel is disabled even if hosts set', () => {
    expect(
      networkHostsForPac({ mode: 'on', network: false, networkHosts: ['*.myapp.com'] }),
    ).toEqual([]);
  });
});
