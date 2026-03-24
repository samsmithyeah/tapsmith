/**
 * Line reporter — concise single-line output.
 *
 * Overwrites the current line with the most recently completed test.
 * Prints full failure details when they occur. More compact than list
 * reporter — good for large test suites.
 *
 * @see PILOT-68
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
  projectTag,
} from './base.js'

export class LineReporter implements PilotReporter {
  private _completed = 0
  private _failed: TestResult[] = []
  private _isTTY = process.stdout.isTTY ?? false
  private _showProjectTags = false

  onRunStart(config: PilotConfig, fileCount: number): void {
    this._completed = 0
    this._failed = []
    this._showProjectTags = config.workers > 1 && (config.projects?.length ?? 0) > 1
    process.stdout.write(`\nRunning tests from ${fileCount} file(s)\n\n`)
  }

  onTestEnd(test: TestResult): void {
    this._completed++

    if (test.status === 'failed') {
      this._failed.push(test)
      // Print failures immediately so they're not lost
      if (this._isTTY) {
        // Clear current line first
        process.stdout.write('\x1b[2K\r')
      }
      const project = this._showProjectTags ? projectTag(test.project) : ''
      process.stdout.write(`  ${statusIcon('failed')} ${workerTag(test.workerIndex)}${project}${test.fullName} ${dim(`(${formatDuration(test.durationMs)})`)}\n`)
      if (test.error) {
        process.stdout.write(formatError(test.error) + '\n')
      }
      return
    }

    if (this._isTTY) {
      // Overwrite the current line with latest passed/skipped test
      const icon = statusIcon(test.status)
      const duration = dim(`(${formatDuration(test.durationMs)})`)
      const worker = workerTag(test.workerIndex)
      const project = this._showProjectTags ? projectTag(test.project) : ''
      const line = `  ${icon} [${this._completed}] ${worker}${project}${test.fullName} ${duration}`
      // Truncate to terminal width
      const maxWidth = process.stdout.columns ?? 80
      const truncated = line.length > maxWidth ? line.slice(0, maxWidth - 1) + '…' : line
      process.stdout.write(`\x1b[2K\r${truncated}`)
    }
  }

  onRunEnd(result: FullResult): void {
    const passed = result.tests.filter((t) => t.status === 'passed').length
    const failed = result.tests.filter((t) => t.status === 'failed').length
    const skipped = result.tests.filter((t) => t.status === 'skipped').length

    // Clear the progress line
    if (this._isTTY) {
      process.stdout.write('\x1b[2K\r')
    }

    process.stdout.write('\n')

    // Re-print failure summary
    if (this._failed.length > 0) {
      process.stdout.write(bold(red('Failures:\n\n')))
      for (const test of this._failed) {
        const project = this._showProjectTags ? projectTag(test.project) : ''
        process.stdout.write(`  ${red('✗')} ${workerTag(test.workerIndex)}${project}${test.fullName}\n`)
        if (test.error) {
          process.stdout.write(formatError(test.error) + '\n\n')
        }
      }
    }

    process.stdout.write(formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration) + '\n\n')
  }
}
