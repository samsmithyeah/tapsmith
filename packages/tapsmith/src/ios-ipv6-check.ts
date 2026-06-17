import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

export const IOS_IPV6_ROUTE_PROBE = '2001:4860:4860::8888';
export const IOS_SIMULATOR_IPV6_DOC = 'docs/ios-network-capture.md#firestore-grpc-and-ipv6';

export interface IosSimulatorIpv6Readiness {
  platformSupported: boolean;
  hasGlobalAddress: boolean;
  hasIpv6Route: boolean | undefined;
  routeProbe: string;
  ok: boolean;
}

interface IosSimulatorIpv6CheckOptions {
  platform?: NodeJS.Platform;
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  routeLookup?: () => boolean | undefined;
}

let cachedIosSimulatorIpv6Warning: string | null | undefined;

function firstHextet(address: string): number | undefined {
  const hextet = address.split(':', 1)[0];
  if (!hextet) return 0;
  const parsed = Number.parseInt(hextet, 16);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isGlobalIpv6Address(address: string): boolean {
  const normalized = address.split('%', 1)[0].toLowerCase();
  if (!normalized || normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('::ffff:')) return false;

  const first = firstHextet(normalized);
  if (first == null) return false;

  // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xff00) === 0xff00) return false;

  return true;
}

export function hasGlobalIpv6Address(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): boolean {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv6') continue;
      if (isGlobalIpv6Address(entry.address)) return true;
    }
  }
  return false;
}

export function hasIpv6Route(target = IOS_IPV6_ROUTE_PROBE): boolean | undefined {
  try {
    execFileSync('route', ['-n', 'get', '-inet6', target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000,
    });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    return false;
  }
}

export function checkIosSimulatorIpv6Readiness(
  options: IosSimulatorIpv6CheckOptions = {},
): IosSimulatorIpv6Readiness {
  const platform = options.platform ?? process.platform;
  const platformSupported = platform === 'darwin';
  const interfaces = options.interfaces ?? os.networkInterfaces();
  const hasGlobalAddress = hasGlobalIpv6Address(interfaces);
  const hasRoute = platformSupported
    ? (options.routeLookup ? options.routeLookup() : hasIpv6Route())
    : undefined;

  return {
    platformSupported,
    hasGlobalAddress,
    hasIpv6Route: hasRoute,
    routeProbe: IOS_IPV6_ROUTE_PROBE,
    ok: !platformSupported || hasRoute === true || (hasRoute == null && hasGlobalAddress),
  };
}

export function formatIosSimulatorIpv6Warning(readiness: IosSimulatorIpv6Readiness): string | undefined {
  if (readiness.ok || !readiness.platformSupported) return undefined;
  const detail = readiness.hasIpv6Route === false
    ? `no IPv6 route to ${readiness.routeProbe}`
    : 'no global IPv6 address detected';
  return `Host IPv6 appears unavailable (${detail}). iOS simulator network capture can stall Firestore/gRPC traffic on IPv4-only Macs. Enable IPv6, set trace.network: false for affected tests, or see ${IOS_SIMULATOR_IPV6_DOC}.`;
}

export function getIosSimulatorIpv6Warning(): string | undefined {
  if (cachedIosSimulatorIpv6Warning !== undefined) {
    return cachedIosSimulatorIpv6Warning ?? undefined;
  }
  cachedIosSimulatorIpv6Warning = formatIosSimulatorIpv6Warning(checkIosSimulatorIpv6Readiness()) ?? null;
  return cachedIosSimulatorIpv6Warning ?? undefined;
}
