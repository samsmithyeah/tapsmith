/**
 * Shared helper for UI mode child processes (single-run + worker) to stream the
 * source files referenced by a trace event's stack. Files are read from disk
 * once per absolute path and emitted so the Source tab can display the exact
 * code that ran.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnyTraceEvent } from '../trace/types.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export function streamSourcesForEvent(
  event: AnyTraceEvent,
  sent: Set<string>,
  emit: (filePath: string, fileName: string, content: string) => void,
): void {
  if (event.type !== 'action' && event.type !== 'assertion') return;
  if (!event.stack) return;
  for (const frame of event.stack) {
    if (sent.has(frame.file)) continue;
    sent.add(frame.file);
    try {
      const stat = fs.statSync(frame.file);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
      const content = fs.readFileSync(frame.file, 'utf-8');
      emit(frame.file, path.basename(frame.file), content);
    } catch {
      // best-effort — file may be unreadable or transient
    }
  }
}
