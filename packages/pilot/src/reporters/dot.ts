/**
 * Dot reporter — minimal CI output.
 *
 * Outputs a single character per test: · for passed, F for failed,
 * × for skipped. Auto-selected when running in CI environments.
 *
 * @see PILOT-69
 */

import type { PilotReporter, FullResult } from '../reporter.js';
import type { PilotConfig } from '../config.js';
import type { TestResult } from '../runner.js';
import {
  green,
  red,
  yellow,
  bold,
  formatError,
  formatSummaryLine,
  workerTag,
  projectTag,
} from './base.js';

const DOTS_PER_LINE = 80;

export class DotReporter implements PilotReporter {
  private _column = 0;
  private _failed: TestResult[] = [];
  private _showProjectTags = false;

  onRunStart(config: PilotConfig, _fileCount: number): void {
    this._column = 0;
    this._failed = [];
    this._showProjectTags = config.workers > 1 && (config.projects?.length ?? 0) > 1;
    process.stdout.write('\n');
  }

  onTestEnd(test: TestResult): void {
    let char: string;
    switch (test.status) {
      case 'passed':
        char = green('·');
        break;
      case 'failed':
        char = red('F');
        this._failed.push(test);
        break;
      case 'skipped':
        char = yellow('×');
        break;
    }

    process.stdout.write(char);
    this._column++;

    if (this._column >= DOTS_PER_LINE) {
      process.stdout.write('\n');
      this._column = 0;
    }
  }

  onRunEnd(result: FullResult): void {
    const passed = result.tests.filter((t) => t.status === 'passed').length;
    const failed = result.tests.filter((t) => t.status === 'failed').length;
    const skipped = result.tests.filter((t) => t.status === 'skipped').length;

    // End the dot line
    if (this._column > 0) {
      process.stdout.write('\n');
    }

    process.stdout.write('\n');

    // Print failure details
    if (this._failed.length > 0) {
      process.stdout.write(bold(red('Failures:\n\n')));
      for (const test of this._failed) {
        const project = this._showProjectTags ? projectTag(test.project) : '';
        process.stdout.write(`  ${red('✗')} ${workerTag(test.workerIndex)}${project}${test.fullName}\n`);
        if (test.error) {
          process.stdout.write(formatError(test.error) + '\n\n');
        }
      }
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration) + '\n\n');
  }
}
