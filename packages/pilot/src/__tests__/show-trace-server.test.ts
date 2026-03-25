import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { zipSync } from 'fflate';

// We need to test the server module. Mock `open` to avoid opening a browser.
import { vi } from 'vitest';
vi.mock('open', () => ({ default: vi.fn() }));

import { showTrace } from '../trace/show-trace-server.js';

describe('showTrace', () => {
  let cleanup: (() => void) | undefined;
  let tempDir: string;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createDummyTrace(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-test-'));
    const metadata = { version: 1, testName: 'test', testStatus: 'passed', testDuration: 100, device: { serial: 'emu' } };
    const zipData = zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify(metadata)),
      'trace.json': new TextEncoder().encode(''),
    });
    const tracePath = path.join(tempDir, 'trace.zip');
    fs.writeFileSync(tracePath, zipData);
    return tracePath;
  }

  it('starts server and serves trace zip', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    expect(result.port).toBeGreaterThan(0);

    // Fetch the trace zip
    const resp = await fetch(`http://127.0.0.1:${result.port}/trace.zip`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('application/zip');
  });

  it('serves viewer HTML at root', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    const resp = await fetch(`http://127.0.0.1:${result.port}/`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/html');
  });

  it('returns 404 for unknown paths', async () => {
    const tracePath = createDummyTrace();
    const result = await showTrace({ tracePath, port: 0 });
    cleanup = result.close;

    const resp = await fetch(`http://127.0.0.1:${result.port}/unknown`);
    expect(resp.status).toBe(404);
  });

  it('throws for non-existent trace file', async () => {
    await expect(showTrace({ tracePath: '/tmp/nonexistent.zip' })).rejects.toThrow('not found');
  });

  it('throws for non-zip file', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-test-'));
    const txtPath = path.join(tempDir, 'trace.txt');
    fs.writeFileSync(txtPath, 'not a zip');
    await expect(showTrace({ tracePath: txtPath })).rejects.toThrow('.zip');
  });
});
