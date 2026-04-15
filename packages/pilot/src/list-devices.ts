/**
 * `pilot list-devices` — print a table of connected devices.
 *
 * Queries the Pilot daemon for its merged device list (Android via ADB,
 * iOS simulators via simctl, iOS physical via devicectl) and enriches iOS
 * physical entries with extra state from `xcrun devicectl list devices`
 * (iOS version, pairing, Developer Mode, DDI availability) that the
 * daemon's proto currently doesn't surface. This is the single command
 * users can run to see what Pilot can target right now and whether any
 * device needs attention before `pilot test` will work.
 *
 * The output groups devices by readiness — a clear ✓/✗ column tells
 * users at a glance which devices are ready for `pilot test`, and
 * anything not ready has a one-line reason in the NOTES column.
 *
 * Kept intentionally thin — no flags, no filtering. For per-device iOS
 * preflight with hints, `pilot setup-ios-device` does the heavy lifting.
 */

import { execFileSync, spawn } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { PilotGrpcClient, type DeviceInfoProto } from './grpc-client.js';
import {
  listPhysicalDevices,
  listUsbAttachedIosDevices,
  type PhysicalDeviceInfo,
} from './ios-devicectl.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;

// ─── Row model ──────────────────────────────────────────────────────────

export interface DeviceRow {
  ready: boolean
  platform: string
  serial: string
  name: string
  state: string
  /** Reasons the device isn't ready (empty when `ready` is true). */
  blockers: string[]
  /** Informational details that aren't blockers (e.g. "iOS 26.2.1"). */
  info: string[]
}

/**
 * Build rows for display from the daemon's merged device list plus the
 * devicectl cross-reference for iOS physical devices and the libimobiledevice
 * USB attachment set. Exported so tests can cover the enrichment logic
 * without a live daemon.
 *
 * @param usbAttached Set of UDIDs currently attached over USB (per
 *   `idevice_id -l`). Used only to flag iOS physical devices that
 *   devicectl knows about but which aren't actually cabled — Pilot's
 *   agent tunnel is USB-only, so `pilot test --device <udid>` against
 *   one would fail at tunnel setup.
 */
export function buildDeviceRows(
  daemonDevices: DeviceInfoProto[],
  devicectlDevices: PhysicalDeviceInfo[],
  usbAttached: Set<string> = new Set(),
): DeviceRow[] {
  const byUdid = new Map<string, PhysicalDeviceInfo>();
  for (const d of devicectlDevices) byUdid.set(d.udid, d);

  const rows = daemonDevices.map<DeviceRow>((device) => {
    const physical = byUdid.get(device.serial);
    const isUsbAttached = usbAttached.has(device.serial);
    const blockers = blockersFor(device, physical, isUsbAttached);
    return {
      ready: blockers.length === 0,
      platform: platformLabel(device),
      serial: device.serial,
      name: device.model || '',
      state: stateLabel(device, physical),
      blockers,
      info: infoFor(physical),
    };
  });

  // Ready devices first, so the user sees the happy path at the top.
  // Stable sort within each group preserves daemon order.
  return rows.slice().sort((a, b) => {
    if (a.ready === b.ready) return 0;
    return a.ready ? -1 : 1;
  });
}

function platformLabel(device: DeviceInfoProto): string {
  switch (device.platform) {
    case 'ios':
      return device.isEmulator ? 'ios-sim' : 'ios-device';
    case 'android':
      return device.isEmulator ? 'android-emu' : 'android';
    default:
      return device.platform || (device.isEmulator ? 'sim' : 'device');
  }
}

function stateLabel(device: DeviceInfoProto, physical: PhysicalDeviceInfo | undefined): string {
  // Prefer the boot state from devicectl for physical iOS devices — the
  // daemon's state is typically blank there. `unknown` falls through to
  // whatever the daemon reported.
  const bootState = physical?.bootState;
  if (bootState && bootState !== 'unknown') {
    return bootState;
  }
  return device.state || 'unknown';
}

/**
 * Reasons why `pilot test --device <serial>` would fail right now. Empty
 * list = ready. Physical iOS devices have the most interesting failure
 * modes; simulators and Android are almost always ready once the daemon
 * lists them.
 */
function blockersFor(
  device: DeviceInfoProto,
  physical: PhysicalDeviceInfo | undefined,
  isUsbAttached: boolean,
): string[] {
  const blockers: string[] = [];

  if (device.platform === 'ios' && !device.isEmulator) {
    // Physical iOS readiness requires the full devicectl enrichment. If
    // it's missing (non-macOS host or devicectl unavailable) we can't
    // judge readiness — assume it's ready and let `pilot test` surface
    // any problem at attachment time.
    if (physical) {
      if (!physical.isPaired) blockers.push('not paired — pair in Xcode → Devices and Simulators');
      if (physical.developerModeStatus === 'disabled') {
        blockers.push('developer mode off — Settings → Privacy & Security → Developer Mode');
      }
      if (!isUsbAttached) blockers.push('not attached via USB');
    }
  }

  if (device.platform === 'android' && device.state) {
    // adb surfaces "unauthorized" when the device hasn't accepted the
    // RSA key yet and "offline" when the connection is broken.
    if (device.state === 'unauthorized') {
      blockers.push('unauthorized — accept the USB debugging prompt on the device');
    }
    if (device.state === 'offline') {
      blockers.push('offline — reconnect the cable or restart adb');
    }
  }

  return blockers;
}

function infoFor(physical: PhysicalDeviceInfo | undefined): string[] {
  if (!physical) return [];
  const info: string[] = [];
  if (physical.osVersion) info.push(`iOS ${physical.osVersion}`);
  return info;
}

// ─── Rendering ──────────────────────────────────────────────────────────

function formatTable(rows: DeviceRow[]): string {
  if (rows.length === 0) {
    return dim('No devices detected.\n\n') +
      '  Plug in an iPhone, boot an iOS simulator with `xcrun simctl boot`,\n' +
      '  or start an Android emulator — then re-run `pilot list-devices`.\n';
  }

  const headers = ['', 'PLATFORM', 'SERIAL', 'NAME', 'STATE', 'NOTES'];
  const plain: string[][] = rows.map((r) => [
    r.ready ? '✓' : '✗',
    r.platform,
    r.serial,
    r.name,
    r.state,
    noteStringPlain(r),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...plain.map((row) => row[i].length)),
  );

  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

  const headerLine = headers.map((h, i) => bold(pad(h, widths[i]))).join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('  ');

  const body = rows.map((r) => {
    const statusRaw = r.ready ? '✓' : '✗';
    const statusCell = r.ready ? green(statusRaw) : yellow(statusRaw);
    const platformCell = colorPlatform(r.platform, r.ready);
    const stateCell = colorState(r.state, r.ready);
    const notesCell = noteStringColored(r);
    return [
      pad(statusCell, widths[0] + (statusCell.length - statusRaw.length)),
      pad(platformCell, widths[1] + (platformCell.length - r.platform.length)),
      pad(r.serial, widths[2]),
      pad(r.name, widths[3]),
      pad(stateCell, widths[4] + (stateCell.length - r.state.length)),
      notesCell.padEnd(widths[5] + (notesCell.length - noteStringPlain(r).length)),
    ].join('  ');
  });

  const readyCount = rows.filter((r) => r.ready).length;
  const blockedCount = rows.length - readyCount;
  const summary = blockedCount === 0
    ? green(`${readyCount} ready · 0 need attention`)
    : `${green(`${readyCount} ready`)} · ${yellow(`${blockedCount} need attention`)}`;

  return [
    headerLine,
    dim(separator),
    ...body,
    '',
    summary,
  ].join('\n') + '\n';
}

/** Uncolored note string — blockers joined with " · ", then info. */
function noteStringPlain(r: DeviceRow): string {
  return [...r.blockers, ...r.info].join(' · ');
}

/** Colored note string — blockers yellow, info dim. */
function noteStringColored(r: DeviceRow): string {
  const parts: string[] = [];
  for (const b of r.blockers) parts.push(yellow(b));
  for (const i of r.info) parts.push(dim(i));
  return parts.join(' · ');
}

function colorPlatform(p: string, ready: boolean): string {
  if (!ready) return yellow(p);
  if (p === 'ios-device' || p === 'android') return green(p);
  return dim(p);
}

function colorState(s: string, ready: boolean): string {
  if (!ready) return yellow(s);
  if (s === 'booted' || s === 'device') return green(s);
  return dim(s);
}

// ─── Daemon bootstrap ───────────────────────────────────────────────────

/**
 * Spin up an ephemeral `pilot-core` daemon, issue `ListDevices`, and tear
 * down. Same shape as `configure-ios-network`'s helper — this command is
 * short-lived and doesn't need to reuse a long-running daemon.
 */
async function listDevicesFromDaemon(): Promise<DeviceInfoProto[]> {
  const port = String(50051 + Math.floor(Math.random() * 1000));
  const bin = findDaemonBin();
  const child = spawn(
    bin,
    ['--port', port],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  // Let the daemon bind its socket. A fresh daemon needs ~100ms; we give
  // it 400ms of headroom since cold starts on a loaded host occasionally
  // exceed that.
  await new Promise((resolve) => setTimeout(resolve, 400));

  const client = new PilotGrpcClient(`127.0.0.1:${port}`);
  const ready = await client.waitForReady(5_000);
  if (!ready) {
    child.kill();
    throw new Error(
      'Failed to start pilot-core daemon. Is the binary on PATH? ' +
      'Set PILOT_DAEMON_BIN to an explicit path if it lives elsewhere.',
    );
  }
  try {
    const response = await client.listDevices();
    return response.devices;
  } finally {
    client.close();
    child.kill();
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────

export async function runListDevices(): Promise<void> {
  let daemonDevices: DeviceInfoProto[];
  try {
    daemonDevices = await listDevicesFromDaemon();
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // Physical iOS enrichment only runs on macOS — `xcrun devicectl` is
  // macOS-only. On other platforms we just show what the daemon returns.
  let physical: PhysicalDeviceInfo[] = [];
  let usbAttached: Set<string> = new Set();
  if (process.platform === 'darwin' && canRunXcrun()) {
    try {
      physical = listPhysicalDevices();
    } catch {
      // Non-fatal — daemon list still prints even without the enrichment.
    }
    try {
      usbAttached = listUsbAttachedIosDevices();
    } catch {
      // Non-fatal — USB flag just won't fire without libimobiledevice.
    }
  }

  const rows = buildDeviceRows(daemonDevices, physical, usbAttached);
  process.stdout.write('\n' + formatTable(rows) + '\n');
}

function canRunXcrun(): boolean {
  try {
    execFileSync('xcrun', ['--find', 'devicectl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
