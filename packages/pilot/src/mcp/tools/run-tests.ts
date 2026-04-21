import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

let _running = false;

export function registerRunTestsTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'pilot_run_tests',
    'Run Pilot test files and return structured results. Reports pass/fail counts and detailed failure information including error messages and trace file paths for debugging. Only one test run can execute at a time.',
    {
      files: z.array(z.string()).describe('Test file paths or glob patterns'),
      test: z.string().optional().describe('Run a specific test by its full name (e.g. "Login screen > submits form"). Only works with a single file.'),
      project: z.string().optional().describe('Project name to run tests in (use pilot_list_tests to see available projects)'),
      device: z.string().optional().describe('Device serial (optional, ignored in UI mode)'),
    },
    async ({ files, test: testFilter, project, device }) => {
      if (dispatcher) {
        // SSE mode: delegate to UI server's test dispatcher
        if (dispatcher.isRunning()) {
          return {
            content: [{ type: 'text' as const, text: 'A test run is already in progress. Wait for it to finish or use pilot_stop_tests to abort.' }],
            isError: true,
          };
        }
        const result = await dispatcher.runFiles(files, { testFilter, project });
        const text = result.failed > 0
          ? `Tests failed: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped (${result.duration}ms)`
          : `All tests passed: ${result.passed} passed, ${result.skipped} skipped (${result.duration}ms)`;
        return { content: [{ type: 'text' as const, text }] };
      }

      // Stdio mode: spawn pilot test subprocess
      if (_running) {
        return {
          content: [{ type: 'text' as const, text: 'A test run is already in progress. Wait for it to finish before starting another.' }],
          isError: true,
        };
      }

      _running = true;
      try {
        const args = ['test', ...files, '--trace', 'on'];
        if (device) args.push('--device', device);

        const result = await runPilotProcess(args);
        return { content: [{ type: 'text' as const, text: result }] };
      } finally {
        _running = false;
      }
    },
  );
}

function runPilotProcess(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('pilot', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', PILOT_REUSE_DAEMON: '1' },
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
      resolve(`Failed to run pilot: ${err.message}`);
    });
  });
}
