import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerRunTestsTool(server: McpServer): void {
  server.tool(
    'pilot_run_tests',
    'Run Pilot test files and return structured results. Reports pass/fail counts and detailed failure information including error messages and trace file paths for debugging.',
    {
      files: z.array(z.string()).describe('Test file paths or glob patterns'),
      grep: z.string().optional().describe('Filter tests by name pattern'),
      device: z.string().optional().describe('Device serial (optional)'),
    },
    async ({ files, grep, device }) => {
      const args = ['test', ...files, '--trace', 'on'];
      if (grep) args.push('--grep', grep);
      if (device) args.push('--device', device);

      const result = await runPilotProcess(args);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
}

function runPilotProcess(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('pilot', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
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
