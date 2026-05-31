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

// Transient fs error codes worth retrying on a later event (a momentary lock,
// fd exhaustion). Any other error (ENOENT, EACCES, EISDIR, …) is treated as
// permanent for this run, so we stop re-stat'ing the file.
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE']);

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
    } catch (err) {
      // Mark the file sent for any permanent failure (missing, no permission,
      // is-a-directory, …) so we don't re-stat/read it on every later event.
      // Only genuinely transient errors (a momentary lock, fd exhaustion) are
      // left unsent so they can be retried on a subsequent event.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_FS_CODES.has(code)) sent.add(frame.file);
    }
  }
}
