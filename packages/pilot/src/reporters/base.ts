/**
 * Shared ANSI helpers and utilities for console-based reporters.
 */

// ─── ANSI codes ───

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

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
export function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`
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
  return cyan(`[worker ${workerIndex}]`) + ' '
}

export function formatError(error: Error, indent: string = '        '): string {
  const lines: string[] = []
  lines.push(`${indent}${red(error.message)}`)
  if (error.stack) {
    const stackLines = error.stack.split('\n').slice(1, 4)
    for (const line of stackLines) {
      lines.push(`${indent}${dim(line.trim())}`)
    }
  }
  return lines.join('\n')
}
