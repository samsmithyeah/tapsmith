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
      const resolved = path.resolve(tracePath);
      if (!resolved.endsWith('.zip')) {
        return { content: [{ type: 'text' as const, text: 'Invalid trace path: must be a .zip file' }], isError: true };
      }
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: 'text' as const, text: `Trace file not found: ${resolved}` }], isError: true };
      }

      try {
        const content = readTraceArchive(resolved, include_screenshots ?? false);
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Failed to read trace: ${msg}` }], isError: true };
      }
    },
  );
}

type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function readTraceArchive(tracePath: string, includeScreenshots: boolean): ContentItem[] {
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

  const content: ContentItem[] = [{ type: 'text', text: lines.join('\n') }];

  if (includeScreenshots) {
    const screenshotNames = Object.keys(files)
      .filter(name => name.startsWith('screenshots/') && name.endsWith('.png'))
      .sort();
    for (const name of screenshotNames) {
      const label = path.basename(name, '.png');
      content.push({ type: 'text', text: `\n### Screenshot: ${label}` });
      content.push({
        type: 'image',
        data: Buffer.from(files[name]).toString('base64'),
        mimeType: 'image/png',
      });
    }
  }

  return content;
}
