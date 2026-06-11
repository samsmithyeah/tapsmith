import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { readTraceSummary } from './trace-utils.js';
import { getAllDaemonAddresses } from '../connection.js';

let _running = false;

export function registerRunTestsTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_run_tests',
    'Run Tapsmith test files and return structured results. Reports pass/fail counts and detailed failure information including error messages and trace file paths for debugging. Only one test run can execute at a time. Use tapsmith_list_tests first to discover available files, test names, and project names.',
    {
      files: z.array(z.string()).describe('Absolute file paths or glob patterns (e.g. ["/Users/me/project/e2e/tests/login.test.ts"]). Use tapsmith_list_tests to find available files.'),
      test: z.string().optional().describe('Run a specific test by its full name (e.g. "Login screen > submits form"). Only works with a single file. Use tapsmith_list_tests to see exact test names.'),
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

        if (result.status === 'stopped' && result.failed === 0) {
          const interrupted = result.interrupted ? `, ${result.interrupted} interrupted` : '';
          content.push({ type: 'text' as const, text: `Run stopped by user — partial results: ${result.passed} passed, ${result.skipped} skipped${interrupted} (${result.duration}ms)` });
        } else if (result.failed > 0 || result.status === 'stopped') {
          const lines: string[] = [];
          const screenshots: Buffer[] = [];
          const interrupted = result.interrupted ? `, ${result.interrupted} interrupted` : '';
          lines.push(result.status === 'stopped'
            ? `Run stopped by user — partial results: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped${interrupted} (${result.duration}ms)`
            : `Tests failed: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.duration}ms)`);

          if (result.failures && result.failures.length > 0) {
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
          }

          content.push({ type: 'text' as const, text: lines.join('\n') });
          for (const img of screenshots) {
            content.push({ type: 'image' as const, data: img.toString('base64'), mimeType: 'image/png' });
          }
        } else {
          content.push({ type: 'text' as const, text: `All tests passed: ${result.passed} passed, ${result.skipped} skipped (${result.duration}ms)` });
        }
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
