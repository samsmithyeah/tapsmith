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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  /**
   * When `true`, this check is advisory only — a failure prints a ⚠ hint
   * but doesn't block the overall preflight. Used for checks (like
   * firewall stealth mode) that matter for a specific Pilot feature
   * rather than the basic test-on-device path.
   */
  advisory?: boolean
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

/**
 * Check whether `sudo /usr/bin/true` runs without a password prompt. Xcode
 * 26's CoreDevice calls `sudo -- /usr/bin/true` to warm the sudo cache
 * before mounting the Developer Disk Image, which pops a "Password:"
 * prompt mid-`pilot test` — right after "Starting iOS agent…" — making
 * it look like Pilot is asking for credentials when it's actually
 * xcodebuild.
 *
 * `/usr/bin/true` is a literal no-op (exit 0, no side effects), so a
 * narrowly-scoped sudoers NOPASSWD rule on that single binary is safe
 * and removes the prompt permanently across sessions, reboots, and
 * every future `pilot test` run.
 *
 * Historical note: earlier versions suggested `DevToolsSecurity -enable`
 * + `dseditgroup … _developer`. That path worked on older Xcode but is
 * a no-op on Xcode 26 — CoreDevice asks for auth regardless of
 * `_developer` membership.
 */
export function checkSudoTruePasswordless(): CheckResult {
  try {
    execFileSync('sudo', ['-n', '/usr/bin/true'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 2_000,
    });
    return {
      label: 'Passwordless xcodebuild DDI mount',
      ok: true,
      detail: 'sudoers rule is in place (no auth prompt during physical-device test runs)',
    };
  } catch {
    return {
      label: 'Passwordless xcodebuild DDI mount',
      ok: false,
      advisory: true,
      fix: [
        'Not configured. The first `xcodebuild` against a physical device per',
        'macOS login session will pop a "Password:" prompt mid-test — Xcode\'s',
        'CoreDevice layer primes the sudo cache via `sudo -- /usr/bin/true`',
        'before mounting the Developer Disk Image. Run this one-time to make',
        'the prompt go away for good:',
        '',
        '  echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/true" | sudo tee /etc/sudoers.d/pilot-xcode-ddi',
        '  sudo chmod 440 /etc/sudoers.d/pilot-xcode-ddi',
        '',
        '/usr/bin/true has no side effects — xcodebuild only calls it to warm',
        'the sudo cache — so NOPASSWD on that single binary is safe.',
      ],
    };
  }
}

/**
 * Check macOS Application Firewall stealth mode. When stealth mode is on,
 * the kernel silently drops inbound TCP SYNs to user processes even when
 * the binary is explicitly allowed in the firewall list. That breaks
 * Pilot's physical iOS network capture path — the device can't reach the
 * proxy at the Mac's LAN IP, traffic capture returns 0 entries, and the
 * user has no useful feedback until they run `verify-ios-network`.
 *
 * This check is a warning, not a hard fail — users who don't plan to use
 * network capture can ignore it.
 */
export function checkFirewallStealthMode(): CheckResult {
  let out: string;
  try {
    out = execFileSync(
      '/usr/libexec/ApplicationFirewall/socketfilterfw',
      ['--getstealthmode'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    // socketfilterfw unavailable or errored — treat as unknown, skip warning.
    return {
      label: 'macOS Application Firewall stealth mode',
      ok: true,
      detail: 'could not determine (non-fatal)',
    };
  }
  const stealthOn = /stealth mode is on/i.test(out);
  if (!stealthOn) {
    return {
      label: 'macOS Application Firewall stealth mode',
      ok: true,
      detail: 'off (LAN proxy connections will work)',
    };
  }
  return {
    label: 'macOS Application Firewall stealth mode',
    ok: false,
    advisory: true,
    fix: [
      'Stealth mode is ON. iOS devices on Wi-Fi will NOT be able to reach',
      'the Pilot MITM proxy on the Mac\'s LAN IP — inbound TCP SYNs get',
      'silently dropped even for allow-listed binaries. Turn it off with:',
      '',
      '  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off',
      '',
      'If you don\'t use `pilot test` with network capture, ignore this.',
    ],
  };
}

/**
 * Check whether the signed PilotAgent runner has been built for physical
 * devices. This is a cheap cache lookup under `ios-agent/.build-device`
 * that saves the user from having to remember to run `pilot build-ios-agent`
 * separately. Advisory because the check isn't strictly required — users
 * can run `pilot build-ios-agent` any time — but surfacing its state here
 * means one less step in the "next steps" list when it's already done.
 */
export function checkIosAgentBuilt(): CheckResult {
  // Search for an iphoneos xctestrun under the monorepo's standard
  // ios-agent/.build-device path, starting from cwd and walking up to
  // find a repo root. We don't know where the user runs setup from, so
  // we try a few reasonable candidates.
  const candidates = [
    path.resolve(process.cwd(), 'ios-agent/.build-device/Build/Products'),
    path.resolve(process.cwd(), '../ios-agent/.build-device/Build/Products'),
    path.resolve(process.cwd(), '../../ios-agent/.build-device/Build/Products'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      const xctestrun = entries.find(
        (e) => e.endsWith('.xctestrun') && e.includes('iphoneos') && !e.endsWith('.patched.xctestrun'),
      );
      if (xctestrun) {
        return {
          label: 'Signed iOS agent runner',
          ok: true,
          detail: `${path.basename(dir)}/${xctestrun}`,
        };
      }
    } catch {
      // Unreadable dir — skip.
    }
  }
  return {
    label: 'Signed iOS agent runner',
    ok: false,
    advisory: true,
    fix: [
      'Not built yet. Run this once (takes 60–120s first run, <10s incremental):',
      '  pilot build-ios-agent',
      '(advisory — you can build it at any time before `pilot test`)',
    ],
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
    return;
  }
  const advisory = result.advisory === true;
  const marker = advisory ? yellow('⚠') : red('✗');
  console.log(`  ${marker} ${result.label}`);
  if (result.fix) {
    for (const line of result.fix) {
      console.log(`      ${dim(line)}`);
    }
  }
}

function printDeviceStatus(devices: PhysicalDeviceInfo[]): void {
  for (const device of devices) {
    const unpaired = !device.isPaired;
    // Note: we intentionally do NOT inspect `ddiServicesAvailable` here.
    // That field only reflects whether CoreDevice is CURRENTLY holding a
    // Developer Disk Image assertion, not whether one can be mounted on
    // demand. Pilot's agent-start path mounts the DDI itself at test time,
    // so flagging DDI-not-mounted in a passive preflight false-alarms on
    // healthy devices (observed: real iPhone that successfully runs
    // 119/119 tests but shows `ddiServicesAvailable: false` when idle).

    const color = unpaired ? red : green;
    const marker = unpaired ? '✗' : '✓';
    console.log(`  ${color(marker)} ${device.name} ${dim(`(${device.udid})`)}`);
    console.log(`      ${dim(`iOS ${device.osVersion || '?'}`)}`);
    if (unpaired) {
      console.log(`      ${red('not paired')} — open Xcode → Window → Devices and Simulators,`);
      console.log(`        ${dim('wait for the device to appear, then click "Use for Development".')}`);
    } else {
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
  results.push(checkSudoTruePasswordless());
  results.push(checkFirewallStealthMode());
  results.push(checkIosAgentBuilt());
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

  // Hard-fail criteria: any non-advisory check failed, or no device paired.
  // Advisory checks (firewall stealth mode, agent not yet built) print a
  // ⚠ hint but don't block — the user can address them at their own pace.
  // We intentionally don't require `ddiServicesAvailable` either; it's an
  // unreliable "is Xcode currently holding a DDI lease?" signal that
  // false-alarms on healthy idle devices (Pilot's `startAgent` flow mounts
  // the DDI on demand).
  const hardFailures = results.filter((r) => !r.ok && r.advisory !== true);
  const hardOk = hardFailures.length === 0 && deviceCheck.ok
    && deviceCheck.devices.every((d) => d.isPaired);

  if (!hardOk) {
    console.log(red('✗ Some checks failed. Address the issues above and re-run.'));
    console.log();
    process.exit(1);
  }

  // Happy path — summarise what's verified vs. what the user still has to
  // do themselves, and don't blur the two. Anything we can't check from
  // the Mac (dev-cert trust on the device, auto-lock setting, app bundle
  // paths, test config file) is clearly labelled as "do this once".
  const advisoryFailures = results.filter((r) => !r.ok && r.advisory === true);
  if (advisoryFailures.length === 0) {
    console.log(green('✓ Everything we can check from the host looks good.'));
  } else {
    console.log(
      green('✓ Required checks passed.') +
      ' ' +
      dim(`(${advisoryFailures.length} advisory hint${advisoryFailures.length === 1 ? '' : 's'} above — not blocking)`),
    );
  }
  console.log();

  console.log(bold('Manual steps Pilot can\'t verify from the host:'));
  console.log();
  console.log(`  ${yellow('•')} ${bold('Trust the developer certificate on the device.')}`);
  console.log(`    First time only, after the first ${bold('pilot test')} run.`);
  console.log(`    On the phone: ${bold('Settings → General → VPN & Device Management')}`);
  console.log(`    → ${bold('Apple Development: <your name>')} → ${bold('Trust')}.`);
  console.log(`    ${dim('Paid Apple Developer Program accounts often skip this — Xcode')}`);
  console.log(`    ${dim('auto-trusts the team when you register the device.')}`);
  console.log();
  console.log(`  ${yellow('•')} ${bold('Turn off Auto-Lock on the device while testing.')}`);
  console.log(`    ${bold('Settings → Display & Brightness → Auto-Lock → Never')}`);
  console.log(`    ${dim('A locked screen blocks XCUITest — tests hang or fail to find elements.')}`);
  console.log(`    ${dim('Restore your normal setting after the test session.')}`);
  console.log();
  console.log(bold('To run a test:'));
  console.log(`  ${dim('1.')} Point your pilot config at the device UDID above and the signed`);
  console.log(`     ${bold('iosXctestrun')} under ${bold('ios-agent/.build-device')}. Example:`);
  console.log(dim('       { platform: \'ios\', device: \'<UDID>\', iosXctestrun: \'<path>\', app: \'<signed .app>\' }'));
  console.log(`  ${dim('2.')} ${bold('pilot test --config <your-config>')}`);
  console.log();
}
