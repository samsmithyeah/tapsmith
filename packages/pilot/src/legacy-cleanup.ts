/**
 * One-shot deprecation notices for host-level state left behind by older
 * Pilot versions. Called from both the parallel dispatcher and the
 * single-worker CLI fast path so the notice shows regardless of which code
 * path executes the user's `pilot test` invocation.
 *
 * Each notice fires at most once per process via a module-level flag —
 * users who run many tests in one process see the message once, not once
 * per file.
 */

import * as fs from 'node:fs';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/**
 * Legacy sudoers file created by the pre-PILOT-182 macOS system-proxy
 * approach (`pilot setup-proxy`). Pilot no longer uses `networksetup` for
 * iOS network capture — iOS traffic routing is now handled by the macOS
 * Network Extension redirector inside pilot-core. If this file is still
 * present on the user's system it's harmless dead weight; print a one-line
 * deprecation notice so they know they can remove it.
 */
const LEGACY_SUDOERS_FILE = '/etc/sudoers.d/zzz-pilot-networksetup';
let _legacySudoersNoticeShown = false;

/**
 * Print a deprecation notice (to stderr) if the legacy `zzz-pilot-
 * networksetup` sudoers file still exists. Best-effort and silent on any
 * error — must never block a test run.
 */
export function notifyLegacySudoersIfPresent(): void {
  if (_legacySudoersNoticeShown) return;
  _legacySudoersNoticeShown = true;
  try {
    if (fs.existsSync(LEGACY_SUDOERS_FILE)) {
      process.stderr.write(
        `${YELLOW}[pilot]${RESET} ${DIM}Legacy sudoers file ${LEGACY_SUDOERS_FILE} is no longer used by Pilot.\n` +
        `        Remove it with: ${RESET}sudo rm ${LEGACY_SUDOERS_FILE}${DIM}\n${RESET}`,
      );
    }
  } catch {
    // Best-effort — never block a test run over a deprecation hint.
  }
}
