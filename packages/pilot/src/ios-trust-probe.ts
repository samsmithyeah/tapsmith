/**
 * Probe whether the Pilot XCUITest runner is trusted on a physical iOS
 * device. Used by `pilot test` to fail fast (and by future interactive
 * wizards to poll) when the developer certificate has been revoked,
 * re-issued, or was never trusted in the first place.
 *
 * Why this matters: without this probe, a `pilot test` run against a
 * device with an untrusted dev cert silently proceeds through set_device
 * + start_agent, then hangs for 60+ seconds inside xcodebuild before
 * surfacing a cryptic "Developer App Certificate is not trusted" failure.
 * Users blame flakiness. In reality, the fix is a two-tap Settings
 * dance — we just need to catch it before launching the suite.
 *
 * Implementation: `xcrun devicectl device process launch <bundle-id>`
 * against the runner's bundle ID. This is ~1s end-to-end and pattern-
 * matches cleanly on trust failures. Notably this is NOT `xcodebuild
 * test-without-building`, which is 60s+ minimum and would double the
 * startup of every `pilot test` run. The devicectl path was already
 * proven reliable during the OCSP-debugging work.
 *
 * First-run caveat: the probe only helps when the runner is already
 * installed on the device. On a fresh setup the flow is still
 * build-ios-agent → first `pilot test` (which installs the runner via
 * xcodebuild) → iOS trust prompt → user trusts → second `pilot test`.
 * The probe's value is on that second-and-subsequent runs — the common
 * steady-state case with free Apple accounts rolling profiles weekly.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type TrustState =
  /** Runner launched successfully — cert is trusted. */
  | 'trusted'
  /** Runner failed to launch because the dev cert isn't trusted on the device. */
  | 'untrusted'
  /** Runner isn't installed yet (fresh setup — first `pilot test` will install it). */
  | 'runner-not-installed'
  /** Probe couldn't determine state (devicectl unavailable, unknown error, etc.). */
  | 'unknown';

export interface TrustProbeResult {
  state: TrustState
  /** Raw devicectl output for debugging when state !== 'trusted'. */
  raw?: string
}

/** Bundle ID of the Pilot XCUITest runner app. */
export const PILOT_RUNNER_BUNDLE_ID = 'dev.pilot.agent.xctrunner';

// Per-session cache. Invalidated by `clearTrustProbeCache()` (used by
// interactive wizards that poll after asking the user to go trust the
// cert). `pilot test` calls `probeCertTrust` at most once per invocation
// so caching is effectively free for the common case but essential for
// the polling case.
const sessionCache = new Map<string, TrustProbeResult>();

/** Clear the session cache — call after the user has acted on an untrusted result. */
export function clearTrustProbeCache(udid?: string): void {
  if (udid) sessionCache.delete(udid);
  else sessionCache.clear();
}

/**
 * Recognise `xcrun devicectl device process launch` success output.
 * Observed on Xcode 26 / iOS 18+ / iOS 26+:
 *
 *     Launched application with dev.pilot.agent.xctrunner bundle identifier.
 *
 * The "Launched application" line is specifically what we want — devicectl
 * will also print `Launched process with PID …` for some other commands,
 * so the broader pattern catches both. Kept separate from the error
 * classifier so a `classify` fall-through can never accidentally be read
 * as success.
 */
export function isSuccessfulLaunch(raw: string): boolean {
  return /launched application with|launched process with pid/i.test(raw);
}

/**
 * Pattern-match devicectl's error output for known trust failure signals.
 *
 * devicectl doesn't expose a structured error code for "dev cert not
 * trusted" vs "runner missing" vs "device locked", so we fall back to
 * substring matching on the human-readable message. Multiple patterns
 * kept for defensive coverage across iOS versions — Apple re-words these
 * strings between major releases and the probe should degrade to
 * 'unknown' rather than falsely reporting 'trusted'.
 */
export function classifyDevicectlError(raw: string): TrustState {
  const s = raw.toLowerCase();
  // Untrusted developer cert signatures. Observed across iOS 16–18 and
  // devicectl versions shipped with Xcode 15/16/26. All of these point
  // at the same root cause (Settings → VPN & Device Management → Trust).
  if (
    s.includes('not trusted') ||
    s.includes('untrusted developer') ||
    s.includes('untrusteddeveloper') ||
    s.includes('developer app certificate') ||
    s.includes('unable to launch') && s.includes('trust') ||
    s.includes('verify the developer') ||
    s.includes('could not be verified')
  ) {
    return 'untrusted';
  }
  // Runner missing — normal on a fresh device before the first xcodebuild
  // install.
  if (
    s.includes('no such app') ||
    s.includes('application not found') ||
    s.includes('could not find') && s.includes(PILOT_RUNNER_BUNDLE_ID.toLowerCase()) ||
    s.includes('application bundle') && s.includes('not found')
  ) {
    return 'runner-not-installed';
  }
  return 'unknown';
}

/**
 * Launch the Pilot runner via devicectl and classify the outcome.
 *
 * Success → 'trusted'. Failure → classify the stderr. This is intentionally
 * a "launch and discard" — we don't care that the process stays alive; we
 * just need iOS to either honour the launch request (trusted) or reject
 * it (untrusted). devicectl returns as soon as the launch request has
 * been accepted or rejected, which is ~1s.
 *
 * Timeout is generous (10s) to handle devicectl's own occasional warm-up
 * latency on Xcode 26, but the common-case latency is well under 2s.
 */
export async function probeCertTrust(udid: string): Promise<TrustProbeResult> {
  const cached = sessionCache.get(udid);
  if (cached) return cached;

  let result: TrustProbeResult;
  try {
    const { stdout, stderr } = await execFileP(
      'xcrun',
      ['devicectl', 'device', 'process', 'launch', '--device', udid, PILOT_RUNNER_BUNDLE_ID],
      { timeout: 10_000 },
    );
    // devicectl can exit 0 and still report a launch failure in stdout.
    // Be strict: only treat an explicit success as 'trusted'. Everything
    // else routes through the error classifier.
    const combined = `${stdout}\n${stderr}`;
    if (isSuccessfulLaunch(combined)) {
      result = { state: 'trusted' };
    } else {
      const state = classifyDevicectlError(combined);
      result = { state, raw: combined };
    }
  } catch (err) {
    // execFile throws on non-zero exit, which is the typical "launch
    // refused" path — the error object's stderr has the message we need.
    const errWithOutput = err as { stdout?: string; stderr?: string; message?: string };
    const raw = `${errWithOutput.stdout ?? ''}\n${errWithOutput.stderr ?? ''}\n${errWithOutput.message ?? ''}`;
    const state = classifyDevicectlError(raw);
    result = { state, raw };
  }

  sessionCache.set(udid, result);
  return result;
}
