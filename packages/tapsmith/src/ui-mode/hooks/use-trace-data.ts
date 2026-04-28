/**
 * Hook for managing per-test trace data in UI mode.
 *
 * Handles trace accumulation, blob URL lifecycle, screenshot storage,
 * and source file buffering.
 */

import { useState, useRef } from 'preact/hooks';
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, NetworkEntry } from '../../trace/types.js';
import type { InFlightAction } from '../../trace-viewer/types.js';

// Re-export so existing callers (main.tsx) keep their import path.
export type { InFlightAction };

// ─── Types ───

/** Per-test trace data accumulated during execution. */
export interface TestTraceData {
  events: AnyTraceEvent[];
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[];
  screenshots: Map<string, string>;
  hierarchies: Map<string, string>;
  sources: Map<string, string>;
  network: NetworkEntry[];
  /** Decoded network request/response bodies keyed by path (e.g. `network/res-0.bin`). */
  networkBodies: Map<string, string>;
  /** File this test belongs to — used to scope clearing on re-runs. */
  filePath?: string;
  /** Path to the trace ZIP on the server (set when test completes). */
  tracePath?: string;
  /** Path to the recorded video MP4 on the server (set when test completes). */
  videoPath?: string;
  /** Currently in-flight action/assertion (UI mode live streaming only). */
  inFlightAction?: InFlightAction | null;
}

// ─── Helpers ───

export function base64ToBlobUrl(base64: string): string {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: 'image/png' }));
}

/** Upper bound for inline body decoding in the UI (2 MiB decoded). Anything
 * larger would stall the main thread on decode and isn't useful to render
 * in a `<pre>` anyway — we substitute a placeholder so the rest of the
 * Network tab still works. */
const MAX_INLINE_BODY_BYTES = 2 * 1024 * 1024;

/** Decode a base64-encoded body into a UTF-8 string for display. Returns a
 * short placeholder for bodies above `MAX_INLINE_BODY_BYTES` so we don't
 * freeze the UI on a multi-megabyte response. `atob` throws `DOMException`
 * on malformed input, so we catch and substitute a placeholder — this
 * function runs inside the network-message handler and an uncaught throw
 * would break subsequent trace updates. */
export function base64ToUtf8(base64: string): string {
  // base64 encodes ~3 bytes per 4 chars; use the encoded length as a cheap
  // upper bound to short-circuit huge bodies before we allocate.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_INLINE_BODY_BYTES) {
    return `[body too large to display inline — ${(approxBytes / (1024 * 1024)).toFixed(1)} MB; open the trace archive to inspect]`;
  }
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return `[error decoding body: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

/** Revoke all blob URLs in a trace's screenshot map to free memory. */
export function revokeTraceScreenshots(data: TestTraceData): void {
  for (const blobUrl of data.screenshots.values()) {
    try { URL.revokeObjectURL(blobUrl); } catch { /* already revoked */ }
  }
}

export function emptyTraceData(filePath?: string): TestTraceData {
  return { events: [], actionEvents: [], screenshots: new Map(), hierarchies: new Map(), sources: new Map(), network: [], networkBodies: new Map(), filePath, inFlightAction: null };
}

/** Get existing trace data or create a new entry. */
export function getOrCreateTrace(
  testFullName: string,
  traces: Map<string, TestTraceData>,
): { data: TestTraceData; map: Map<string, TestTraceData> } {
  const existing = traces.get(testFullName);
  if (existing) return { data: existing, map: traces };
  const data = emptyTraceData();
  const map = new Map(traces);
  map.set(testFullName, data);
  return { data, map };
}

// ─── Stable empty references ───

export const EMPTY_MAP = new Map<string, string>();
export const EMPTY_EVENTS: AnyTraceEvent[] = [];
export const EMPTY_ACTION_EVENTS: (ActionTraceEvent | AssertionTraceEvent)[] = [];
export const EMPTY_NETWORK: NetworkEntry[] = [];

// ─── Hook ───

export function useTraceData() {
  const [testTraces, setTestTraces] = useState<Map<string, TestTraceData>>(new Map());

  // Ref tracks the currently-running test — a ref (not state) so the message
  // handler always reads the latest value regardless of React batching.
  const activeTestRef = useRef<string | null>(null);

  // Pending source files keyed by filename — accumulated from 'source' messages
  // and snapshotted into per-test trace data when 'test-start' fires.
  const pendingSourcesRef = useRef<Map<string, string>>(new Map());

  return {
    testTraces,
    setTestTraces,
    activeTestRef,
    pendingSourcesRef,
  };
}
