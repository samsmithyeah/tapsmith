import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerReadTraceTool(server: McpServer): void {
  server.tool(
    'pilot_read_trace',
    'Read a Pilot trace archive (.zip) and get step-by-step test execution data. Returns actions with their selectors, durations, and pass/fail status. Use to debug why a test failed.',
    {
      path: z.string().describe('Path to the trace .zip file'),
      include_screenshots: z.boolean().optional().describe('Include base64 screenshots for each step (default false)'),
    },
    async ({ path: tracePath, include_screenshots }) => {
      if (!fs.existsSync(tracePath)) {
        return { content: [{ type: 'text' as const, text: `Trace file not found: ${tracePath}` }], isError: true };
      }

      try {
        const result = readTraceArchive(tracePath, include_screenshots ?? false);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Failed to read trace: ${msg}` }], isError: true };
      }
    },
  );
}

function readTraceArchive(tracePath: string, includeScreenshots: boolean): string {
  const zipData = new Uint8Array(fs.readFileSync(tracePath));
  const files = unzipSync(zipData);
  const lines: string[] = [];

  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  // Read metadata
  if (files['metadata.json']) {
    const meta = JSON.parse(decode(files['metadata.json']));
    lines.push(`## Trace Metadata`);
    if (meta.device) lines.push(`Device: ${meta.device.model ?? 'unknown'} (${meta.device.platform ?? 'unknown'})`);
    if (meta.testFile) lines.push(`Test: ${meta.testFile}`);
    if (meta.duration) lines.push(`Duration: ${meta.duration}ms`);
    lines.push('');
  }

  // Read trace events
  if (files['trace.json']) {
    const traceData = decode(files['trace.json']);
    const events = traceData.split('\n').filter(Boolean).map((line: string) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    lines.push(`## Steps (${events.length} events)`);
    lines.push('');

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const status = event.error ? 'FAIL' : 'OK';
      const duration = event.duration ? ` (${event.duration}ms)` : '';

      if (event.type === 'action') {
        lines.push(`${i + 1}. [${status}] ${event.action ?? 'action'}${duration}`);
        if (event.selector) lines.push(`   Selector: ${event.selector}`);
        if (event.error) lines.push(`   Error: ${event.error}`);
      } else if (event.type === 'assertion') {
        lines.push(`${i + 1}. [${status}] expect ${event.assertion ?? 'assertion'}${duration}`);
        if (event.expected !== undefined) lines.push(`   Expected: ${event.expected}`);
        if (event.actual !== undefined) lines.push(`   Actual: ${event.actual}`);
        if (event.error) lines.push(`   Error: ${event.error}`);
      } else if (event.type === 'group-start') {
        lines.push(`\n### ${event.title ?? 'Test'}`);
      }
    }
  }

  if (includeScreenshots) {
    const screenshotNames = Object.keys(files).filter(
      name => name.startsWith('screenshots/') && name.endsWith('.png'),
    );
    if (screenshotNames.length > 0) {
      lines.push('');
      lines.push(`## Screenshots (${screenshotNames.length} captured)`);
      for (const name of screenshotNames) {
        const baseName = path.basename(name, '.png');
        lines.push(`\n### ${baseName}`);
        lines.push(`[base64:${Buffer.from(files[name]).toString('base64').slice(0, 100)}...]`);
      }
    }
  }

  return lines.join('\n');
}
