/**
 * `pilot setup-ios-device` — first-run preflight for physical iOS devices.
 *
 * Runs an idempotent ✓ / ✗ checklist of the tribal knowledge users would
 * otherwise have to pick up from Stack Overflow and Apple's docs. Each
 * failing row prints the exact command / action to fix it.
 *
 * The failure modes this catches:
 *   - Xcode command-line tools not installed
 *   - `xcrun devicectl` not available (Xcode < 15)
 *   - `libimobiledevice` (`iproxy`) not installed
 *   - No code signing identity in the user's keychain
 *   - No physical device connected / paired / trusted
 *   - Developer Mode disabled on the device
 *
 * Non-goals: this command does NOT modify system state — it only reads.
 * The user is the one that runs brew install, opens Xcode to pair the
 * device, or flips the Developer Mode toggle on the phone.
 */

import { execFileSync } from 'node:child_process';
import { listPhysicalDevices, type PhysicalDeviceInfo } from './ios-devicectl.js';
import { parseCodesignIdentities, readXcodeRegisteredTeams } from './build-ios-agent.js';

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

// ─── Individual checks ───────────────────────────────────────────────────

export interface CheckResult {
  label: string
  ok: boolean
  detail?: string
  fix?: string[]
}

/** Check Xcode command-line tools are installed. */
export function checkXcodeCommandLineTools(): CheckResult {
  try {
    const path = execFileSync('xcode-select', ['-p'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { label: 'Xcode command-line tools', ok: true, detail: path };
  } catch {
    return {
      label: 'Xcode command-line tools',
      ok: false,
      fix: [
        'Install Xcode and command-line tools:',
        '  1) Install Xcode from the Mac App Store',
        '  2) Run: xcode-select --install',
        '  3) Accept the Xcode license: sudo xcodebuild -license accept',
      ],
    };
  }
}

/** Check `xcrun devicectl` (Xcode 15+) is available. */
export function checkDevicectl(): CheckResult {
  try {
    const path = execFileSync('xcrun', ['--find', 'devicectl'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { label: 'xcrun devicectl (Xcode 15+)', ok: true, detail: path };
  } catch {
    return {
      label: 'xcrun devicectl (Xcode 15+)',
      ok: false,
      fix: [
        'devicectl ships with Xcode 15 or later. Update Xcode via the',
        'Mac App Store, or install the latest Xcode command-line tools.',
      ],
    };
  }
}

/** Check `iproxy` from libimobiledevice is on PATH. */
export function checkIproxy(): CheckResult {
  try {
    const path = execFileSync('which', ['iproxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { label: 'libimobiledevice (iproxy)', ok: true, detail: path };
  } catch {
    return {
      label: 'libimobiledevice (iproxy)',
      ok: false,
      fix: [
        'Pilot tunnels the agent socket from the device via iproxy.',
        'Install it with Homebrew:',
        '  brew install libimobiledevice',
      ],
    };
  }
}

/**
 * Check signing identity state. Two gates here:
 *   (1) keychain must contain at least one "Apple Development" / "Apple
 *       Distribution" certificate — this proves there's a usable cert
 *       somewhere on the machine.
 *   (2) Xcode must have at least one Apple ID signed in so
 *       `IDEProvisioningTeams` is populated — `xcodebuild`'s automatic
 *       signing requires this even when the keychain has a valid cert.
 *
 * The common failure mode (old Xcode install, imported cert without account)
 * is (1) OK but (2) missing. That produces the cryptic "No Account for Team
 * 'XYZ'" error at build time. Flagging both gates up front prevents wasted
 * xcodebuild runs.
 */
export function checkSigningIdentities(): CheckResult {
  let raw: string;
  try {
    raw = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      label: 'Code signing identity',
      ok: false,
      fix: [
        '`security find-identity` failed. Make sure Xcode CLT is installed',
        'then try: security find-identity -v -p codesigning',
      ],
    };
  }
  const keychain = parseCodesignIdentities(raw);
  if (keychain.length === 0) {
    return {
      label: 'Code signing identity',
      ok: false,
      fix: [
        'No "Apple Development" / "Apple Distribution" identity found in the keychain.',
        'Sign in to your Apple Developer account via Xcode:',
        '  1) Open Xcode → Settings → Accounts',
        '  2) Click + → Apple ID → sign in',
        '  3) Select your team and Xcode will create a development certificate',
      ],
    };
  }

  const xcodeTeams = readXcodeRegisteredTeams();
  if (xcodeTeams.length === 0) {
    return {
      label: 'Apple Developer team registered with Xcode',
      ok: false,
      fix: [
        `Keychain has ${keychain.length} signing cert(s), but Xcode has no Apple ID`,
        'signed in. `xcodebuild` will fail with "No Account for Team ..." until',
        'you sign in via:',
        '  1) Open Xcode → Settings → Accounts',
        '  2) Click + → Apple ID',
        '  3) Pick the team that owns the keychain cert',
      ],
    };
  }

  // Warn (but don't fail) if keychain teams and Xcode teams don't overlap.
  // This is usually a stale keychain cert from a different team — the Xcode
  // team is what xcodebuild will actually use, so we proceed.
  const xcodeTeamIds = new Set(xcodeTeams.map((t) => t.teamId));
  const overlap = keychain.some((k) => xcodeTeamIds.has(k.teamId));

  const teamsDesc = xcodeTeams.length === 1
    ? xcodeTeams[0]!.teamId
    : `${xcodeTeams.length} teams (${xcodeTeams.map((t) => t.teamId).join(', ')})`;

  return {
    label: 'Apple Developer team registered with Xcode',
    ok: true,
    detail: overlap ? teamsDesc : `${teamsDesc} (keychain has a cert for a different team)`,
  };
}

/** Check connected physical devices and their pairing / DDI / Developer Mode state. */
export function checkDeviceConnection(): { ok: boolean; devices: PhysicalDeviceInfo[]; label: string; fix?: string[] } {
  const devices = listPhysicalDevices();
  if (devices.length === 0) {
    return {
      ok: false,
      devices: [],
      label: 'Physical iOS device connected',
      fix: [
        'No physical iOS device found. To connect one:',
        '  1) Plug the device into this Mac via USB',
        '  2) On the device, tap "Trust This Computer" when prompted',
        '  3) Enable Developer Mode:',
        '       Settings → Privacy & Security → Developer Mode → On',
        '     (requires a device reboot)',
        '  4) Open Xcode → Window → Devices and Simulators and wait for',
        '     the device to register under your team',
      ],
    };
  }
  return { ok: true, devices, label: 'Physical iOS device connected' };
}

// ─── Pretty-printing ─────────────────────────────────────────────────────

function printCheck(result: CheckResult): void {
  if (result.ok) {
    const tail = result.detail ? dim(` — ${result.detail}`) : '';
    console.log(`  ${green('✓')} ${result.label}${tail}`);
  } else {
    console.log(`  ${red('✗')} ${result.label}`);
    if (result.fix) {
      for (const line of result.fix) {
        console.log(`      ${dim(line)}`);
      }
    }
  }
}

function printDeviceStatus(devices: PhysicalDeviceInfo[]): void {
  for (const device of devices) {
    const unpaired = !device.isPaired;
    const ddiOff = !device.ddiServicesAvailable;

    // Green if fully ready, yellow if paired but DDI missing, red if unpaired.
    const color = unpaired ? red : ddiOff ? yellow : green;
    const marker = unpaired ? '✗' : ddiOff ? '⚠' : '✓';
    console.log(`  ${color(marker)} ${device.name} ${dim(`(${device.udid})`)}`);
    console.log(`      ${dim(`iOS ${device.osVersion || '?'}`)}`);
    if (unpaired) {
      console.log(`      ${red('not paired')} — open Xcode → Window → Devices and Simulators,`);
      console.log(`        ${dim('wait for the device to appear, then click "Use for Development".')}`);
    }
    if (ddiOff && !unpaired) {
      console.log(`      ${yellow('Developer Disk Image not mounted')} — this usually resolves`);
      console.log(`        ${dim('on the first `xcodebuild -destination id=<udid>` run, or by')}`);
      console.log(`        ${dim('opening the device in Xcode → Window → Devices and Simulators.')}`);
    }
    if (!unpaired && !ddiOff) {
      console.log(`      ${green('ready for pilot test')}`);
    }
  }
}

// ─── Main entry point ───────────────────────────────────────────────────

export async function runSetupIosDevice(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(red('pilot setup-ios-device is only supported on macOS.'));
    process.exit(1);
  }

  console.log(bold('Pilot physical iOS device setup'));
  console.log(dim('Verifying prerequisites for running tests against a real iPhone/iPad…'));
  console.log();

  console.log(bold('Prerequisites'));
  const results: CheckResult[] = [];
  results.push(checkXcodeCommandLineTools());
  results.push(checkDevicectl());
  results.push(checkIproxy());
  results.push(checkSigningIdentities());
  for (const r of results) printCheck(r);
  console.log();

  console.log(bold('Devices'));
  const deviceCheck = checkDeviceConnection();
  if (!deviceCheck.ok) {
    console.log(`  ${red('✗')} ${deviceCheck.label}`);
    if (deviceCheck.fix) {
      for (const line of deviceCheck.fix) console.log(`      ${dim(line)}`);
    }
  } else {
    printDeviceStatus(deviceCheck.devices);
  }
  console.log();

  const allOk = results.every((r) => r.ok) && deviceCheck.ok
    && deviceCheck.devices.every((d) => d.isPaired && d.ddiServicesAvailable);

  if (allOk) {
    console.log(green('✓ All checks passed. You\'re ready to run tests on a physical device.'));
    console.log();
    console.log('  Next steps:');
    console.log(`    1) ${bold('pilot build-ios-agent')}`);
    console.log(dim('       Builds the signed XCUITest runner for your device'));
    console.log(`    2) Add to ${bold('pilot.config.ts')}:`);
    console.log(dim("       { platform: 'ios', device: '<UDID>', iosXctestrun: '<path from step 1>', app: '<signed .app>' }"));
    console.log(`    3) ${bold('pilot test')}`);
    console.log();
    console.log(yellow('  One-time per device: trust the developer certificate.'));
    console.log(dim('    After the first pilot test run, open on the phone:'));
    console.log(dim('      Settings → General → VPN & Device Management → Developer App → your team → Trust'));
    console.log(dim('    You only need to do this once per (device, Apple Developer team) pair.'));
    console.log(dim('    Paid Apple Developer Program accounts may skip this step — Xcode'));
    console.log(dim('    auto-trusts the team when you register the device for development.'));
    console.log();
    console.log(yellow('  Disable auto-lock while testing.'));
    console.log(dim('    Settings → Display & Brightness → Auto-Lock → Never'));
    console.log(dim('    Locked screens block XCUITest: tests will hang or fail to find elements.'));
    console.log(dim('    Re-enable after your test session.'));
    console.log();
    return;
  }

  console.log(yellow('⚠ Some checks failed. Address the issues above and re-run:'));
  console.log(`    ${bold('pilot setup-ios-device')}`);
  console.log();
  // Exit non-zero so CI and shell scripts notice.
  process.exit(1);
}
