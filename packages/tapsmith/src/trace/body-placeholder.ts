/**
 * The short text UI mode substitutes for a network body too large to send or
 * decode live. The trace archive always holds the real body; this marker only
 * stands in for it in the live view. Built and recognised here so every
 * consumer can tell the marker from a body (the Network tab must not try to
 * draw it as the image it replaced).
 */

const PLACEHOLDER_PREFIX = '[';
const PLACEHOLDER_PATTERN = /^\[(?:request |response )?body too large to (?:stream live|display inline) — [\d.]+ MB; open the trace archive to inspect\]$/;
/** Longest marker text, with room to spare; anything longer is a real body. */
const PLACEHOLDER_MAX_LENGTH = 200;

/** The marker for a body of `bytes`, e.g. `[response body too large to stream live — 6.2 MB; …]`. */
export function bodyPlaceholder(bytes: number, reason: 'stream live' | 'display inline', label?: 'request' | 'response'): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `[${label ? `${label} ` : ''}body too large to ${reason} — ${mb} MB; open the trace archive to inspect]`;
}

/** Whether these bytes are a {@link bodyPlaceholder} rather than a body. */
export function isBodyPlaceholder(body: Uint8Array): boolean {
  if (body.length === 0 || body.length > PLACEHOLDER_MAX_LENGTH || body[0] !== PLACEHOLDER_PREFIX.charCodeAt(0)) return false;
  return PLACEHOLDER_PATTERN.test(new TextDecoder().decode(body));
}
