/**
 * Blob reporter — serialized test data for shard merging.
 *
 * Serializes all test run data into a JSON-based blob file that can later
 * be merged with results from other shards via `npx tapsmith merge-reports`.
 *
 * @see PILOT-74
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult, SuiteResult } from '../runner.js';

interface BlobData {
  version: 1
  startTime: string
  config: {
    rootDir: string
    timeout: number
    retries: number
  }
  shard?: { current: number; total: number }
  duration: number
  suites: SerializedSuite[]
  tests: SerializedTest[]
  screenshots: Record<string, string>
  attachments?: string[]
}

interface SerializedTest {
  name: string
  fullName: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  error?: { message: string; stack?: string }
  screenshotKey?: string
  traceKey?: string
  videoKey?: string
}

interface SerializedSuite {
  name: string
  durationMs: number
  tests: SerializedTest[]
  suites: SerializedSuite[]
}

export class BlobReporter implements TapsmithReporter {
  private _outputDir: string;
  private _config?: TapsmithConfig;
  private _startTime = new Date();

  constructor(options: Record<string, unknown> = {}) {
    this._outputDir = (options.outputDir as string) ?? 'blob-report';
  }

  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._config = config;
    this._startTime = new Date();
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const rootDir = this._config?.rootDir ?? process.cwd();
    const outputDir = path.resolve(rootDir, this._outputDir);
    fs.mkdirSync(outputDir, { recursive: true });

    // Encode screenshots as base64, copy traces/videos as files
    const screenshots: Record<string, string> = {};
    const attachments: string[] = [];

    const copyAttachment = (filePath: string): string | undefined => {
      try {
        if (!fs.existsSync(filePath)) return undefined;
        const key = path.basename(filePath);
        const dest = path.join(outputDir, key);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(filePath, dest);
        }
        attachments.push(key);
        return key;
      } catch {
        return undefined;
      }
    };

    const serializeTest = (t: TestResult): SerializedTest => {
      let screenshotKey: string | undefined;
      if (t.screenshotPath && fs.existsSync(t.screenshotPath)) {
        screenshotKey = path.basename(t.screenshotPath);
        if (!screenshots[screenshotKey]) {
          screenshots[screenshotKey] = fs.readFileSync(t.screenshotPath).toString('base64');
        }
      }
      const traceKey = t.tracePath ? copyAttachment(t.tracePath) : undefined;
      const videoKey = t.videoPath ? copyAttachment(t.videoPath) : undefined;
      return {
        name: t.name,
        fullName: t.fullName,
        status: t.status,
        durationMs: t.durationMs,
        error: t.error ? { message: t.error.message, stack: t.error.stack } : undefined,
        screenshotKey,
        traceKey,
        videoKey,
      };
    };

    const serializeSuite = (s: SuiteResult): SerializedSuite => ({
      name: s.name,
      durationMs: s.durationMs,
      tests: s.tests.map(serializeTest),
      suites: s.suites.map(serializeSuite),
    });

    const blob: BlobData = {
      version: 1,
      startTime: this._startTime.toISOString(),
      config: {
        rootDir: this._config?.rootDir ?? process.cwd(),
        timeout: this._config?.timeout ?? 30_000,
        retries: this._config?.retries ?? 0,
      },
      shard: this._config?.shard,
      duration: result.duration,
      suites: result.suites.map(serializeSuite),
      tests: result.tests.map(serializeTest),
      screenshots,
      attachments,
    };

    // Use a shard-friendly filename (timestamp + random suffix)
    const suffix = Math.random().toString(36).slice(2, 8);
    const filename = `report-${Date.now()}-${suffix}.jsonl`;
    const outputPath = path.join(outputDir, filename);
    fs.writeFileSync(outputPath, JSON.stringify(blob) + '\n');

    process.stderr.write(`Blob report written to ${outputPath}\n`);
  }
}

// ─── Merge utility ───

/**
 * Merge multiple blob reports into a single FullResult.
 * Used by `npx tapsmith merge-reports <dir>`.
 */
export function mergeBlobs(blobDir: string): FullResult {
  const files = fs.readdirSync(blobDir).filter((f) => f.endsWith('.jsonl')).sort();

  const allTests: TestResult[] = [];
  const allSuites: SuiteResult[] = [];
  let totalDuration = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(blobDir, file), 'utf-8').trim();
    const blob: BlobData = JSON.parse(content);

    totalDuration = Math.max(totalDuration, blob.duration);

    // Restore screenshots to disk
    if (blob.screenshots) {
      for (const [key, base64] of Object.entries(blob.screenshots)) {
        const screenshotPath = path.join(blobDir, key);
        if (!fs.existsSync(screenshotPath)) {
          fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
        }
      }
    }

    // Restore tests
    for (const t of blob.tests) {
      allTests.push({
        name: t.name,
        fullName: t.fullName,
        status: t.status,
        durationMs: t.durationMs,
        error: t.error ? Object.assign(new Error(t.error.message), { stack: t.error.stack }) : undefined,
        screenshotPath: t.screenshotKey ? path.join(blobDir, t.screenshotKey) : undefined,
        tracePath: t.traceKey ? path.join(blobDir, t.traceKey) : undefined,
        videoPath: t.videoKey ? path.join(blobDir, t.videoKey) : undefined,
      });
    }

    // Restore suites
    for (const s of blob.suites) {
      allSuites.push(deserializeSuite(s, blobDir));
    }
  }

  const hasFailed = allTests.some((t) => t.status === 'failed');
  return {
    status: hasFailed ? 'failed' : 'passed',
    duration: totalDuration,
    tests: allTests,
    suites: allSuites,
  };
}

function deserializeSuite(
  s: SerializedSuite,
  blobDir: string,
): SuiteResult {
  return {
    name: s.name,
    durationMs: s.durationMs,
    tests: s.tests.map((t) => ({
      name: t.name,
      fullName: t.fullName,
      status: t.status,
      durationMs: t.durationMs,
      error: t.error ? Object.assign(new Error(t.error.message), { stack: t.error.stack }) : undefined,
      screenshotPath: t.screenshotKey ? path.join(blobDir, t.screenshotKey) : undefined,
      tracePath: t.traceKey ? path.join(blobDir, t.traceKey) : undefined,
      videoPath: t.videoKey ? path.join(blobDir, t.videoKey) : undefined,
    })),
    suites: s.suites.map((child) => deserializeSuite(child, blobDir)),
  };
}
