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
    expect(held).toBe('done');
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
      expect(result).toBeUndefined();
    } finally {
      release();
    }
  });

  it('returns undefined for a file that does not exist', () => {
    expect(withFileLockSync(path.join(root, 'missing.json'), () => 'x')).toBeUndefined();
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
