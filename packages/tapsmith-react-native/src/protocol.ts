/**
 * Wire format shared with the Tapsmith daemon (`packages/tapsmith-core/src/app_reset.rs`)
 * and SDK (`packages/tapsmith/src/app-reset.ts`). Framework-agnostic: a
 * Kotlin or Swift implementation follows the same three rules.
 *
 *   marker (always-present a11y text):
 *     tapsmith-hooks:<version>;epoch=<n>;boot=<token>;url=<prefix>[;err=<urlencoded>]
 *
 *   `boot` is a random token generated once per app process. The epoch counter
 *   lives in memory and restarts at 0 after a cold relaunch, so a reset that
 *   is delivered cold (the daemon's periodic cold-launch valve, or a retry) can
 *   never satisfy "epoch greater than before" — a changed `boot` tells the
 *   daemon it is looking at a fresh process, where any epoch ≥ 1 is the ack.
 *   request (deep link the daemon opens):
 *     <prefix><target>?__tapsmith_reset=1&nonce=<opaque>
 *   ack:
 *     the marker's epoch is strictly greater than it was before the request
 */

export const PROTOCOL_VERSION = 1;
export const MARKER_PREFIX = 'tapsmith-hooks:';
export const RESET_QUERY_FLAG = '__tapsmith_reset';

export interface MarkerFields {
  epoch: number;
  /** URL prefix the daemon should build reset links from (ends with `/`). */
  urlPrefix: string;
  /** Per-process token (see the module comment); omitted only by pre-boot markers. */
  boot?: string;
  /** Last reset error, if the handler threw. */
  error?: string;
}

/** Render the marker text. Keep it a single line with no quotes — it lives in an XML attribute. */
/** Random per-process token; regenerated only when the app process restarts. */
export const BOOT_TOKEN: string = Math.random().toString(16).slice(2, 10).padStart(8, '0');

export function formatMarker(fields: MarkerFields): string {
  const parts = [
    `${MARKER_PREFIX}${PROTOCOL_VERSION}`,
    `epoch=${fields.epoch}`,
    ...(fields.boot ? [`boot=${fields.boot}`] : []),
    `url=${fields.urlPrefix}`,
  ];
  if (fields.error) parts.push(`err=${encodeURIComponent(fields.error).replace(/'/g, '%27').replace(/"/g, '%22')}`);
  return parts.join(';');
}

/** Parse a marker string (inverse of {@link formatMarker}); `undefined` when it isn't one. */
export function parseMarker(text: string): (MarkerFields & { version: number }) | undefined {
  const start = text.indexOf(MARKER_PREFIX);
  if (start < 0) return undefined;
  const body = text.slice(start + MARKER_PREFIX.length);
  const [versionRaw, ...rest] = body.split(';');
  const version = Number.parseInt(versionRaw, 10);
  if (!Number.isFinite(version)) return undefined;
  let epoch: number | undefined;
  let urlPrefix = '';
  let boot: string | undefined;
  let error: string | undefined;
  for (const field of rest) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (key === 'epoch') epoch = Number.parseInt(value, 10);
    else if (key === 'url') urlPrefix = value;
    else if (key === 'boot' && value) boot = value;
    else if (key === 'err' && value) {
      try { error = decodeURIComponent(value); } catch { error = value; }
    }
  }
  if (epoch === undefined || !Number.isFinite(epoch)) return undefined;
  return { version, epoch, urlPrefix, error, ...(boot ? { boot } : {}) };
}

export interface ResetRequest {
  /** Route the reset should land on, e.g. `/`, `/login`. */
  target: string;
  nonce: string;
}

/**
 * Recognise a reset request in an incoming URL. Any URL carrying the
 * `__tapsmith_reset` query flag is one; the path (relative to the app's URL
 * prefix) is the target route.
 */
export function parseResetRequest(url: string): ResetRequest | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  const query = url.slice(q + 1).split('#')[0];
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    params.set(safeDecode(k), safeDecode(v));
  }
  if (!params.has(RESET_QUERY_FLAG)) return undefined;
  return { target: routeOf(url.slice(0, q)), nonce: params.get('nonce') ?? '' };
}

/**
 * The route part of a URL, normalised to a leading slash. Handles
 * `scheme:///path`, `scheme://path`, `scheme://host/--/path` (Expo Go) and
 * `https://host/path`.
 */
export function routeOf(urlWithoutQuery: string): string {
  const schemeEnd = urlWithoutQuery.indexOf('://');
  let rest = schemeEnd >= 0 ? urlWithoutQuery.slice(schemeEnd + 3) : urlWithoutQuery;
  const expoGo = rest.indexOf('/--/');
  if (expoGo >= 0) rest = rest.slice(expoGo + 3);
  else if (schemeEnd >= 0) {
    // `scheme://host/path` — drop a host segment only when the scheme is a
    // web one; custom schemes (`myapp://login`) treat the first segment as
    // the route itself.
    const scheme = urlWithoutQuery.slice(0, schemeEnd);
    if (scheme === 'http' || scheme === 'https' || scheme === 'exp' || scheme === 'exps') {
      const slash = rest.indexOf('/');
      rest = slash >= 0 ? rest.slice(slash) : '/';
    } else if (!rest.startsWith('/')) {
      rest = `/${rest}`;
    }
  }
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return rest === '' ? '/' : rest;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}
