/**
 * Host-pattern filtering for captured network entries.
 *
 * Primary use case: Pilot's physical iOS network capture path uses a
 * system-wide Wi-Fi HTTP proxy, so the MITM proxy sees every app's
 * traffic — iOS background services (captive portal checks, analytics,
 * iCloud sync) as well as the app under test. Users set
 * `trace.networkHosts: ['*.myapp.com']` to scrub system noise from
 * their trace archives.
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
 * Semantics:
 *   - Patterns are an allowlist: an entry is kept iff its hostname
 *     matches at least one pattern.
 *   - If `patterns` is empty or undefined, every entry is kept.
 *   - Entries whose URL fails to parse (malformed, empty, etc.) are
 *     dropped when filtering is active, kept when it isn't.
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
 * Filter a list of captured entries to those whose URL hostname matches
 * one of the allowed patterns. Unparseable URLs are dropped when
 * filtering is active, kept otherwise.
 */
export function filterEntriesByHosts<T extends { url: string }>(
  entries: readonly T[],
  patterns: readonly string[] | undefined,
): T[] {
  if (!patterns || patterns.length === 0) return [...entries];
  const compiled = patterns.map(compilePattern);
  const result: T[] = [];
  for (const entry of entries) {
    const host = hostOf(entry.url);
    if (host === null) continue;
    if (compiled.some((re) => re.test(host))) {
      result.push(entry);
    }
  }
  return result;
}
