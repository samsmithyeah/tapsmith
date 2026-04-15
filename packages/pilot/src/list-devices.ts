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
 * Kept intentionally thin — no flags, no filtering. For per-device iOS
 * preflight with hints, `pilot setup-ios-device` does the heavy lifting.
 */

import { execFileSync, spawn } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { PilotGrpcClient, type DeviceInfoProto } from './grpc-client.js';
import { listPhysicalDevices, type PhysicalDeviceInfo } from './ios-devicectl.js';

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

interface DeviceRow {
  platform: string
  serial: string
  name: string
  state: string
  notes: string[]
}

/**
 * Build rows for display from the daemon's merged device list plus the
 * devicectl cross-reference for iOS physical devices. Exported so tests
 * can cover the enrichment logic without a live daemon.
 */
export function buildDeviceRows(
  daemonDevices: DeviceInfoProto[],
  devicectlDevices: PhysicalDeviceInfo[],
): DeviceRow[] {
  const byUdid = new Map<string, PhysicalDeviceInfo>();
  for (const d of devicectlDevices) byUdid.set(d.udid, d);

  return daemonDevices.map<DeviceRow>((device) => {
    const physical = byUdid.get(device.serial);
    return {
      platform: platformLabel(device),
      serial: device.serial,
      name: device.model || '',
      state: stateLabel(device, physical),
      notes: notesFor(physical),
    };
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

function notesFor(physical: PhysicalDeviceInfo | undefined): string[] {
  if (!physical) return [];
  const notes: string[] = [];
  if (physical.osVersion) notes.push(`iOS ${physical.osVersion}`);
  if (!physical.isPaired) notes.push('not paired');
  if (physical.developerModeStatus === 'disabled') notes.push('developer mode off');
  // `ddiServicesAvailable` only reflects whether CoreDevice is currently
  // holding a DDI assertion, not whether the device can mount one when
  // needed. Pilot's `startAgent` flow mounts it on demand, so showing
  // "DDI not mounted" in a passive listing is misleading. `setup-ios-device`
  // surfaces it (with proper "how to fix" hints) when the user actually
  // asks for a preflight check.
  return notes;
}

// ─── Rendering ──────────────────────────────────────────────────────────

function formatTable(rows: DeviceRow[]): string {
  if (rows.length === 0) {
    return dim('No devices detected.\n\n') +
      '  Plug in an iPhone, boot an iOS simulator with `xcrun simctl boot`,\n' +
      '  or start an Android emulator — then re-run `pilot list-devices`.\n';
  }

  const headers = ['PLATFORM', 'SERIAL', 'NAME', 'STATE', 'NOTES'];
  const plain: string[][] = rows.map((r) => [
    r.platform,
    r.serial,
    r.name,
    r.state,
    r.notes.join(', '),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...plain.map((row) => row[i].length)),
  );

  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

  const headerLine = headers.map((h, i) => bold(pad(h, widths[i]))).join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('  ');

  const body = rows.map((r) => {
    const platformCell = colorPlatform(r.platform);
    const stateCell = colorState(r.state);
    return [
      pad(platformCell, widths[0] + colorOverhead(platformCell, r.platform)),
      pad(r.serial, widths[1]),
      pad(r.name, widths[2]),
      pad(stateCell, widths[3] + colorOverhead(stateCell, r.state)),
      colorNotes(r.notes).padEnd(widths[4]),
    ].join('  ');
  });

  return [headerLine, dim(separator), ...body].join('\n') + '\n';
}

function colorPlatform(p: string): string {
  if (p === 'ios-device' || p === 'android') return green(p);
  return dim(p);
}

function colorState(s: string): string {
  if (s === 'booted' || s === 'device') return green(s);
  if (s === 'shutdown') return dim(s);
  return yellow(s);
}

function colorNotes(notes: string[]): string {
  if (notes.length === 0) return '';
  return notes
    .map((n) => (n.startsWith('iOS ') ? dim(n) : yellow(n)))
    .join(', ');
}

/** ANSI escapes take no visible width but count toward `.length`. Subtract. */
function colorOverhead(colored: string, plain: string): number {
  return colored.length - plain.length;
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
  if (process.platform === 'darwin' && canRunXcrun()) {
    try {
      physical = listPhysicalDevices();
    } catch {
      // Non-fatal — daemon list still prints even without the enrichment.
    }
  }

  const rows = buildDeviceRows(daemonDevices, physical);
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
