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
import { bodyPlaceholder } from '../trace/body-placeholder.js';

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
    return Buffer.from(bodyPlaceholder(buf.length, 'stream live', label), 'utf8').toString('base64');
  }
  return buf.toString('base64');
}

/** Strip Buffer bodies off each entry and produce a parallel bodies map.
 * Entries whose bodies exceed `MAX_IPC_BODY_BYTES` get a marker payload
 * rather than their raw bytes. */
function encodeNetworkBodies(entries: readonly NetworkEntry[], previous: Map<string, Buffer>): EncodedBodies {
  const bodies: Record<string, string> = {};
  const safe: Array<NetworkEntry & { requestBody?: undefined; responseBody?: undefined }> = entries.map((e) => {
    const copy = { ...e, requestBody: undefined, responseBody: undefined };
    if (e.requestBody && e.requestBody.length > 0) {
      const p = `network/req-${e.index}.bin`;
      if (previous.get(p) !== e.requestBody) bodies[p] = encodeBody(e.requestBody, 'request');
      copy.requestBodyPath = p;
    }
    if (e.responseBody && e.responseBody.length > 0) {
      const p = `network/res-${e.index}.bin`;
      if (previous.get(p) !== e.responseBody) bodies[p] = encodeBody(e.responseBody, 'response');
      copy.responseBodyPath = p;
    }
    return copy;
  });
  return { entries: safe, bodies };
}

/** Per worker file run. Empty snapshots reset identity across tests and retries. */
export function createNetworkBodyEncoder(): (entries: readonly NetworkEntry[]) => Iterable<EncodedBodies> {
  let previous = new Map<string, Buffer>();
  return function* (entries) {
    const encoded = encodeNetworkBodies(entries, previous);
    previous = new Map();
    for (const e of entries) {
      if (e.requestBody?.length) previous.set(`network/req-${e.index}.bin`, e.requestBody);
      if (e.responseBody?.length) previous.set(`network/res-${e.index}.bin`, e.responseBody);
    }
    // A decoded body may be larger than the daemon's compressed-byte budget.
    // Bound aggregate base64 bytes per IPC/WebSocket message as well.
    const budget = 8 * 1024 * 1024;
    let bodies: Record<string, string> = {};
    let size = 0;
    for (const [path, body] of Object.entries(encoded.bodies)) {
      if (size + body.length > budget && size > 0) {
        yield { entries: encoded.entries, bodies };
        bodies = {}; size = 0;
      }
      bodies[path] = body; size += body.length;
    }
    yield { entries: encoded.entries, bodies };
  };
}
