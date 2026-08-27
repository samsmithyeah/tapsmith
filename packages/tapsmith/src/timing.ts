/**
 * Lightweight opt-in timing instrumentation for the SDK/CLI side.
 *
 * The daemon has its own copy of this (`tapsmith-core/src/timing.rs`) and both
 * append to the file named by `TAPSMITH_TIMING_LOG`, in the same line format,
 * so one log aggregates across the CLI process and the daemon it spawned:
 *
 *   [TIMING] pid=<n> kind=<boot|cmd|reset|provision> name=<str> dur_ms=<n> ok=<bool> ...
 *
 * Every call is a cheap no-op when the env var is unset. This exists because
 * the device-provisioning phase is otherwise a black box: on CI the CLI spent
 * ~3 minutes between "select or boot iOS simulator" and the next progress line
 * with nothing in the log to say which `simctl` call it was in (PILOT-303).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

let cachedPath: string | null | undefined;

function timingPath(): string | null {
  if (cachedPath !== undefined) return cachedPath;
  const configured = process.env.TAPSMITH_TIMING_LOG;
  if (!configured) {
    cachedPath = null;
    return cachedPath;
  }
  // Create the parent directory once, up front, so per-write opens don't fail
  // silently when the caller points at a not-yet-existing dir.
  try {
    fs.mkdirSync(path.dirname(configured), { recursive: true });
  } catch {
    // Best effort — the append below is the thing that matters, and it is
    // already failure-tolerant.
  }
  cachedPath = configured;
  return cachedPath;
}

/**
 * Whether timing capture is enabled. Callers should gate any non-trivial work
 * that only exists to build a timing line behind this.
 */
export function timingEnabled(): boolean {
  return timingPath() !== null;
}

/**
 * Append one timing line. No-op when `TAPSMITH_TIMING_LOG` is unset.
 *
 * Opens-appends per call: this is low frequency (a handful of lines per
 * session) so the simplicity is worth it, and a single `appendFileSync` of a
 * short line keeps concurrent writers from interleaving under O_APPEND.
 */
export function timingLog(fields: string): void {
  const target = timingPath();
  if (!target) return;
  try {
    fs.appendFileSync(target, `[TIMING] pid=${process.pid} ${fields}\n`);
  } catch {
    // Timing capture must never break a run.
  }
}

/**
 * Time a synchronous call and log its duration. Returns the callee's value and
 * rethrows its error, so this can wrap an existing call site unchanged.
 */
export function timeSync<T>(kind: string, name: string, fn: () => T): T {
  if (!timingEnabled()) return fn();
  const started = Date.now();
  try {
    const result = fn();
    timingLog(`kind=${kind} name=${name} dur_ms=${Date.now() - started} ok=true`);
    return result;
  } catch (err) {
    timingLog(`kind=${kind} name=${name} dur_ms=${Date.now() - started} ok=false`);
    throw err;
  }
}

/** Async counterpart to {@link timeSync}. */
export async function timeAsync<T>(kind: string, name: string, fn: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return fn();
  const started = Date.now();
  try {
    const result = await fn();
    timingLog(`kind=${kind} name=${name} dur_ms=${Date.now() - started} ok=true`);
    return result;
  } catch (err) {
    timingLog(`kind=${kind} name=${name} dur_ms=${Date.now() - started} ok=false`);
    throw err;
  }
}

/** Reset the cached path. Tests only — the env var is read once per process. */
export function _resetTimingPathForTests(): void {
  cachedPath = undefined;
}
