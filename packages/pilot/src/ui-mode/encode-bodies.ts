/**
 * Shared helper for UI-mode worker entrypoints: take the runner's network
 * entries (which carry `Buffer` bodies) and produce an IPC-safe payload —
 * the entries with bodies stripped + path refs set, plus a `bodies` map of
 * base64-encoded bytes keyed by those paths.
 *
 * Enforces a size cap so a single large download can't parade tens of MB
 * of base64 through the IPC channel to the UI server and client. Bodies
 * above the cap are replaced with a short ASCII marker that the client
 * renders as-is. The archived trace (written separately by the runner)
 * keeps the full body — this cap only affects the live IPC stream.
 */
import type { NetworkEntry } from '../trace/types.js';

/** Max raw body bytes transferred per request/response over IPC. Above
 * this, the body is replaced with a text marker and not decoded client-
 * side. Chosen generously enough to cover typical JSON/HTML payloads but
 * tight enough that a large file download doesn't wedge the IPC pipe. */
const MAX_IPC_BODY_BYTES = 5 * 1024 * 1024;

export interface EncodedBodies {
  entries: Array<NetworkEntry & { requestBody?: undefined; responseBody?: undefined }>
  bodies: Record<string, string>
}

function encodeBody(buf: Buffer, label: 'request' | 'response'): string {
  if (buf.length > MAX_IPC_BODY_BYTES) {
    const mb = (buf.length / (1024 * 1024)).toFixed(1);
    return Buffer.from(
      `[${label} body too large to stream live — ${mb} MB; open the trace archive to inspect]`,
      'utf8',
    ).toString('base64');
  }
  return buf.toString('base64');
}

/** Strip Buffer bodies off each entry and produce a parallel bodies map.
 * Entries whose bodies exceed `MAX_IPC_BODY_BYTES` get a marker payload
 * rather than their raw bytes. */
export function encodeNetworkBodies(entries: readonly NetworkEntry[]): EncodedBodies {
  const bodies: Record<string, string> = {};
  const safe: Array<NetworkEntry & { requestBody?: undefined; responseBody?: undefined }> = entries.map((e) => {
    const copy = { ...e, requestBody: undefined, responseBody: undefined };
    if (e.requestBody && e.requestBody.length > 0) {
      const p = `network/req-${e.index}.bin`;
      bodies[p] = encodeBody(e.requestBody, 'request');
      copy.requestBodyPath = p;
    }
    if (e.responseBody && e.responseBody.length > 0) {
      const p = `network/res-${e.index}.bin`;
      bodies[p] = encodeBody(e.responseBody, 'response');
      copy.responseBodyPath = p;
    }
    return copy;
  });
  return { entries: safe, bodies };
}
