/**
 * Host-pattern filtering for captured network entries.
 *
 * Primary use cases:
 *   - iOS physical + Android emulator capture paths route through a
 *     system-wide HTTP proxy, so the MITM proxy sees every app's
 *     traffic — background services (captive portal checks, analytics,
 *     iCloud/Google sync) as well as the app under test. Users set
 *     `trace.networkHosts` to allowlist only their app's hosts.
 *   - Alternatively, users can keep the broad default and explicitly
 *     drop known-noisy hosts via `trace.networkIgnoreHosts`.
 *
 * Pattern syntax (glob, case-insensitive):
 *   - `api.example.com`       → exact hostname match
 *   - `*.example.com`         → matches `api.example.com`, `cdn.example.com`,
 *                                and `example.com` itself
 *   - `**.example.com`        → same as above, accepted for readability
 *   - `example.*`             → matches `example.com`, `example.co.uk`,
 *                                `example.anything`
 *   - `192.168.1.*`           → literal dots in IPv4 prefixes work fine
 *
 * Semantics (when both allow and deny lists are supplied):
 *   - An entry is kept iff its hostname matches the allowlist AND does
 *     NOT match the denylist. Deny wins.
 *   - Empty/undefined allowlist = allow all. Empty/undefined denylist =
 *     deny none.
 *   - Entries whose URL fails to parse (malformed, empty, etc.) are
 *     dropped when any filter is active, kept when none is.
 */

/** Build a case-insensitive anchored regex for a single glob pattern. */
function compilePattern(pattern: string): RegExp {
  // Escape regex metacharacters EXCEPT `*`, then replace `*` with `.*`.
  // `**` and `*` both reduce to `.*` which matches any hostname chunk,
  // so a leading `*.` like `*.example.com` matches `api.example.com`
  // (`*` → `.*`, so `.*\\.example\\.com`) AND `example.com` itself
  // (because we ALSO allow the leading segment to be empty with a
  // followup optional-dot trick).
  //
  // To make `*.example.com` match `example.com`, we compile it as
  // `(?:.*\\.)?example\\.com` — i.e. the `*.` prefix is optional.
  const lowered = pattern.toLowerCase();
  if (lowered.startsWith('*.') || lowered.startsWith('**.')) {
    const tail = lowered.replace(/^\*+\./, '');
    const tailRegex = escapeForRegex(tail).replace(/\\\*/g, '.*');
    return new RegExp(`^(?:.*\\.)?${tailRegex}$`);
  }
  const body = escapeForRegex(lowered).replace(/\\\*/g, '.*');
  return new RegExp(`^${body}$`);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\*');
}

/**
 * Parse a hostname out of a URL string. Returns lowercase for
 * case-insensitive matching. Returns `null` for unparseable URLs.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Return true if `host` matches at least one of the glob patterns.
 * Empty/undefined pattern list returns true (allow-all).
 */
export function hostMatchesAny(host: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalized = host.toLowerCase();
  for (const pattern of patterns) {
    if (compilePattern(pattern).test(normalized)) return true;
  }
  return false;
}

/**
 * Return true if `host` is blocked by any of the deny patterns.
 * Empty/undefined deny list returns false (block nothing).
 */
export function hostBlockedByAny(host: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = host.toLowerCase();
  for (const pattern of patterns) {
    if (compilePattern(pattern).test(normalized)) return true;
  }
  return false;
}

/** Combined allow/deny filter spec. */
export interface HostFilterSpec {
  allow?: readonly string[]
  deny?: readonly string[]
}

/**
 * Filter a list of captured entries by allowlist and/or denylist. Entry
 * is kept iff it matches the allowlist AND does NOT match the denylist.
 * Either list may be empty/undefined independently. Unparseable URLs are
 * dropped when any filter is active, kept when neither is.
 *
 * Accepts a legacy positional `readonly string[] | undefined` second
 * argument (interpreted as allowlist) for back-compat with existing
 * call sites; new code should pass a `HostFilterSpec` object.
 */
export function filterEntriesByHosts<T extends { url: string }>(
  entries: readonly T[],
  spec: HostFilterSpec | readonly string[] | undefined,
): T[] {
  const { allow, deny } = normalizeFilterSpec(spec);
  const hasAllow = !!(allow && allow.length > 0);
  const hasDeny = !!(deny && deny.length > 0);
  if (!hasAllow && !hasDeny) return [...entries];

  const allowRes = hasAllow ? allow!.map(compilePattern) : null;
  const denyRes = hasDeny ? deny!.map(compilePattern) : null;

  const result: T[] = [];
  for (const entry of entries) {
    const host = hostOf(entry.url);
    if (host === null) continue;
    if (allowRes && !allowRes.some((re) => re.test(host))) continue;
    if (denyRes && denyRes.some((re) => re.test(host))) continue;
    result.push(entry);
  }
  return result;
}

function normalizeFilterSpec(
  spec: HostFilterSpec | readonly string[] | undefined,
): { allow?: readonly string[]; deny?: readonly string[] } {
  if (!spec) return {};
  if (Array.isArray(spec)) return { allow: spec as readonly string[] };
  const s = spec as HostFilterSpec;
  return { allow: s.allow, deny: s.deny };
}
