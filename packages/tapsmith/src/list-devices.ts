/**
 * `tapsmith list-devices` — print a table of connected devices.
 *
 * Queries the Tapsmith daemon for its merged device list (Android via ADB,
 * iOS simulators via simctl, iOS physical via devicectl) and enriches iOS
 * physical entries with extra state from `xcrun devicectl list devices`
 * (iOS version, pairing, Developer Mode, DDI availability, USB transport)
 * that the daemon doesn't surface. This is the single command users can
 * run to see what Tapsmith can target right now and whether any device
 * needs attention before `tapsmith test` will work.
 *
 * Output shape: NAME · PLATFORM · SERIAL · OS · STATUS. The STATUS cell
 * is either "Ready" or a one-line imperative fix ("Plug in via USB
 * cable"). Ready devices sort first. A `--json` flag emits the row model
 * for scripting (schema: docs/api-reference.md, CLI → JSON output).
 *
 * For per-device iOS preflight with richer hints, `tapsmith ios setup-device`
 * does the heavy lifting.
 */

import { execFileSync, spawn } from 'node:child_process';
import { findDaemonBin } from './daemon-bin.js';
import { TapsmithGrpcClient, type DeviceInfoProto } from './grpc-client.js';
import { pickFreePort } from './port-utils.js';
import { formatJson, jsonError } from './cli-json.js';
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
  /** Human-friendly OS version label for the OS column ("iOS 18.1",
   * "Android 14"). Empty when unknown. */
  osLabel: string
  /** Imperative one-liners describing how to make the device ready. Empty
   * when `ready` is true. Ordered by fix priority (attach USB first, then
   * pair, then Developer Mode, then DDI). */
  blockers: string[]
}

/**
 * Build rows for display from the daemon's merged device list plus the
 * devicectl cross-reference for iOS physical devices and the libimobiledevice
 * USB attachment set. Exported so tests can cover the enrichment logic
 * without a live daemon.
 *
 * @param usbAttached Set of UDIDs currently attached over USB (per
 *   `idevice_id -l`). Used only to flag iOS physical devices that
 *   devicectl knows about but which aren't actually cabled — Tapsmith's
 *   agent tunnel is USB-only, so `tapsmith test --device <udid>` against
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
      osLabel: osLabelFor(device, physical),
      blockers,
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

/**
 * Build the OS column label. Prefers devicectl's version for physical iOS
 * devices (the daemon doesn't have it), otherwise falls back to what the
 * daemon returned (Android via getprop, iOS sim via parsed runtime).
 */
function osLabelFor(
  device: DeviceInfoProto,
  physical: PhysicalDeviceInfo | undefined,
): string {
  const version = physical?.osVersion || device.osVersion || '';
  if (!version) return '';
  switch (device.platform) {
    case 'ios':
      return `iOS ${version}`;
    case 'android':
      return `Android ${version}`;
    default:
      return version;
  }
}

/**
 * Imperative one-liners describing what the user needs to do to make the
 * device ready. Empty list = ready. Ordered so the action that unblocks
 * the rest comes first: USB attachment before pairing (you can't pair a
 * phone that isn't plugged in), pairing before Developer Mode, Developer
 * Mode before DDI.
 *
 * Physical iOS has the richest failure modes; iOS simulators and Android
 * are usually ready once the daemon lists them.
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
    // judge readiness — assume it's ready and let `tapsmith test` surface
    // any problem at attachment time.
    if (physical) {
      // Wi-Fi-only is a distinct, reassuring case from "nothing plugged
      // in at all": devicectl sees the device over the local network but
      // Tapsmith's wired-tunnel test flow needs a USB cable.
      if (!isUsbAttached) {
        if (physical.transportType === 'localNetwork') {
          blockers.push('Wi-Fi only — connect USB cable (wired tunnel required)');
        } else {
          blockers.push('Plug in via USB cable');
        }
      }
      if (!physical.isPaired) {
        blockers.push('Pair in Xcode → Window → Devices and Simulators');
      }
      if (physical.developerModeStatus === 'disabled') {
        blockers.push('Enable Developer Mode: Settings → Privacy & Security → Developer Mode');
      }
      // NB: we intentionally don't check `ddiServicesAvailable` here.
      // devicectl only reports it as `true` after something (Xcode) has
      // already mounted the Developer Disk Image in the current session,
      // so it false-alarms on devices where `tapsmith test` would succeed —
      // tapsmith mounts the DDI itself at test time.
    }
  }

  if (device.platform === 'android' && device.state) {
    // adb surfaces "unauthorized" when the device hasn't accepted the
    // RSA key yet and "offline" when the connection is broken.
    if (device.state === 'unauthorized') {
      blockers.push('Accept the USB debugging prompt on the device');
    }
    if (device.state === 'offline') {
      blockers.push('Reconnect cable or run `adb kill-server`');
    }
  }

  return blockers;
}

// ─── Rendering ──────────────────────────────────────────────────────────

function formatTable(rows: DeviceRow[]): string {
  if (rows.length === 0) {
    return dim('No devices detected.\n\n') +
      '  Plug in an iPhone, boot an iOS simulator with `xcrun simctl boot`,\n' +
      '  or start an Android emulator — then re-run `tapsmith list-devices`.\n';
  }

  // Columns: NAME · PLATFORM · SERIAL · OS · STATUS. Name comes first
  // because humans scan device lists by name. No ✓/✗ column — the STATUS
  // cell already carries the ready/blocked signal via color (green
  // "Ready" vs. yellow blocker text).
  const EMPTY_OS = '—';
  const headers = ['NAME', 'PLATFORM', 'SERIAL', 'OS', 'STATUS'];
  const plain: string[][] = rows.map((r) => [
    r.name,
    r.platform,
    r.serial,
    r.osLabel || EMPTY_OS,
    statusStringPlain(r),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...plain.map((row) => row[i].length)),
  );

  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

  const headerLine = headers.map((h, i) => bold(pad(h, widths[i]))).join('  ');
  const separator = widths.map((w) => '─'.repeat(w)).join('  ');

  const body = rows.map((r) => {
    const osCell = r.osLabel || EMPTY_OS;
    const statusTextCell = statusStringColored(r);
    const statusTextRaw = statusStringPlain(r);
    return [
      pad(r.name, widths[0]),
      pad(r.platform, widths[1]),
      pad(r.serial, widths[2]),
      pad(osCell, widths[3]),
      statusTextCell.padEnd(widths[4] + (statusTextCell.length - statusTextRaw.length)),
    ].join('  ');
  });

  const readyCount = rows.filter((r) => r.ready).length;
  const blockedCount = rows.length - readyCount;
  const summary = blockedCount === 0
    ? green(`${readyCount} ready · 0 need attention`)
    : `${green(`${readyCount} ready`)} · ${yellow(`${blockedCount} need attention`)}`;

  const lines = [headerLine, dim(separator), ...body, '', summary];

  // Footer hint: if any blocked row is a physical iOS device, point at
  // the guided fix command. We intentionally skip the hint for Android-
  // only blockers because `ios setup-device` wouldn't help there.
  const hasIosPhysicalBlocker = rows.some(
    (r) => !r.ready && r.platform === 'ios-device',
  );
  if (hasIosPhysicalBlocker) {
    lines.push(dim('Run `tapsmith ios setup-device` for guided fixes.'));
  }

  return lines.join('\n') + '\n';
}

/** Uncolored status cell — "Ready" or blockers joined with " · ". */
function statusStringPlain(r: DeviceRow): string {
  if (r.ready) return 'Ready';
  return r.blockers.join(' · ');
}

/** Colored status cell — "Ready" green, blockers yellow. */
function statusStringColored(r: DeviceRow): string {
  if (r.ready) return green('Ready');
  return r.blockers.map((b) => yellow(b)).join(' · ');
}

// ─── Daemon bootstrap ───────────────────────────────────────────────────

/** A failure the `--json` output reports under its own code. */
export class ListDevicesError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string) {
    super(message);
    this.name = 'ListDevicesError';
  }
}

const DAEMON_BIN_FIX = 'Reinstall tapsmith (npm install tapsmith), or set TAPSMITH_DAEMON_BIN to the tapsmith-core binary';

/**
 * Spin up an ephemeral `tapsmith-core` daemon, issue `ListDevices`, and tear
 * down. Same shape as `ios network configure`'s helper — this command is
 * short-lived and doesn't need to reuse a long-running daemon. Finding,
 * starting and querying the daemon fail as a ListDevicesError naming the
 * stage; anything else (no free port, a broken install) propagates as is.
 */
export async function listDevicesFromDaemon(
  opts: { findBin?: () => string; readyTimeoutMs?: number; connect?: (address: string) => TapsmithGrpcClient } = {},
): Promise<DeviceInfoProto[]> {
  let bin: string;
  try {
    bin = (opts.findBin ?? findDaemonBin)();
  } catch (err) {
    throw new ListDevicesError('DAEMON_NOT_FOUND', err instanceof Error ? err.message : String(err), DAEMON_BIN_FIX);
  }

  const port = String(await pickFreePort());
  const child = spawn(bin, ['--port', port], { stdio: ['ignore', 'ignore', 'ignore'] });
  // A binary that cannot be executed emits 'error' instead of throwing; with
  // no listener that would crash the process instead of reporting it.
  let spawnError: Error | undefined;
  child.on('error', (err) => { spawnError = err; });

  let client: TapsmithGrpcClient | undefined;
  try {
    // Inside the try: a client that cannot be built (a missing proto file)
    // must not leave the daemon just spawned running.
    client = (opts.connect ?? ((address) => new TapsmithGrpcClient(address)))(`127.0.0.1:${port}`);
    const ready = await client.waitForReady(opts.readyTimeoutMs ?? 5_000);
    if (!ready) {
      throw new ListDevicesError(
        'DAEMON_START_FAILED',
        `Failed to start the tapsmith-core daemon (${bin})${spawnError ? `: ${spawnError.message}` : ''}`,
        DAEMON_BIN_FIX,
      );
    }
    try {
      const response = await client.listDevices();
      return response.devices;
    } catch (err) {
      throw new ListDevicesError(
        'LIST_DEVICES_FAILED',
        `The daemon could not list devices: ${err instanceof Error ? err.message : String(err)}`,
        'Re-run tapsmith list-devices; if it keeps failing, run npx tapsmith doctor --json',
      );
    }
  } finally {
    client?.close();
    child.kill();
  }
}

// ─── CLI entry point ────────────────────────────────────────────────────

export interface ListDevicesDeps {
  fetchDevices: () => Promise<DeviceInfoProto[]>;
  /** devicectl + USB cross-reference for physical iOS devices. */
  enrich: () => { physical: PhysicalDeviceInfo[]; usbAttached: Set<string> };
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Physical iOS enrichment; macOS only — `xcrun devicectl` is macOS-only. */
function enrichFromHost(): { physical: PhysicalDeviceInfo[]; usbAttached: Set<string> } {
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
  return { physical, usbAttached };
}

/** Runs the command and returns the process exit code. */
export async function runListDevices(opts: { json: boolean }, overrides: Partial<ListDevicesDeps> = {}): Promise<number> {
  const deps: ListDevicesDeps = {
    fetchDevices: () => listDevicesFromDaemon(),
    enrich: enrichFromHost,
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    ...overrides,
  };

  let rows: DeviceRow[];
  try {
    const daemonDevices = await deps.fetchDevices();
    const { physical, usbAttached } = deps.enrich();
    rows = buildDeviceRows(daemonDevices, physical, usbAttached);
  } catch (err) {
    // Text mode lets an unexpected error reach the CLI's fatal-error handler,
    // stack and all, like the other commands.
    if (!opts.json && !(err instanceof ListDevicesError)) throw err;
    const failure = err instanceof ListDevicesError
      ? jsonError(err.code, err.message, { fix: err.fix })
      : jsonError('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err));
    if (opts.json) {
      deps.stdout(formatJson(failure));
    } else {
      deps.stderr(red(failure.error.message) + '\n');
      if (failure.error.fix) deps.stderr(dim(failure.error.fix) + '\n');
    }
    return 1;
  }

  if (opts.json) {
    deps.stdout(formatJson({ devices: rows }));
    return 0;
  }

  deps.stdout('\n' + formatTable(rows) + '\n');
  return 0;
}

function canRunXcrun(): boolean {
  try {
    execFileSync('xcrun', ['--find', 'devicectl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
