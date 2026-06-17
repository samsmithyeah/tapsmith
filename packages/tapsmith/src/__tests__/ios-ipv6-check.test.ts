import { describe, expect, it } from 'vitest';
import type * as os from 'node:os';
import {
  checkIosSimulatorIpv6Readiness,
  formatIosSimulatorIpv6Warning,
  hasGlobalIpv6Address,
  isGlobalIpv6Address,
} from '../ios-ipv6-check.js';

function ipv6(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
    scopeid: 0,
  } as os.NetworkInterfaceInfo;
}

describe('isGlobalIpv6Address', () => {
  it('rejects loopback, link-local, unique-local, multicast, and IPv4-mapped addresses', () => {
    expect(isGlobalIpv6Address('::1')).toBe(false);
    expect(isGlobalIpv6Address('fe80::1%en0')).toBe(false);
    expect(isGlobalIpv6Address('fd00::1')).toBe(false);
    expect(isGlobalIpv6Address('ff02::1')).toBe(false);
    expect(isGlobalIpv6Address('::ffff:192.0.2.1')).toBe(false);
  });

  it('accepts global unicast IPv6 addresses', () => {
    expect(isGlobalIpv6Address('2607:f8b0:4002:c00::5f')).toBe(true);
    expect(isGlobalIpv6Address('2001:4860:4860::8888')).toBe(true);
  });
});

describe('hasGlobalIpv6Address', () => {
  it('ignores internal and link-local interfaces', () => {
    expect(hasGlobalIpv6Address({
      lo0: [ipv6('::1', true)],
      en0: [ipv6('fe80::abcd%en0')],
    })).toBe(false);
  });

  it('detects a usable global interface address', () => {
    expect(hasGlobalIpv6Address({
      en0: [ipv6('2607:f8b0:4002:c00::5f')],
    })).toBe(true);
  });
});

describe('checkIosSimulatorIpv6Readiness', () => {
  it('passes on non-macOS platforms', () => {
    const readiness = checkIosSimulatorIpv6Readiness({
      platform: 'linux',
      interfaces: {},
      routeLookup: () => false,
    });
    expect(readiness.ok).toBe(true);
    expect(formatIosSimulatorIpv6Warning(readiness)).toBeUndefined();
  });

  it('passes when macOS has an IPv6 route', () => {
    const readiness = checkIosSimulatorIpv6Readiness({
      platform: 'darwin',
      interfaces: { en0: [ipv6('fe80::abcd%en0')] },
      routeLookup: () => true,
    });
    expect(readiness.ok).toBe(true);
    expect(formatIosSimulatorIpv6Warning(readiness)).toBeUndefined();
  });

  it('warns when macOS has no usable IPv6 route', () => {
    const readiness = checkIosSimulatorIpv6Readiness({
      platform: 'darwin',
      interfaces: { en0: [ipv6('fe80::abcd%en0')] },
      routeLookup: () => false,
    });
    const warning = formatIosSimulatorIpv6Warning(readiness);
    expect(readiness.ok).toBe(false);
    expect(warning).toContain('Firestore/gRPC');
    expect(warning).toContain('docs/ios-network-capture.md#firestore-grpc-and-ipv6');
  });
});
