import * as fs from 'node:fs';
import * as path from 'node:path';

const DURATIONS_FILE = '.tapsmith-durations.json';

interface DurationData {
  files: Record<string, number>
}

export function readDurations(rootDir: string): Record<string, number> {
  const filePath = path.join(rootDir, DURATIONS_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as DurationData;
    return data.files ?? {};
  } catch {
    return {};
  }
}

export function writeDurations(
  rootDir: string,
  fileDurations: Record<string, number>,
): void {
  const filePath = path.join(rootDir, DURATIONS_FILE);
  const existing = readDurations(rootDir);
  const merged = { ...existing, ...fileDurations };
  const data: DurationData = { files: merged };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  } catch {
    // best-effort
  }
}

/**
 * Assign test files to shards using greedy bin-packing by duration.
 * Files with no known duration get a default estimate (median of known, or 30s).
 * Returns the files assigned to the requested shard (1-indexed).
 */
export function shardByDuration(
  files: string[],
  current: number,
  total: number,
  durations: Record<string, number>,
): string[] {
  if (files.length === 0) return [];
  if (total <= 1) return files;

  const knownDurations = Object.values(durations).filter((d) => d > 0);
  const defaultDuration = knownDurations.length > 0
    ? knownDurations.sort((a, b) => a - b)[Math.floor(knownDurations.length / 2)]
    : 30_000;

  const filesWithDuration = files.map((f) => ({
    file: f,
    duration: durations[f] ?? defaultDuration,
  }));

  // Sort longest first for better bin-packing
  filesWithDuration.sort((a, b) => b.duration - a.duration);

  // Greedy: assign each file to the shard with the smallest total duration
  const shardTotals = new Array(total).fill(0) as number[];
  const shardFiles: string[][] = Array.from({ length: total }, () => []);

  for (const { file, duration } of filesWithDuration) {
    let minIdx = 0;
    for (let i = 1; i < total; i++) {
      if (shardTotals[i] < shardTotals[minIdx]) minIdx = i;
    }
    shardFiles[minIdx].push(file);
    shardTotals[minIdx] += duration;
  }

  return shardFiles[current - 1];
}
