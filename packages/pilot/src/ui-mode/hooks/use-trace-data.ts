/**
 * Hook for managing per-test trace data in UI mode.
 *
 * Handles trace accumulation, blob URL lifecycle, screenshot storage,
 * and source file buffering.
 */

import { useState, useRef } from 'preact/hooks';
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, NetworkEntry } from '../../trace/types.js';

// ─── Types ───

/** Per-test trace data accumulated during execution. */
export interface TestTraceData {
  events: AnyTraceEvent[];
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[];
  screenshots: Map<string, string>;
  hierarchies: Map<string, string>;
  sources: Map<string, string>;
  network: NetworkEntry[];
  /** File this test belongs to — used to scope clearing on re-runs. */
  filePath?: string;
  /** Path to the trace ZIP on the server (set when test completes). */
  tracePath?: string;
}

// ─── Helpers ───

export function base64ToBlobUrl(base64: string): string {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: 'image/png' }));
}

/** Revoke all blob URLs in a trace's screenshot map to free memory. */
export function revokeTraceScreenshots(data: TestTraceData): void {
  for (const blobUrl of data.screenshots.values()) {
    try { URL.revokeObjectURL(blobUrl); } catch { /* already revoked */ }
  }
}

export function emptyTraceData(filePath?: string): TestTraceData {
  return { events: [], actionEvents: [], screenshots: new Map(), hierarchies: new Map(), sources: new Map(), network: [], filePath };
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
