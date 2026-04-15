/**
 * Detect when a physical iOS device's installed network-capture profile
 * points at a stale host IP. The most common trigger is the Mac switching
 * Wi-Fi networks between test runs — the baked-in LAN address in the
 * mobileconfig no longer matches, the device silently fails to route
 * through the proxy, and traces come back empty with no useful error.
 *
 * We read the sidecar metadata that the daemon already writes at profile
 * generation time (`~/.pilot/devices/<udid>.meta.json`) and compare its
 * `host_ip` against the Mac's current primary IPv4 address. The sidecar
 * is authoritative for what's actually installed on the phone; reading
 * it is cheaper and more correct than re-deriving from the mobileconfig
 * XML itself.
 *
 * Only called from paths that have network tracing enabled (see
 * `isNetworkTracingEnabled`). When tracing is off, the user has no
 * mobileconfig installed and nothing to drift.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Sidecar shape as written by `pilot-core::physical_device_proxy`. */
export interface DeviceSidecarMeta {
  udid: string
  device_name: string
  host_ip: string
  port: number
  ssid: string
  generated_at: string
}

/** Result of comparing the sidecar's host IP to the Mac's current IP. */
export interface HostIpCheckResult {
  /** True when both IPs match or no check could be performed (conservative). */
  ok: boolean
  /** The host IP baked into the device's installed mobileconfig. */
  sidecarHostIp?: string
  /** The Mac's current primary IPv4 address, if detectable. */
  currentHostIp?: string
  /** Path to the sidecar file consulted. */
  sidecarPath: string
  /** True when the sidecar doesn't exist (no profile installed, nothing to drift). */
  noSidecar: boolean
}

/** Return the filesystem path of the per-device sidecar regardless of existence. */
export function sidecarPathForDevice(udid: string): string {
  return path.join(os.homedir(), '.pilot', 'devices', `${udid}.meta.json`);
}

/** Read and parse the sidecar for a UDID. Returns undefined if absent or malformed. */
export function readDeviceSidecar(udid: string): DeviceSidecarMeta | undefined {
  const sidecarPath = sidecarPathForDevice(udid);
  if (!fs.existsSync(sidecarPath)) return undefined;
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as DeviceSidecarMeta;
    if (typeof parsed.host_ip !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Return the Mac's current primary IPv4 address on Wi-Fi (en0) or the
 * active default interface. Tries a few strategies in order of reliability:
 *
 *   1. `ipconfig getifaddr en0` — works when Wi-Fi is up and en0 is the
 *      Wi-Fi interface (the common Mac laptop case).
 *   2. Node's os.networkInterfaces() — falls back to the first non-internal
 *      IPv4 address when ipconfig fails or en0 isn't Wi-Fi.
 *
 * Returns `undefined` only if both strategies come up dry — the caller
 * treats that as "conservative: assume OK, don't warn" rather than
 * blocking work.
 */
export function getCurrentHostIp(): string | undefined {
  try {
    const ip = execFileSync('ipconfig', ['getifaddr', 'en0'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (ip.length > 0) return ip;
  } catch {
    // fall through to os.networkInterfaces
  }
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/**
 * Compare the sidecar's host IP against the Mac's current IPv4 address.
 * Returns `ok: true` when they match, when there's no sidecar (nothing
 * to drift), or when we can't determine the current IP. Only returns
 * `ok: false` with confidence that a drift has occurred.
 */
export function checkHostIpDrift(udid: string): HostIpCheckResult {
  const sidecarPath = sidecarPathForDevice(udid);
  const sidecar = readDeviceSidecar(udid);
  if (!sidecar) {
    return { ok: true, sidecarPath, noSidecar: true };
  }
  const currentHostIp = getCurrentHostIp();
  if (!currentHostIp) {
    // Can't tell — don't cry drift.
    return { ok: true, sidecarHostIp: sidecar.host_ip, sidecarPath, noSidecar: false };
  }
  return {
    ok: sidecar.host_ip === currentHostIp,
    sidecarHostIp: sidecar.host_ip,
    currentHostIp,
    sidecarPath,
    noSidecar: false,
  };
}
