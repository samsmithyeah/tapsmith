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
    if (!frame?.file || sent.has(frame.file)) continue;
    try {
      const stat = fs.statSync(frame.file);
      // Permanently skippable (not a file / too big): mark sent so we don't
      // re-stat it on every subsequent event.
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
        sent.add(frame.file);
        continue;
      }
      const content = fs.readFileSync(frame.file, 'utf-8');
      // Mark sent only after a successful read, so a transient failure
      // (e.g. a temporary lock) can be retried on a later event.
      sent.add(frame.file);
      // Emit a forward-slash-normalized key so it matches the path-keyed
      // sources map on the client regardless of the recording platform.
      emit(frame.file.replace(/\\/g, '/'), path.basename(frame.file), content);
    } catch {
      // best-effort — leave unsent so a transient failure can be retried
    }
  }
}
