import * as path from 'node:path';
import type { TapsmithReporter } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';
import { writeDurations } from '../shard.js';

export class DurationsReporter implements TapsmithReporter {
  private _rootDir = process.cwd();
  private _fileDurations: Record<string, number> = {};

  onRunStart(config: TapsmithConfig): void {
    this._rootDir = config.rootDir;
  }

  onTestFileEnd(filePath: string, results: TestResult[]): void {
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
    const relPath = path.relative(this._rootDir, filePath);
    this._fileDurations[relPath] = totalMs;
  }

  onRunEnd(): void {
    if (Object.keys(this._fileDurations).length > 0) {
      writeDurations(this._rootDir, this._fileDurations);
    }
  }
}
