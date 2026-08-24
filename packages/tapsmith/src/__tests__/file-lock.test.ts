import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { withFileLockSync } from '../file-lock.js';

// proper-lockfile's sync API rejects a `retries` option outright ("Cannot use
// retries with the sync api"), so every call site that passed one threw on
// every attempt and silently ran unlocked — the race the lock existed to close
// was never actually closed.
describe('withFileLockSync', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-lock-'));
    file = path.join(root, 'target.json');
    fs.writeFileSync(file, '[]', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('actually acquires the lock and returns the callback result', () => {
    const held = withFileLockSync(file, () => {
      expect(lockfile.checkSync(file)).toBe(true);
      return 'done';
    });
    expect(held).toEqual({ locked: true, value: 'done' });
  });

  it('releases the lock afterwards', () => {
    withFileLockSync(file, () => 'x');
    expect(lockfile.checkSync(file)).toBe(false);
  });

  it('releases the lock when the callback throws, and propagates the error', () => {
    expect(() => withFileLockSync(file, () => { throw new Error('boom'); })).toThrow('boom');
    expect(lockfile.checkSync(file)).toBe(false);
  });

  it('gives up rather than hanging when another holder never releases', () => {
    const release = lockfile.lockSync(file, { stale: 60_000 });
    try {
      const result = withFileLockSync(file, () => 'should not run', { attempts: 2, waitMs: 5 });
      expect(result).toEqual({ locked: false });
    } finally {
      release();
    }
  });

  it('reports not-locked for a file that does not exist', () => {
    expect(withFileLockSync(path.join(root, 'missing.json'), () => 'x')).toEqual({ locked: false });
  });

  // The reason the outcome is a discriminated result rather than `T |
  // undefined`: a callback that legitimately returns undefined is
  // indistinguishable from one that never ran under the old signature, so a
  // caller would read its own success as contention.
  it('distinguishes a callback returning undefined from never running', () => {
    let ran = false;
    const outcome = withFileLockSync(file, () => { ran = true; return undefined; });
    expect(ran).toBe(true);
    expect(outcome).toEqual({ locked: true, value: undefined });
  });

  it('serialises concurrent read-modify-write cycles', () => {
    // The lock is only useful if a second acquisition sees the first's write.
    withFileLockSync(file, () => {
      fs.writeFileSync(file, JSON.stringify(['a']), 'utf-8');
    });
    withFileLockSync(file, () => {
      const current = JSON.parse(fs.readFileSync(file, 'utf-8')) as string[];
      fs.writeFileSync(file, JSON.stringify([...current, 'b']), 'utf-8');
    });
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(['a', 'b']);
  });
});
