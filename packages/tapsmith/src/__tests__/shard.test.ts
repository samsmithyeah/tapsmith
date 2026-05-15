import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { shardByDuration, readDurations, writeDurations } from '../shard.js';

describe('shardByDuration', () => {
  it('returns all files for a single shard', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const result = shardByDuration(files, 1, 1, { 'a.ts': 100, 'b.ts': 200, 'c.ts': 300 });
    expect(result.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns empty array for empty input', () => {
    expect(shardByDuration([], 1, 3, {})).toEqual([]);
  });

  it('balances files by duration across shards', () => {
    const files = ['slow.ts', 'medium.ts', 'fast1.ts', 'fast2.ts'];
    const durations = {
      'slow.ts': 10_000,
      'medium.ts': 5_000,
      'fast1.ts': 2_000,
      'fast2.ts': 1_000,
    };

    const shard1 = shardByDuration(files, 1, 2, durations);
    const shard2 = shardByDuration(files, 2, 2, durations);

    // All files are assigned
    expect([...shard1, ...shard2].sort()).toEqual(files.sort());

    // No duplicates
    expect(new Set([...shard1, ...shard2]).size).toBe(files.length);

    // Slow file should be alone or with fast files in one shard
    const dur: Record<string, number> = durations;
    const sum1 = shard1.reduce((s, f) => s + dur[f], 0);
    const sum2 = shard2.reduce((s, f) => s + dur[f], 0);

    // Max difference should be small (greedy packing: 10+1 vs 5+2 = 11 vs 7)
    expect(Math.abs(sum1 - sum2)).toBeLessThan(5_000);
  });

  it('uses default duration for files without known duration', () => {
    const files = ['known.ts', 'unknown.ts'];
    const durations = { 'known.ts': 10_000 };

    const shard1 = shardByDuration(files, 1, 2, durations);
    const shard2 = shardByDuration(files, 2, 2, durations);

    // Both files are assigned
    expect([...shard1, ...shard2].sort()).toEqual(files.sort());
  });

  it('handles more shards than files', () => {
    const files = ['a.ts', 'b.ts'];
    const durations = { 'a.ts': 100, 'b.ts': 200 };

    const all: string[] = [];
    for (let i = 1; i <= 5; i++) {
      all.push(...shardByDuration(files, i, 5, durations));
    }
    expect(all.sort()).toEqual(files.sort());
  });

  it('deterministic — same input produces same output', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const durations = { 'a.ts': 100, 'b.ts': 200, 'c.ts': 300, 'd.ts': 400 };

    const run1 = shardByDuration(files, 2, 3, durations);
    const run2 = shardByDuration(files, 2, 3, durations);
    expect(run1).toEqual(run2);
  });
});

describe('readDurations / writeDurations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-shard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no file exists', () => {
    expect(readDurations(tmpDir)).toEqual({});
  });

  it('round-trips written durations', () => {
    const durations = { 'tests/a.test.ts': 5000, 'tests/b.test.ts': 3000 };
    writeDurations(tmpDir, durations);
    expect(readDurations(tmpDir)).toEqual(durations);
  });

  it('merges with existing durations', () => {
    writeDurations(tmpDir, { 'a.ts': 100 });
    writeDurations(tmpDir, { 'b.ts': 200 });
    expect(readDurations(tmpDir)).toEqual({ 'a.ts': 100, 'b.ts': 200 });
  });

  it('overwrites existing file durations on update', () => {
    writeDurations(tmpDir, { 'a.ts': 100 });
    writeDurations(tmpDir, { 'a.ts': 200 });
    expect(readDurations(tmpDir)).toEqual({ 'a.ts': 200 });
  });
});
