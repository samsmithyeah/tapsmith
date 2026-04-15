/**
 * Read the embedded provisioning profile from a signed Pilot agent bundle
 * and report days-until-expiry.
 *
 * Why: free Apple Developer accounts roll provisioning profiles every 7
 * days. Without a warning, users hit cryptic signing errors mid-test and
 * have to trace it back to the expiry. By reading ExpirationDate from the
 * embedded .mobileprovision at three strategic points — `build-ios-agent`
 * tail output, `setup-ios-device` preflight, and `pilot test` startup —
 * we pre-empt that entire failure mode with a simple "profile expires in
 * 2 days, re-run `pilot build-ios-agent`" nudge.
 *
 * Parsing path: `security cms -D -i <profile>` dumps the CMS-wrapped
 * plist to stdout. We pipe that into `plutil -convert json -o -` to get
 * a JSON payload, from which we lift the `ExpirationDate` field. Both
 * tools ship with macOS so there's nothing to install.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Days until a profile expires, plus the absolute expiry timestamp for display. */
export interface ProfileExpiryInfo {
  /** Absolute ISO-8601 expiry timestamp. */
  expiresAt: string
  /** Days from now (rounded down). Negative when already expired. */
  daysUntilExpiry: number
  /** Source profile path we read. */
  profilePath: string
}

/**
 * Locate the embedded.mobileprovision inside the signed runner bundle
 * referenced by an .xctestrun. The runner bundle is a sibling of the
 * xctestrun under `Build/Products/<config>-iphoneos/`.
 *
 * Returns `undefined` if no embedded.mobileprovision can be found —
 * simulator xctestruns, stale builds, or unusual project layouts. The
 * caller treats this as "no expiry info available" and proceeds silently.
 */
export function findEmbeddedProfile(xctestrunPath: string): string | undefined {
  const productsDir = path.dirname(xctestrunPath);
  if (!fs.existsSync(productsDir)) return undefined;

  // Walk <Products>/<config>-iphoneos/*.app/embedded.mobileprovision.
  // Keep the search narrow so we don't wander into unrelated DerivedData.
  let entries: string[];
  try {
    entries = fs.readdirSync(productsDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.includes('iphoneos')) continue;
    const configDir = path.join(productsDir, entry);
    let apps: string[];
    try {
      apps = fs.readdirSync(configDir);
    } catch {
      continue;
    }
    for (const app of apps) {
      if (!app.endsWith('.app')) continue;
      const candidate = path.join(configDir, app, 'embedded.mobileprovision');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Decode an embedded.mobileprovision and return the ExpirationDate as an
 * ISO-8601 string. Returns `undefined` on any failure — the caller treats
 * missing expiry data as "don't warn" rather than blocking work.
 *
 * Pipeline:
 *   1. `security cms -D -i <profile>`  → unwrap CMS signature, emit plist XML
 *   2. `plutil -extract ExpirationDate raw - -`  → lift the single date field
 *
 * We intentionally avoid `plutil -convert json` here: the mobileprovision
 * plist contains `<date>` entries that JSON has no type for, which makes
 * the full conversion fail with "Invalid object in plist for JSON format".
 * `plutil -extract` pulls a single field as raw text and doesn't have
 * that limitation.
 */
export function readProfileExpiryDate(profilePath: string): string | undefined {
  if (!fs.existsSync(profilePath)) return undefined;
  try {
    const plist = execFileSync('security', ['cms', '-D', '-i', profilePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value = execFileSync('plutil', ['-extract', 'ExpirationDate', 'raw', '-'], {
      input: plist,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Given an xctestrun path, return expiry info for the embedded provisioning
 * profile inside the corresponding signed runner bundle. Returns `undefined`
 * when no profile can be located or decoded — missing info is not an error.
 */
export function getProfileExpiryInfo(xctestrunPath: string): ProfileExpiryInfo | undefined {
  const profilePath = findEmbeddedProfile(xctestrunPath);
  if (!profilePath) return undefined;
  const expiresAtStr = readProfileExpiryDate(profilePath);
  if (!expiresAtStr) return undefined;
  const expiresAt = new Date(expiresAtStr);
  if (Number.isNaN(expiresAt.getTime())) return undefined;
  const msUntil = expiresAt.getTime() - Date.now();
  const daysUntilExpiry = Math.floor(msUntil / (24 * 60 * 60 * 1000));
  return { expiresAt: expiresAt.toISOString(), daysUntilExpiry, profilePath };
}

/**
 * Threshold at which we start nagging users to rebuild. Aligned with free
 * Apple accounts' 7-day rollover: warn inside the last 3 days so there's
 * still time to rebuild before the weekly cliff.
 */
export const EXPIRY_WARNING_DAYS = 3;

/**
 * Build a short one-line warning for display in preflight / build tail /
 * `pilot test` startup. Returns `undefined` when the profile is outside
 * the warning window.
 */
export function formatExpiryWarning(info: ProfileExpiryInfo): string | undefined {
  const { daysUntilExpiry } = info;
  if (daysUntilExpiry > EXPIRY_WARNING_DAYS) return undefined;
  if (daysUntilExpiry < 0) {
    return `Provisioning profile expired ${Math.abs(daysUntilExpiry)} day(s) ago — re-run \`pilot build-ios-agent\` before your next test.`;
  }
  if (daysUntilExpiry === 0) {
    return 'Provisioning profile expires TODAY — re-run `pilot build-ios-agent` to refresh.';
  }
  return `Provisioning profile expires in ${daysUntilExpiry} day(s) — re-run \`pilot build-ios-agent\` before it rolls.`;
}
