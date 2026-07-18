/**
 * Shared ANSI helpers and utilities for console-based reporters.
 */

import * as fs from 'node:fs';
import { buildCodeSnippet } from '../trace/code-frame.js';
import { extractStack } from '../trace/trace-collector.js';
import type { TestResult } from '../runner.js';

// ─── ANSI codes ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
export function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
export function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
export function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

// ─── Formatting helpers ───

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function statusIcon(status: 'passed' | 'failed' | 'skipped'): string {
  switch (status) {
    case 'passed': return green('✓');
    case 'failed': return red('✗');
    case 'skipped': return yellow('○');
  }
}

export function formatSummaryLine(
  passed: number,
  failed: number,
  skipped: number,
  durationMs: number,
  setupDurationMs?: number,
  flaky?: number,
): string {
  const parts = [
    passed > 0 ? green(`${passed} passed`) : null,
    flaky ? yellow(`${flaky} flaky`) : null,
    failed > 0 ? red(`${failed} failed`) : null,
    skipped > 0 ? yellow(`${skipped} skipped`) : null,
  ].filter(Boolean);

  let timing: string;
  if (setupDurationMs != null && setupDurationMs > 0) {
    const testDuration = Math.max(0, durationMs - setupDurationMs);
    timing = ` | ${formatDuration(durationMs)} (setup ${formatDuration(setupDurationMs)}, tests ${formatDuration(testDuration)})`;
  } else {
    timing = ` | ${formatDuration(durationMs)}`;
  }

  return bold('Summary: ') + parts.join(', ') + dim(timing);
}

export function countFlaky(tests: TestResult[]): number {
  return tests.filter((t) => t.status === 'passed' && t.retry != null && t.retry > 0).length;
}

/**
 * Format the flaky-tests section for run summaries: each test that passed on
 * retry, with the first failed attempt's error and linked trace so the
 * failure is diagnosable without re-running. Returns '' when nothing flaked.
 */
export function formatFlakySection(
  tests: TestResult[],
  opts: { showWorkerTags?: boolean; showProjectTags?: boolean } = {},
): string {
  const flakyTests = tests.filter((t) => t.status === 'passed' && t.retry != null && t.retry > 0);
  if (flakyTests.length === 0) return '';
  const lines: string[] = [];
  lines.push(`  ${yellow(`${flakyTests.length} flaky`)}`);
  for (const test of flakyTests) {
    const worker = opts.showWorkerTags ? workerTag(test.workerIndex) : '';
    const project = opts.showProjectTags ? projectTag(test.project) : '';
    lines.push(`    ${worker}${project}${test.fullName}`);
    if (test.firstAttemptError) {
      lines.push(formatError(test.firstAttemptError));
    }
    if (test.tracePath) {
      const tag = test.failedAttemptArtifacts?.trace ? ' (failed attempt)' : '';
      lines.push(`        ${dim(`Trace${tag}: npx tapsmith show-trace ${test.tracePath}`)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function workerTag(workerIndex: number | undefined): string {
  if (workerIndex == null) return '';
  return dim(`[worker ${workerIndex}]`) + ' ';
}

export function projectTag(project: string | undefined): string {
  if (!project) return '';
  return dim(`[${project}]`) + ' ';
}

export function formatError(error: Error, indent: string = '        '): string {
  const lines: string[] = [];
  lines.push(`${indent}${red(error.message)}`);

  if (error.stack) {
    const stackLines = error.stack.split('\n').slice(1);

    // Find the first user-code frame via extractStack, which owns the
    // framework-frame classification: it skips tapsmith internals in BOTH
    // layouts (packages/tapsmith/* in the monorepo, node_modules/* for npm
    // installs) plus node internals. An ad-hoc '/packages/tapsmith/' check
    // here once missed npm installs and rendered snippets of dist/runner.js.
    const userLoc = extractStack(error.stack)[0];

    // Show code snippet from the user frame
    const snippet = userLoc ? extractCodeSnippet(userLoc.file, userLoc.line) : null;
    if (snippet) {
      lines.push('');
      for (const sl of snippet.lines) {
        const gutter = String(sl.lineNumber).padStart(snippet.gutterWidth);
        if (sl.highlight) {
          lines.push(`${indent}${red('>')} ${red(gutter)} ${red('|')} ${red(sl.text)}`);
        } else {
          lines.push(`${indent}  ${dim(gutter)} ${dim('|')} ${dim(sl.text)}`);
        }
      }
      lines.push('');
    }

    // Show first 3 stack frames
    for (const line of stackLines.slice(0, 3)) {
      lines.push(`${indent}${dim(line.trim())}`);
    }
  }
  return lines.join('\n');
}

// ─── Code snippet extraction ───

function extractCodeSnippet(filePath: string, lineNum: number): ReturnType<typeof buildCodeSnippet> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, 'utf-8');
    return buildCodeSnippet(source, lineNum);
  } catch {
    return null;
  }
}
