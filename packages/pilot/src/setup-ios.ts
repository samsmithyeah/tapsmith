/**
 * Interactive first-run setup for iOS network capture (PILOT-182).
 *
 * Runs the user through the (currently three-step) install flow:
 *   1. mitmproxy present via Homebrew
 *   2. Mitmproxy Redirector Network Extension registered with macOS
 *   3. Network Extension approved by the user in System Settings
 *
 * At each step the command reports a concise ✓ / ✗ status, tells the user
 * exactly what to do next, and — for the Network Extension approval step —
 * opens System Settings directly to the correct pane and polls
 * `systemextensionsctl list` until the SE flips to `[activated enabled]`.
 *
 * Usage: `npx pilot setup-ios`
 */

import { execFileSync } from 'node:child_process';

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

/** Bundle ID of the System Extension shipped by mitmproxy. */
const REDIRECTOR_SE_BUNDLE_ID = 'org.mitmproxy.macos-redirector.network-extension';

/** Deep link that opens System Settings directly to the Login Items & Extensions pane. */
const SETTINGS_DEEP_LINK = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

/** How long to wait for the user to approve the SE before giving up. */
const APPROVAL_POLL_TIMEOUT_MS = 2 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;

type SeStatus = 'enabled' | 'waiting-for-user' | 'not-registered' | 'unknown';

/**
 * Parse `systemextensionsctl list` output for the state of the Mitmproxy
 * Redirector Network Extension. See `pilot-core/src/ios_redirect.rs`'s
 * `check_se_status()` for the Rust-side equivalent used at test-run time.
 */
function checkSeStatus(): SeStatus {
  let out: string;
  try {
    out = execFileSync('systemextensionsctl', ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return 'unknown';
  }
  const line = out.split('\n').find((l) => l.includes(REDIRECTOR_SE_BUNDLE_ID));
  if (!line) return 'not-registered';
  if (line.includes('[activated enabled]')) return 'enabled';
  if (line.includes('waiting for user') || line.includes('user approval pending')) {
    return 'waiting-for-user';
  }
  return 'unknown';
}

/** Check whether mitmproxy is installed via Homebrew. Returns true on success. */
function isMitmproxyInstalledViaBrew(): boolean {
  try {
    execFileSync('brew', ['list', 'mitmproxy'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open System Settings to the Login Items & Extensions pane so the user
 * can approve the Mitmproxy Redirector Network Extension without hunting
 * for it. Returns true on success, false if even the retry failed.
 *
 * The retry is defensive: when System Settings isn't currently running,
 * Launch Services sometimes returns `-600 procNotFound` on the first
 * `open URL` call because the `x-apple.systempreferences:` URL handler
 * hasn't been re-registered yet. A short sleep and retry reliably
 * unsticks it.
 */
function openLoginItemsExtensions(): boolean {
  const tryOpen = (): boolean => {
    try {
      execFileSync('open', [SETTINGS_DEEP_LINK], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  };
  if (tryOpen()) return true;
  // Give Launch Services a moment to register the URL handler, then retry.
  try {
    execFileSync('sleep', ['0.6'], { stdio: 'ignore' });
  } catch {
    // If even `sleep` is missing we're on a very strange machine —
    // just proceed with the retry.
  }
  return tryOpen();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main entry point for the `pilot setup-ios` command. Exits the process
 * with code 0 on success, non-zero on any failure that requires user
 * action.
 */
export async function runSetupIos(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(red('pilot setup-ios is only supported on macOS.'));
    process.exit(1);
  }

  console.log(bold('Pilot iOS network capture setup'));
  console.log(dim('Verifying prerequisites for iOS simulator network capture...'));
  console.log();

  // ─── Step 1: Homebrew + mitmproxy ────────────────────────────────────
  console.log(bold('1. Homebrew mitmproxy install'));
  if (isMitmproxyInstalledViaBrew()) {
    console.log(`   ${green('✓')} mitmproxy is installed`);
  } else {
    console.log(`   ${red('✗')} mitmproxy is not installed via Homebrew`);
    console.log();
    console.log('   Install it with:');
    console.log(`      ${bold('brew install mitmproxy')}`);
    console.log();
    console.log('   Then re-run:');
    console.log(`      ${bold('npx pilot setup-ios')}`);
    process.exit(1);
  }
  console.log();

  // ─── Step 2: Network Extension state ─────────────────────────────────
  console.log(bold('2. Mitmproxy Redirector Network Extension'));
  let status = checkSeStatus();

  if (status === 'enabled') {
    console.log(`   ${green('✓')} Network Extension is activated and enabled`);
    console.log();
    console.log(green('✓ iOS network capture is ready.'));
    console.log();
    console.log('   Run your tests as normal:');
    console.log(`      ${bold('npx pilot test')}`);
    return;
  }

  if (status === 'not-registered') {
    console.log(`   ${dim('○')} Network Extension has not been registered yet.`);
    console.log();
    console.log('   This registers automatically on your first iOS test run.');
    console.log(`   After the first ${bold('npx pilot test')} run, macOS will prompt you to allow the extension.`);
    console.log();
    console.log('   If the prompt does not appear, open System Settings manually:');
    console.log(`      ${bold('System Settings → General → Login Items & Extensions → Network Extensions')}`);
    console.log();
    console.log(`   Once approved, re-run ${bold('npx pilot setup-ios')} to verify.`);
    process.exit(1);
  }

  if (status === 'waiting-for-user') {
    console.log(`   ${yellow('⚠')} Network Extension is registered but not yet approved`);
    console.log();
    console.log('   Approve it in:');
    console.log(`      ${bold('System Settings → General → Login Items & Extensions → Network Extensions')}`);
    console.log();
    console.log(dim('   Opening System Settings to the right pane...'));
    if (!openLoginItemsExtensions()) {
      console.log(
        dim('   (Could not auto-open — please navigate manually using the path above.)'),
      );
    }
    console.log();
    console.log(dim(`   Waiting for approval (up to ${APPROVAL_POLL_TIMEOUT_MS / 1000}s)...`));

    const deadline = Date.now() + APPROVAL_POLL_TIMEOUT_MS;
    process.stdout.write('   ');
    while (Date.now() < deadline) {
      await sleep(APPROVAL_POLL_INTERVAL_MS);
      status = checkSeStatus();
      if (status === 'enabled') {
        console.log();
        console.log();
        console.log(`   ${green('✓')} Network Extension approved`);
        console.log();
        console.log(green('✓ iOS network capture is ready.'));
        console.log();
        console.log('   Run your tests as normal:');
        console.log(`      ${bold('npx pilot test')}`);
        return;
      }
      process.stdout.write(dim('.'));
    }
    console.log();
    console.log();
    console.log(red('✗ Timed out waiting for Network Extension approval.'));
    console.log();
    console.log('   When you have approved the extension, re-run:');
    console.log(`      ${bold('npx pilot setup-ios')}`);
    process.exit(1);
  }

  // status === 'unknown' — systemextensionsctl missing, errored, or unparseable
  console.log(`   ${yellow('⚠')} Could not determine Network Extension status`);
  console.log();
  console.log('   Try running manually:');
  console.log(`      ${bold('systemextensionsctl list')}`);
  console.log();
  console.log(`   Look for ${dim(REDIRECTOR_SE_BUNDLE_ID)}`);
  console.log(`   in state ${dim('[activated enabled]')}.`);
  process.exit(1);
}
