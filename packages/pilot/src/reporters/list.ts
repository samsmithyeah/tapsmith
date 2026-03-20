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
  workerTag,
} from './base.js'

export class ListReporter implements PilotReporter {
  private _testIndex = 0
  private _totalTests = 0
  private _parallel = false

  onRunStart(config: PilotConfig, fileCount: number): void {
    this._testIndex = 0
    this._totalTests = 0
    this._parallel = config.workers > 1
    process.stdout.write(`\nRunning tests from ${fileCount} file(s)\n\n`)
  }

  onTestFileStart(filePath: string): void {
    // In parallel mode, results from multiple files are interleaved so
    // file headers create a false visual grouping. Skip them.
    if (this._parallel) return
    const relative = filePath.replace(process.cwd() + '/', '')
    process.stdout.write(`  ${bold(relative)}\n`)
  }

  onTestEnd(test: TestResult): void {
    this._testIndex++
    this._totalTests++

    const icon = statusIcon(test.status)
    const duration = dim(`(${formatDuration(test.durationMs)})`)
    const counter = dim(`[${this._testIndex}]`)
    const worker = workerTag(test.workerIndex)
    process.stdout.write(`  ${icon} ${counter} ${worker}${test.fullName} ${duration}\n`)

    if (test.error) {
      process.stdout.write(formatError(test.error) + '\n')
    }

    if (test.screenshotPath) {
      process.stdout.write(`        ${dim(`Screenshot: ${test.screenshotPath}`)}\n`)
    }
  }

  onTestFileEnd(): void {
    // Reset per-file counter for the next file (sequential mode only —
    // in parallel mode the counter is global since results are interleaved)
    if (!this._parallel) {
      this._testIndex = 0
    }
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
          process.stdout.write(`  ${red('✗')} ${workerTag(test.workerIndex)}${test.fullName}\n`)
          process.stdout.write(formatError(test.error) + '\n\n')
        }
      }
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration) + '\n\n')
  }
}
