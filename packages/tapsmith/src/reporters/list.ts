/**
 * List reporter — detailed per-test output.
 *
 * Prints a line for each test with status, progress counter, name, and
 * duration. Shows error details inline. Default reporter for local runs.
 *
 * In-progress tests are shown as dimmed lines on TTY terminals and
 * cleared when the test completes, matching Playwright's list reporter.
 *
 * @see PILOT-67
 */

import * as path from 'node:path';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { TestResult } from '../runner.js';
import {
  statusIcon,
  dim,
  bold,
  red,
  yellow,
  formatDuration,
  formatError,
  formatSummaryLine,
  countFlaky,
  workerTag,
  projectTag,
} from './base.js';

export class ListReporter implements TapsmithReporter {
  private _testIndex = 0;
  private _parallel = false;
  private _multipleWorkers = false;
  private _showProjectTags = false;
  private _isTTY = process.stdout.isTTY ?? false;
  private _rootDir = '';
  private _inProgress = new Map<string, string>();

  onRunStart(config: TapsmithConfig, fileCount: number): void {
    this._testIndex = 0;
    this._parallel = config.workers > 1;
    this._multipleWorkers = config.workers > 1;
    this._showProjectTags = (config.projects?.length ?? 0) > 1;
    this._rootDir = config.rootDir;
    this._inProgress.clear();
    process.stdout.write(`\nRunning tests from ${fileCount} file(s)\n\n`);
  }

  onTestFileStart(filePath: string): void {
    if (this._parallel) return;
    const relative = this._relativeFile(filePath);
    process.stdout.write(`  ${bold(relative)}\n`);
  }

  onTestStart(fullName: string, filePath?: string): void {
    if (!this._isTTY) return;
    this._inProgress.set(fullName, filePath ?? '');
    this._renderInProgress();
  }

  onTestEnd(test: TestResult): void {
    this._inProgress.delete(test.fullName);
    if (this._isTTY) {
      this._clearInProgress();
    }

    if (test._willRetry) {
      const duration = dim(`(${formatDuration(test.durationMs)})`);
      const counter = dim(`[${this._testIndex + 1}]`);
      const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
      const project = this._showProjectTags ? projectTag(test.project) : '';
      const file = this._parallel ? this._fileSegment(test.filePath) : '';
      process.stdout.write(`  ${red('✗')} ${counter} ${worker}${project}${file}${test.fullName} ${duration}\n`);
      if (this._isTTY) this._renderInProgress();
      return;
    }

    this._testIndex++;

    const icon = statusIcon(test.status);
    const duration = dim(`(${formatDuration(test.durationMs)})`);
    const counter = dim(`[${this._testIndex}]`);
    const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
    const project = this._showProjectTags ? projectTag(test.project) : '';
    const file = this._parallel ? this._fileSegment(test.filePath) : '';
    process.stdout.write(`  ${icon} ${counter} ${worker}${project}${file}${test.fullName} ${duration}\n`);

    if (test.error) {
      process.stdout.write(formatError(test.error) + '\n');
    }

    if (test.screenshotPath) {
      process.stdout.write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`);
    }

    if (test.tracePath) {
      process.stdout.write(`        ${dim(`Trace:      npx tapsmith show-trace ${test.tracePath}`)}\n`);
    }

    if (test.videoPath) {
      process.stdout.write(`        ${dim(`Video:      ${test.videoPath}`)}\n`);
    }

    if (this._isTTY) this._renderInProgress();
  }

  onTestFileRetry(_filePath: string, discardedCount: number): void {
    if (this._parallel) return;
    this._testIndex = Math.max(0, this._testIndex - discardedCount);
  }

  onTestFileEnd(): void {
    if (!this._parallel) {
      this._testIndex = 0;
    }
  }

  onRunEnd(result: FullResult): void {
    if (this._isTTY) this._clearInProgress();

    const passed = result.tests.filter((t) => t.status === 'passed').length;
    const failed = result.tests.filter((t) => t.status === 'failed').length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;
    const flaky = countFlaky(result.tests);

    process.stdout.write('\n');

    if (flaky > 0) {
      const flakyTests = result.tests.filter((t) => t.status === 'passed' && t.retry != null && t.retry > 0);
      process.stdout.write(`  ${yellow(`${flaky} flaky`)}\n`);
      for (const test of flakyTests) {
        const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
        const project = this._showProjectTags ? projectTag(test.project) : '';
        process.stdout.write(`    ${worker}${project}${test.fullName}\n`);
      }
    }

    if (failed > 0) {
      process.stdout.write(bold(red('Failures:\n\n')));
      for (const test of result.tests) {
        if (test.status === 'failed' && test.error) {
          const worker = this._multipleWorkers ? workerTag(test.workerIndex) : '';
          const project = this._showProjectTags ? projectTag(test.project) : '';
          process.stdout.write(`  ${red('✗')} ${worker}${project}${test.fullName}\n`);
          process.stdout.write(formatError(test.error) + '\n');
          if (test.screenshotPath) {
            process.stdout.write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`);
          }
          if (test.tracePath) {
            process.stdout.write(`        ${dim(`Trace: npx tapsmith show-trace ${test.tracePath}`)}\n`);
          }
          if (test.videoPath) {
            process.stdout.write(`        ${dim(`Video: ${test.videoPath}`)}\n`);
          }
          process.stdout.write('\n');
        }
      }
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration, flaky) + '\n\n');
  }

  // ─── Private helpers ───

  private _relativeFile(filePath: string): string {
    if (!filePath) return '';
    if (this._rootDir && filePath.startsWith(this._rootDir)) {
      return filePath.slice(this._rootDir.length + 1);
    }
    return filePath.replace(process.cwd() + '/', '');
  }

  private _fileSegment(filePath: string | undefined): string {
    if (!filePath) return '';
    const relative = this._relativeFile(filePath);
    return dim(`› ${path.basename(relative)} › `);
  }

  private _linesRendered = 0;

  private _renderInProgress(): void {
    if (this._inProgress.size === 0) return;
    const lines: string[] = [];
    for (const [fullName, filePath] of this._inProgress) {
      const counter = dim(`[${this._testIndex + 1}]`);
      const file = filePath ? this._fileSegment(filePath) : '';
      lines.push(dim(`     ${counter} ${file}${fullName}`));
    }
    const output = lines.join('\n') + '\n';
    process.stdout.write(output);
    this._linesRendered = lines.length;
  }

  private _clearInProgress(): void {
    if (this._linesRendered === 0) return;
    for (let i = 0; i < this._linesRendered; i++) {
      process.stdout.write('\x1b[1A\x1b[2K');
    }
    this._linesRendered = 0;
  }
}
