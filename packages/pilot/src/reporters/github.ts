/**
 * GitHub Actions reporter — workflow annotations.
 *
 * Outputs GitHub Actions workflow commands to create annotations on
 * failed tests. Test failures appear as annotations on the PR/commit.
 * Auto-activates when GITHUB_ACTIONS env var is detected.
 *
 * @see PILOT-73
 */

import type { PilotReporter, FullResult } from '../reporter.js'
import type { TestResult } from '../runner.js'
import { formatSummaryLine } from './base.js'

export class GitHubActionsReporter implements PilotReporter {
  onTestEnd(test: TestResult): void {
    if (test.status !== 'failed' || !test.error) return

    // Extract file/line from stack trace if possible
    const location = extractLocation(test.error)
    const locationPart = location ? ` file=${location.file},line=${location.line}` : ''

    // Escape the message for GitHub Actions
    const message = escapeGitHub(test.error.message)

    const workerSuffix = test.workerIndex != null ? ` (worker ${test.workerIndex})` : ''
    process.stdout.write(`::error${locationPart} title=${escapeGitHub(test.fullName + workerSuffix)}::${message}\n`)
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const passed = result.tests.filter((t) => t.status === 'passed').length
    const failed = result.tests.filter((t) => t.status === 'failed').length
    const skipped = result.tests.filter((t) => t.status === 'skipped').length

    // Write a summary using GitHub Actions job summary
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summaryLines: string[] = []
      summaryLines.push('## Pilot Test Results')
      summaryLines.push('')
      summaryLines.push(`| Status | Count |`)
      summaryLines.push(`| --- | --- |`)
      summaryLines.push(`| Passed | ${passed} |`)
      summaryLines.push(`| Failed | ${failed} |`)
      summaryLines.push(`| Skipped | ${skipped} |`)
      summaryLines.push(`| Duration | ${(result.duration / 1000).toFixed(2)}s |`)

      if (failed > 0) {
        summaryLines.push('')
        summaryLines.push('### Failures')
        summaryLines.push('')
        for (const test of result.tests) {
          if (test.status === 'failed' && test.error) {
            const workerInfo = test.workerIndex != null ? ` (worker ${test.workerIndex})` : ''
            summaryLines.push(`- **${test.fullName}${workerInfo}**: ${test.error.message}`)
          }
        }
      }

      try {
        const nodeFs = await import('node:fs')
        nodeFs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join('\n') + '\n')
      } catch {
        // Best-effort summary writing
      }
    }

    // Also print a plain summary line to stdout
    process.stdout.write('\n' + formatSummaryLine(passed, failed, skipped, result.duration, result.setupDuration) + '\n\n')
  }
}

function extractLocation(error: Error): { file: string; line: number } | null {
  if (!error.stack) return null

  // Look for stack frames like "at ... (file:line:col)" or "at file:line:col"
  const lines = error.stack.split('\n')
  for (const line of lines) {
    // Match: "at Something (/path/to/file.ts:42:10)"
    const match = line.match(/\(([^)]+):(\d+):\d+\)/) ?? line.match(/at\s+([^:]+):(\d+):\d+/)
    if (match) {
      const file = match[1]
      const lineNum = parseInt(match[2], 10)
      // Only use test file paths (skip node_modules, internal frames)
      if (!file.includes('node_modules') && !file.startsWith('node:')) {
        return { file, line: lineNum }
      }
    }
  }

  return null
}

function escapeGitHub(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}
