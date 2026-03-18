/**
 * List reporter — detailed per-test output.
 *
 * Prints a line for each test with status, progress counter, name, and
 * duration. Shows error details inline. Default reporter for local runs.
 *
 * @see PILOT-67
 */

import type { PilotReporter, FullResult } from '../reporter.js'
import type { PilotConfig } from '../config.js'
import type { TestResult } from '../runner.js'
import {
  statusIcon,
  dim,
  bold,
  red,
  formatDuration,
  formatError,
  formatSummaryLine,
} from './base.js'

export class ListReporter implements PilotReporter {
  private _testIndex = 0
  private _totalTests = 0

  onRunStart(_config: PilotConfig, fileCount: number): void {
    this._testIndex = 0
    this._totalTests = 0
    process.stdout.write(`\nRunning tests from ${fileCount} file(s)\n\n`)
  }

  onTestFileStart(filePath: string): void {
    const relative = filePath.replace(process.cwd() + '/', '')
    process.stdout.write(`  ${bold(relative)}\n`)
  }

  onTestEnd(test: TestResult): void {
    this._testIndex++
    this._totalTests++

    const icon = statusIcon(test.status)
    const duration = dim(`(${formatDuration(test.durationMs)})`)
    const counter = dim(`[${this._testIndex}]`)
    process.stdout.write(`  ${icon} ${counter} ${test.fullName} ${duration}\n`)

    if (test.error) {
      process.stdout.write(formatError(test.error) + '\n')
    }

    if (test.screenshotPath) {
      process.stdout.write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`)
    }
  }

  onTestFileEnd(): void {
    // Reset per-file counter for the next file
    this._testIndex = 0
  }

  onRunEnd(result: FullResult): void {
    const passed = result.tests.filter((t) => t.status === 'passed').length
    const failed = result.tests.filter((t) => t.status === 'failed').length
    const skipped = result.tests.filter((t) => t.status === 'skipped').length

    process.stdout.write('\n')

    // Print failure summary if there are failures
    if (failed > 0) {
      process.stdout.write(bold(red('Failures:\n\n')))
      for (const test of result.tests) {
        if (test.status === 'failed' && test.error) {
          process.stdout.write(`  ${red('✗')} ${test.fullName}\n`)
          process.stdout.write(formatError(test.error) + '\n\n')
        }
      }
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration) + '\n\n')
  }
}
