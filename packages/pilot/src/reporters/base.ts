/**
 * Shared ANSI helpers and utilities for console-based reporters.
 */

import * as fs from 'node:fs'

// ─── ANSI codes ───

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

export function green(s: string): string {
  return `${GREEN}${s}${RESET}`
}
export function red(s: string): string {
  return `${RED}${s}${RESET}`
}
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`
}
export function bold(s: string): string {
  return `${BOLD}${s}${RESET}`
}
export function dim(s: string): string {
  return `${DIM}${s}${RESET}`
}

// ─── Formatting helpers ───

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function statusIcon(status: 'passed' | 'failed' | 'skipped'): string {
  switch (status) {
    case 'passed': return green('✓')
    case 'failed': return red('✗')
    case 'skipped': return yellow('○')
  }
}

export function formatSummaryLine(
  passed: number,
  failed: number,
  skipped: number,
  durationMs: number,
  setupDurationMs?: number,
): string {
  const parts = [
    passed > 0 ? green(`${passed} passed`) : null,
    failed > 0 ? red(`${failed} failed`) : null,
    skipped > 0 ? yellow(`${skipped} skipped`) : null,
  ].filter(Boolean)

  let timing: string
  if (setupDurationMs != null && setupDurationMs > 0) {
    const testDuration = Math.max(0, durationMs - setupDurationMs)
    timing = ` | ${formatDuration(durationMs)} (setup ${formatDuration(setupDurationMs)}, tests ${formatDuration(testDuration)})`
  } else {
    timing = ` | ${formatDuration(durationMs)}`
  }

  return bold('Summary: ') + parts.join(', ') + dim(timing)
}

export function workerTag(workerIndex: number | undefined): string {
  if (workerIndex == null) return ''
  return dim(`[worker ${workerIndex}]`) + ' '
}

export function projectTag(project: string | undefined): string {
  if (!project) return ''
  return dim(`[${project}]`) + ' '
}

export function formatError(error: Error, indent: string = '        '): string {
  const lines: string[] = []
  lines.push(`${indent}${red(error.message)}`)

  if (error.stack) {
    const stackLines = error.stack.split('\n').slice(1)

    // Find the first user-code frame (not Pilot internals or node internals)
    const userFrame = stackLines.find(
      (l) => !l.includes('/packages/pilot/') && !l.includes('node:internal/') && l.includes(':'),
    )

    // Show code snippet from the user frame
    const snippet = userFrame ? extractCodeSnippet(userFrame.trim()) : null
    if (snippet) {
      lines.push('')
      for (const sl of snippet.lines) {
        const gutter = String(sl.lineNumber).padStart(snippet.gutterWidth)
        if (sl.highlight) {
          lines.push(`${indent}${red('>')} ${red(gutter)} ${red('|')} ${red(sl.text)}`)
        } else {
          lines.push(`${indent}  ${dim(gutter)} ${dim('|')} ${dim(sl.text)}`)
        }
      }
      lines.push('')
    }

    // Show first 3 stack frames
    for (const line of stackLines.slice(0, 3)) {
      lines.push(`${indent}${dim(line.trim())}`)
    }
  }
  return lines.join('\n')
}

// ─── Code snippet extraction ───

interface SnippetLine {
  lineNumber: number
  text: string
  highlight: boolean
}

function extractCodeSnippet(frame: string): { lines: SnippetLine[]; gutterWidth: number } | null {
  // Parse "at ... (file:line:col)" or "at file:line:col"
  const match = frame.match(/\(?([^()]+):(\d+):\d+\)?$/)
  if (!match) return null

  const filePath = match[1]
  const lineNum = parseInt(match[2], 10)
  if (isNaN(lineNum)) return null

  try {
    if (!fs.existsSync(filePath)) return null
    const source = fs.readFileSync(filePath, 'utf-8')
    const sourceLines = source.split('\n')

    const contextSize = 2
    const start = Math.max(0, lineNum - 1 - contextSize)
    const end = Math.min(sourceLines.length, lineNum + contextSize)

    const result: SnippetLine[] = []
    for (let i = start; i < end; i++) {
      result.push({
        lineNumber: i + 1,
        text: sourceLines[i],
        highlight: i + 1 === lineNum,
      })
    }

    const gutterWidth = String(end).length
    return { lines: result, gutterWidth }
  } catch {
    return null
  }
}
