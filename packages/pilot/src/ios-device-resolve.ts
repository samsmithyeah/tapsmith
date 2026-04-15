/**
 * Auto-resolution helpers for physical iOS devices.
 *
 * The e2e config used to hand-roll `xcrun devicectl list devices` JSON
 * parsing and a DerivedData glob walk just to target a phone. That's
 * boilerplate — the framework should do it, same way we already resolve
 * simulator names to UDIDs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listPhysicalDevices, listUsbAttachedIosDevices } from './ios-devicectl.js';

/**
 * Resolve a single paired, USB-attached physical iOS device UDID. Throws
 * with an actionable error when zero or multiple are found so users who
 * own several phones get a clear prompt rather than a silent pick.
 *
 * The returned UDID has been cross-checked against `idevice_id -l`
 * (libimobiledevice) — CoreDevice's `transportType` is not reliable for
 * "is this phone actually on a cable right now", so we use the ground
 * truth from libimobiledevice to filter out wireless-paired devices that
 * can't actually be driven by `pilot test`.
 */
export function resolvePhysicalIosDevice(): string {
  const paired = listPhysicalDevices().filter((d) => d.isPaired);
  if (paired.length === 0) {
    throw new Error(
      'No paired physical iOS device detected. Connect one via USB and run ' +
        '`pilot setup-ios-device`, or set `device` / PILOT_IOS_DEVICE explicitly.',
    );
  }

  const usb = listUsbAttachedIosDevices();
  const usbPaired = paired.filter((d) => usb.has(d.udid));
  const candidates = usbPaired.length > 0 ? usbPaired : paired;

  if (candidates.length === 1) return candidates[0].udid;

  const names = candidates.map((d) => `${d.name} (${d.udid})`).join(', ');
  throw new Error(
    `Multiple paired physical iOS devices detected (${candidates.length}): ${names}. ` +
      'Set `device` in your config or the PILOT_IOS_DEVICE env var to pick one.',
  );
}

/**
 * Find the newest device-built xctestrun under `ios-agent/.build-device`,
 * walking up from `startDir` to the repo root. Returns absolute path, or
 * `undefined` when no build exists (caller decides whether to error — the
 * CLI does, after giving a clear fix-it message pointing at
 * `pilot build-ios-agent`).
 *
 * `.patched.xctestrun` files are excluded because the daemon rewrites
 * xctestrun files at runtime; selecting one as the source would cause
 * successive patches to stack a `.patched.patched.xctestrun` chain until
 * the filename exceeds the 255-byte POSIX limit.
 */
export function findDeviceXctestrun(startDir: string): string | undefined {
  // Walk up from startDir looking for `ios-agent/.build-device/Build/Products`.
  // Same "try a few levels up" approach setup-ios-device uses — we don't
  // know whether the user runs from the monorepo root, an e2e subdir, or
  // a nested package.
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    const productsDir = path.join(dir, 'ios-agent', '.build-device', 'Build', 'Products');
    if (fs.existsSync(productsDir)) {
      const match = newestIphoneosXctestrun(productsDir);
      if (match) return match;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function newestIphoneosXctestrun(productsDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(productsDir);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter(
      (e) =>
        e.endsWith('.xctestrun') &&
        e.includes('iphoneos') &&
        !e.endsWith('.patched.xctestrun'),
    )
    .map((e) => path.join(productsDir, e));
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

/**
 * Find the newest simulator-slice xctestrun under Xcode's DerivedData.
 *
 * Simulator builds land in `~/Library/Developer/Xcode/DerivedData/PilotAgent-*`
 * with a hashed suffix that rotates whenever Xcode regenerates DerivedData,
 * so we glob rather than pinning a path. `.patched.xctestrun` files are
 * excluded for the same reason as the device variant — the daemon rewrites
 * xctestrun at runtime and re-selecting a patched file stacks suffixes.
 *
 * Returns `undefined` when no build exists; the CLI turns that into a
 * fix-it message pointing at the simulator build command.
 */
export function findSimulatorXctestrun(): string | undefined {
  const root = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const candidates: string[] = [];
  for (const d of dirs) {
    if (!d.startsWith('PilotAgent-')) continue;
    const productsDir = path.join(root, d, 'Build', 'Products');
    let entries: string[];
    try {
      entries = fs.readdirSync(productsDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (
        e.endsWith('.xctestrun') &&
        e.includes('iphonesimulator') &&
        !e.endsWith('.patched.xctestrun')
      ) {
        candidates.push(path.join(productsDir, e));
      }
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}
