import * as fs from 'node:fs';
import { unzipSync } from 'fflate';

export interface TraceEvent {
  type: string
  action?: string
  assertion?: string
  selector?: string
  title?: string
  error?: string
  expected?: unknown
  actual?: unknown
  duration?: number
}

export interface TraceSummary {
  steps: string[]
  failureScreenshot?: Buffer
}

export function readTraceSummary(tracePath: string, maxSteps = 10): TraceSummary | undefined {
  try {
    if (!fs.existsSync(tracePath)) return undefined;
    const zipData = new Uint8Array(fs.readFileSync(tracePath));
    const files = unzipSync(zipData);
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);

    const steps: string[] = [];

    if (files['trace.json']) {
      const events: TraceEvent[] = decode(files['trace.json'])
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

      // Take last N meaningful events (actions + assertions, skip group markers)
      const meaningful = events.filter((e) => e.type === 'action' || e.type === 'assertion');
      const tail = meaningful.slice(-maxSteps);

      for (const event of tail) {
        const status = event.error ? 'FAIL' : 'OK';
        const dur = event.duration ? ` (${event.duration}ms)` : '';
        if (event.type === 'action') {
          const sel = event.selector ? ` on ${event.selector}` : '';
          steps.push(`[${status}] ${event.action ?? 'action'}${sel}${dur}`);
        } else if (event.type === 'assertion') {
          steps.push(`[${status}] expect ${event.assertion ?? 'assertion'}${dur}`);
          if (event.error) {
            if (event.expected !== undefined) steps.push(`  Expected: ${JSON.stringify(event.expected)}`);
            if (event.actual !== undefined) steps.push(`  Actual: ${JSON.stringify(event.actual)}`);
          }
        }
      }

      if (meaningful.length > maxSteps) {
        steps.unshift(`... ${meaningful.length - maxSteps} earlier step(s) omitted`);
      }
    }

    // Find failure screenshot (last screenshot in the archive)
    let failureScreenshot: Buffer | undefined;
    const screenshotNames = Object.keys(files)
      .filter((name) => name.startsWith('screenshots/') && name.endsWith('.png'))
      .sort();
    if (screenshotNames.length > 0) {
      const last = screenshotNames[screenshotNames.length - 1];
      failureScreenshot = Buffer.from(files[last]);
    }

    return { steps, failureScreenshot };
  } catch {
    return undefined;
  }
}
