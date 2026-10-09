import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { traceFormatProblem } from '../../trace/trace-format.js';
import {
  clipText, MCP_IMAGE_BUDGET_BYTES, MCP_TEXT_BUDGET_BYTES, serializedTextBytes, truncateMiddle,
} from '../response-limits.js';

/**
 * One step value (an error, an expected or actual value) as shown. Errors can
 * carry a whole hierarchy dump; a few hundred such steps made one response
 * too big for the MCP client (PILOT-657).
 */
const STEP_VALUE_CHARS = 2_000;
const LOG_LINE_CHARS = 500;
/**
 * Most of the text budget the device logs may take. They come after the
 * steps, so left to the response boundary a long log section would fill the
 * kept tail and cut the failing step — the end of the steps — instead.
 */
const LOGS_BUDGET_BYTES = 24 * 1024;
/** Text budget held back for the screenshot labels and notes. */
const NOTES_RESERVE_BYTES = 4 * 1024;

export function registerReadTraceTool(server: McpServer): void {
  server.tool(
    'tapsmith_read_trace',
    'Read a Tapsmith trace archive (.zip) and get step-by-step test execution data. Returns actions with their locators, durations, and pass/fail status. Use to debug why a test failed. Long step values are shortened, and with include_screenshots the latest screenshots that fit the response limit are returned.',
    {
      path: z.string().describe('Path to the trace .zip file'),
      include_screenshots: z.boolean().optional().describe('Include base64 screenshots for each step (default false)'),
      device_logs: z.enum(['errors', 'all', 'none']).optional().describe('Include device logs: "errors" for error/warn only (default), "all" for all levels, "none" to exclude'),
    },
    async ({ path: tracePath, include_screenshots, device_logs }) => {
      const resolved = path.resolve(tracePath);
      if (!resolved.endsWith('.zip')) {
        return { content: [{ type: 'text' as const, text: 'Invalid trace path: must be a .zip file' }], isError: true };
      }
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: 'text' as const, text: `Trace file not found: ${resolved}` }], isError: true };
      }

      try {
        const content = readTraceArchive(resolved, include_screenshots ?? false, device_logs ?? 'errors');
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

function readTraceArchive(tracePath: string, includeScreenshots: boolean, deviceLogs: 'errors' | 'all' | 'none'): ContentItem[] {
  const zipData = new Uint8Array(fs.readFileSync(tracePath));
  const files = unzipSync(zipData);
  const lines: string[] = [];

  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  // Read metadata. The version gate comes first: a newer format may have
  // moved or re-meant any field below, and a misread is worse than a refusal.
  const meta = (files['metadata.json'] ? JSON.parse(decode(files['metadata.json'])) : undefined) as
    | {
      devices?: unknown
      device?: { name?: string; serial?: string; model?: string; platform?: string }
      version?: number
      testFile?: string
      testDuration?: number
      duration?: number
    }
    | undefined;
  const problem = traceFormatProblem(meta);
  if (problem) throw new Error(problem);
  if (meta) {
    lines.push(`## Trace Metadata`);
    // Multi-device traces list every device by its group name — the same
    // name each step below carries — so the steps read as a conversation.
    const devices: Array<{ name?: string; serial?: string; model?: string; platform?: string }> =
      Array.isArray(meta.devices) && meta.devices.length > 1 ? meta.devices : meta.device ? [meta.device] : [];
    for (const d of devices) {
      const who = devices.length > 1 && d.name ? ` ${d.name}` : '';
      lines.push(`Device${who}: ${d.model ?? d.serial ?? 'unknown'} (${d.platform ?? 'unknown'})`);
    }
    if (meta.testFile) {
      // From format v2 the path is relative to the project's rootDir, which the
      // archive does not record — say so, or an agent resolves it against its
      // own working directory and opens the wrong file.
      const relative = (meta.version ?? 1) >= 2 ? " (relative to the project's rootDir)" : '';
      lines.push(`Test: ${meta.testFile}${relative}`);
    }
    // `testDuration` is the archive's field; `duration` was what this read
    // before (never present, so the line never printed).
    const duration = meta.testDuration ?? meta.duration;
    if (duration) lines.push(`Duration: ${duration}ms`);
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
      // Which device acted, for a two-user test's interleaved steps.
      const who = event.deviceId ? `${event.deviceId}: ` : '';

      if (event.type === 'action') {
        lines.push(`${i + 1}. [${status}] ${who}${event.action ?? 'action'}${duration}`);
        if (event.selector) lines.push(`   Locator: ${event.selector}`);
        if (event.error) lines.push(`   Error: ${clipText(String(event.error), STEP_VALUE_CHARS)}`);
      } else if (event.type === 'assertion') {
        lines.push(`${i + 1}. [${status}] ${who}expect ${event.assertion ?? 'assertion'}${duration}`);
        if (event.expected !== undefined) lines.push(`   Expected: ${clipText(String(event.expected), STEP_VALUE_CHARS)}`);
        if (event.actual !== undefined) lines.push(`   Actual: ${clipText(String(event.actual), STEP_VALUE_CHARS)}`);
        if (event.error) lines.push(`   Error: ${clipText(String(event.error), STEP_VALUE_CHARS)}`);
      } else if (event.type === 'group-start') {
        lines.push(`\n### ${event.title ?? 'Test'}`);
      }
    }

    // Device logs
    const logLines: string[] = [];
    if (deviceLogs !== 'none') {
      const isErrorOnly = deviceLogs === 'errors';
      const logEvents = events.filter((e: Record<string, unknown>) =>
        e.type === 'console' && e.source === 'device'
        && (!isErrorOnly || e.level === 'error' || e.level === 'warn'),
      );
      // One section per device in a multi-device trace; the untagged bucket
      // is the single device of an ordinary run.
      const byDevice = new Map<string | undefined, Record<string, unknown>[]>();
      for (const ev of logEvents) {
        const key = ev.deviceId as string | undefined;
        const bucket = byDevice.get(key) ?? [];
        bucket.push(ev);
        byDevice.set(key, bucket);
      }
      for (const [deviceId, bucket] of byDevice) {
        const cap = isErrorOnly ? 50 : 200;
        const shown = bucket.slice(-cap);
        logLines.push('');
        logLines.push(`## Device Logs${deviceId ? ` — ${deviceId}` : ''} (${bucket.length} entries${bucket.length > cap ? `, showing last ${cap}` : ''})`);
        logLines.push('');
        for (const ev of shown) {
          logLines.push(`[${(ev.level as string)?.toUpperCase()}] ${clipText(String(ev.message ?? ''), LOG_LINE_CHARS)}`);
        }
      }
    }
    // Bound the two parts separately: the steps keep their start and their
    // end (where the failure is) however long the log section is.
    const logsText = truncateMiddle(logLines.join('\n'), LOGS_BUDGET_BYTES, 'Pass device_logs "none" to leave them out.');
    const stepsBudget = MCP_TEXT_BUDGET_BYTES - NOTES_RESERVE_BYTES - serializedTextBytes(logsText);
    const stepsText = truncateMiddle(lines.join('\n'), stepsBudget, 'The trace\'s first and last steps are kept; the failure is at the end.');
    lines.length = 0;
    lines.push(stepsText);
    if (logsText) lines.push(logsText);
  }

  const content: ContentItem[] = [{ type: 'text', text: lines.join('\n') }];

  if (includeScreenshots) {
    const screenshotNames = Object.keys(files)
      .filter(name => name.startsWith('screenshots/') && name.endsWith('.png'))
      .sort();
    // The latest screenshots matter most (the failure is at the end), so fill
    // the response's image budget from the last one backwards.
    let budget = MCP_IMAGE_BUDGET_BYTES;
    let first = screenshotNames.length;
    while (first > 0) {
      const encoded = Math.ceil(files[screenshotNames[first - 1]].length / 3) * 4;
      if (encoded > budget) break;
      budget -= encoded;
      first -= 1;
    }
    if (first > 0) {
      content.push({
        type: 'text',
        text: `\n[${first} earlier screenshot(s) omitted to stay within the MCP response limit; showing the last ${screenshotNames.length - first}.]`,
      });
    }
    for (const name of screenshotNames.slice(first)) {
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
