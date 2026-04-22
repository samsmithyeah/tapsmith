import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { zipSync } from 'fflate';
import { readTraceSummary } from '../mcp/tools/trace-utils.js';

function createTraceZip(events: object[], screenshots?: Record<string, Buffer>): string {
  const files: Record<string, Uint8Array> = {};
  const ndjson = events.map((e) => JSON.stringify(e)).join('\n');
  files['trace.json'] = new TextEncoder().encode(ndjson);
  files['metadata.json'] = new TextEncoder().encode(JSON.stringify({ version: 1 }));
  if (screenshots) {
    for (const [name, data] of Object.entries(screenshots)) {
      files[`screenshots/${name}`] = new Uint8Array(data);
    }
  }
  const zipped = zipSync(files);
  const tmp = path.join(os.tmpdir(), `test-trace-${Date.now()}.zip`);
  fs.writeFileSync(tmp, zipped);
  return tmp;
}

describe('readTraceSummary()', () => {
  it('returns undefined for nonexistent file', () => {
    expect(readTraceSummary('/nonexistent/trace.zip')).toBeUndefined();
  });

  it('extracts action and assertion steps', () => {
    const events = [
      { type: 'action', action: 'tap', selector: 'device.getByText("Login")', duration: 100 },
      { type: 'assertion', assertion: 'toBeVisible', duration: 50 },
      { type: 'assertion', assertion: 'toHaveText', error: 'Expected "A" toHaveText "B"', expected: 'B', actual: 'A', duration: 200 },
    ];
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip);
      expect(summary).toBeDefined();
      expect(summary!.steps.length).toBeGreaterThanOrEqual(3);
      expect(summary!.steps[0]).toContain('[OK] tap');
      expect(summary!.steps[0]).toContain('device.getByText("Login")');
      expect(summary!.steps[1]).toContain('[OK] expect toBeVisible');
      expect(summary!.steps[2]).toContain('[FAIL] expect toHaveText');
      expect(summary!.steps.some((s) => s.includes('Expected:'))).toBe(true);
      expect(summary!.steps.some((s) => s.includes('Actual:'))).toBe(true);
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('skips group-start events', () => {
    const events = [
      { type: 'group-start', title: 'Test' },
      { type: 'action', action: 'tap', duration: 100 },
      { type: 'group-start', title: 'afterEach' },
    ];
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip);
      expect(summary!.steps).toHaveLength(1);
      expect(summary!.steps[0]).toContain('tap');
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('limits to last N steps with omission notice', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      type: 'action', action: `step${i}`, duration: 10,
    }));
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip, 5);
      expect(summary!.steps[0]).toContain('10 earlier step(s) omitted');
      expect(summary!.steps).toHaveLength(6);
      expect(summary!.steps[5]).toContain('step14');
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('extracts last screenshot as failureScreenshot', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const zip = createTraceZip([], { 'action-000-before.png': png, 'action-001-after.png': png });
    try {
      const summary = readTraceSummary(zip);
      expect(summary!.failureScreenshot).toBeDefined();
      expect(summary!.failureScreenshot!.length).toBe(png.length);
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('includes expected/actual for failed assertions', () => {
    const events = [
      { type: 'assertion', assertion: 'toBe', error: 'fail', expected: false, actual: true, duration: 100 },
    ];
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip);
      expect(summary!.steps.some((s) => s.includes('Expected: false'))).toBe(true);
      expect(summary!.steps.some((s) => s.includes('Actual: true'))).toBe(true);
    } finally {
      fs.unlinkSync(zip);
    }
  });
});
