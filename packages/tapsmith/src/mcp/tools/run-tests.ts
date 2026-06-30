import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TestDispatcher, TestTreeEntry } from '../test-dispatcher.js';
import { readTraceSummary } from './trace-utils.js';
import { getAllDaemonAddresses } from '../connection.js';
import { matchesTestFilter } from '../../test-filter.js';

let _running = false;

export function registerRunTestsTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_run_tests',
    'Run Tapsmith test files and return structured results. Reports pass/fail counts and detailed failure information including error messages and trace file paths for debugging. Only one test run can execute at a time. Use tapsmith_list_tests first to discover available files, test names, and project names.',
    {
      files: z.array(z.string()).describe('Absolute file paths or glob patterns (e.g. ["/Users/me/project/e2e/tests/login.test.ts"]). Use tapsmith_list_tests to find available files.'),
      test: z.string().optional().describe('Run only tests whose full name contains this text (case-insensitive substring of "Describe > test name", e.g. "submits form"). May match more than one test, and applies across all the given files. If it matches nothing, the run returns an error listing the available tests — it never silently passes. Use tapsmith_list_tests to see exact names.'),
      project: z.string().optional().describe('Project name to target a specific platform/device (e.g. "android", "ios"). Use tapsmith_list_tests to see available projects. Required when the same test file runs on multiple platforms.'),
      device: z.string().optional().describe('Device serial (optional, ignored in UI mode — use project instead to target a platform)'),
    },
    async ({ files, test: testFilter, project, device }) => {
      if (dispatcher) {
        // Dispatcher-backed mode: UI sessions and headless MCP both provide test management.
        if (dispatcher.isRunning()) {
          return {
            content: [{ type: 'text' as const, text: 'A test run is already in progress. Wait for it to finish or use tapsmith_stop_tests to abort.' }],
            isError: true,
          };
        }
        const result = await dispatcher.runFiles(files, { testFilter, project });
        const content: CallToolResult['content'] = [];
        const screenshots: Buffer[] = [];

        // Render per-failure details (steps, device logs, trace path) and
        // collect any failure screenshots. Shared by the stopped-with-failures
        // and failed branches.
        const appendFailureDetails = (lines: string[]): void => {
          if (!result.failures || result.failures.length === 0) return;
          for (const f of result.failures) {
            const proj = f.projectName ? ` [${f.projectName}]` : '';
            lines.push('');
            lines.push(`FAIL: ${f.fullName}${proj}`);
            lines.push(`  Error: ${f.error}`);
            if (f.tracePath) {
              const summary = readTraceSummary(f.tracePath);
              if (summary) {
                if (summary.steps.length > 0) {
                  lines.push('');
                  lines.push('  Steps leading to failure:');
                  for (const step of summary.steps) lines.push(`    ${step}`);
                }
                if (summary.deviceLogs.length > 0) {
                  lines.push('');
                  lines.push('  Device logs (errors/warnings):');
                  for (const log of summary.deviceLogs) lines.push(`    ${log}`);
                }
                if (summary.failureScreenshot) screenshots.push(summary.failureScreenshot);
              }
              lines.push(`  Trace: ${f.tracePath}`);
            }
          }
        };
        const pushScreenshots = (): void => {
          for (const img of screenshots) {
            content.push({ type: 'image' as const, data: img.toString('base64'), mimeType: 'image/png' });
          }
        };

        const ran = result.passed + result.failed;

        if (result.status === 'stopped') {
          // User-requested stop: report partial results (not an error).
          const interrupted = result.interrupted ? `, ${result.interrupted} interrupted` : '';
          const lines: string[] = [
            result.failed > 0
              ? `Run stopped by user — partial results: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped${interrupted} (${result.duration}ms)`
              : `Run stopped by user — partial results: ${result.passed} passed, ${result.skipped} skipped${interrupted} (${result.duration}ms)`,
          ];
          appendFailureDetails(lines);
          content.push({ type: 'text' as const, text: lines.join('\n') });
          pushScreenshots();
          return { content };
        }

        if (testFilter && ran === 0) {
          // A test filter was supplied but nothing ran. Never report this as a
          // pass — surface an actionable error so the caller can correct it.
          return {
            content: [{ type: 'text' as const, text: buildZeroMatchMessage(dispatcher, files, testFilter) }],
            isError: true,
          };
        }

        if (result.failed > 0 || result.status === 'failed') {
          const lines: string[] = [
            result.failed > 0
              ? `Tests failed: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.duration}ms)`
              : `Test run failed — no tests executed (${result.passed} passed, ${result.skipped} skipped, ${result.duration}ms). Check that the requested file path(s) exist and were discovered (use tapsmith_list_tests).`,
          ];
          appendFailureDetails(lines);
          content.push({ type: 'text' as const, text: lines.join('\n') });
          pushScreenshots();
          return { content, isError: true };
        }

        content.push({
          type: 'text' as const,
          text: testFilter
            ? `All tests passed: ${result.passed} passed matching "${testFilter}" (${result.duration}ms)`
            : `All tests passed: ${result.passed} passed, ${result.skipped} skipped (${result.duration}ms)`,
        });
        return { content };
      }

      // Stdio mode: spawn tapsmith test subprocess
      if (_running) {
        return {
          content: [{ type: 'text' as const, text: 'A test run is already in progress. Wait for it to finish before starting another.' }],
          isError: true,
        };
      }

      _running = true;
      try {
        const args = ['test', ...files, '--trace', 'on'];
        if (testFilter) args.push('--test', testFilter);
        if (project) args.push('--project', project);
        if (device) args.push('--device', device);

        const result = await runTapsmithProcess(args);
        return { content: [{ type: 'text' as const, text: result }] };
      } finally {
        _running = false;
      }
    },
  );
}

/** Flatten the dispatcher's test tree into its `type: 'test'` leaf nodes. */
function flattenTestNodes(nodes: TestTreeEntry[], out: TestTreeEntry[] = []): TestTreeEntry[] {
  for (const node of nodes) {
    if (node.type === 'test') out.push(node);
    if (node.children) flattenTestNodes(node.children, out);
  }
  return out;
}

/**
 * Build an actionable error message for a `test` filter that ran nothing:
 * distinguishes an unknown/empty file, a typo'd filter (lists candidates), and
 * a filter that matched only `.skip()`'d tests.
 */
function buildZeroMatchMessage(dispatcher: TestDispatcher, files: string[], testFilter: string): string {
  const inFiles = flattenTestNodes(dispatcher.getTestTree()).filter((t) => files.includes(t.filePath));
  if (inFiles.length === 0) {
    return `No tests were found in the requested file(s): ${files.join(', ')}. Check the path(s) are correct and were discovered — run tapsmith_list_tests to see available files and tests.`;
  }
  const matched = inFiles.filter((t) => matchesTestFilter(t.fullName, testFilter));
  if (matched.length === 0) {
    const list = inFiles.map((t) => `  - "${t.fullName}"`).join('\n');
    return `No test matched "${testFilter}". The "test" argument is a case-insensitive substring of the full test name.\nAvailable tests:\n${list}\n\nPass one of these names (or a substring of one) as "test", or omit "test" to run the whole file.`;
  }
  const list = matched.map((t) => `  - "${t.fullName}"`).join('\n');
  return `"${testFilter}" matched ${matched.length} test(s), but they are all marked .skip() so nothing ran:\n${list}`;
}

function runTapsmithProcess(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      FORCE_COLOR: '0',
      TAPSMITH_REUSE_DAEMON: '1',
    };
    const daemonAddr = getAllDaemonAddresses();
    if (daemonAddr) env.TAPSMITH_DAEMON_ADDRESS = daemonAddr;

    const child = spawn(process.execPath, [process.argv[1], ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
      if (code !== 0) {
        resolve(`Tests failed (exit code ${code}):\n${output}`);
      } else {
        resolve(output || 'All tests passed.');
      }
    });

    child.on('error', (err) => {
      resolve(`Failed to run tapsmith: ${err.message}`);
    });
  });
}
