import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Everything else tests the MCP server in-process. Nothing tested that
// `tapsmith mcp-server` — the command every agent's config actually runs —
// starts, speaks the protocol on stdio, and shuts down cleanly. The failures
// this catches are the ones a unit test cannot see: a tool that throws while
// registering, output that corrupts the stream, an argument the CLI drops, and
// a SIGTERM that kills the process before it can release the daemon it started.
//
// No device is involved: every tool called here answers without one.

const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const TSX = path.join(PKG_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(PKG_ROOT, 'src', 'cli.ts');

/** Long enough for a cold tsx start on a loaded CI box, short enough to fail. */
const START_TIMEOUT_MS = 30_000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-mcp-stdio-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * The server's environment: its own activity file and a working directory with
 * no Tapsmith config, so a test can never disturb — or adopt — a real session's
 * state.
 */
function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TAPSMITH_MCP_ACTIVITY_FILE: path.join(tmpDir, 'activity.ndjson'),
    NO_COLOR: '1',
  };
}

function spawnServer(args: string[] = []): ChildProcessWithoutNullStreams {
  return spawn(TSX, [CLI, 'mcp-server', ...args], {
    cwd: tmpDir,
    env: serverEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('tapsmith mcp-server over real stdio', () => {
  it('serves the whole tool set, and dispatches a call, to a client that spawns it', async () => {
    const transport = new StdioClientTransport({
      command: TSX,
      args: [CLI, 'mcp-server'],
      cwd: tmpDir,
      env: serverEnv() as Record<string, string>,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-probe', version: '1.0.0' }, { capabilities: {} });

    try {
      await client.connect(transport);

      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      // A headless session registers the device tools and the test-running
      // tools both — this is the surface an agent's config buys.
      expect(names).toEqual([
        'tapsmith_launch_app',
        'tapsmith_list_devices',
        'tapsmith_list_results',
        'tapsmith_list_tests',
        'tapsmith_press_key',
        'tapsmith_read_trace',
        'tapsmith_run_tests',
        'tapsmith_screenshot',
        'tapsmith_session_info',
        'tapsmith_snapshot',
        'tapsmith_stop_tests',
        'tapsmith_suite_status',
        'tapsmith_swipe',
        'tapsmith_tap',
        'tapsmith_test_selector',
        'tapsmith_type',
        'tapsmith_watch',
      ]);

      const res = await client.callTool({
        name: 'tapsmith_read_trace',
        arguments: { path: path.join(tmpDir, 'no-such-trace.zip') },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('Trace file not found');

      // Still alive and answering after an error result.
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, START_TIMEOUT_MS);

  it('keeps its banner off stdout, where it would corrupt the protocol', async () => {
    // The server prints a figlet banner and connection instructions on start.
    // On stdout, every one of those lines is a parse error for the client, and
    // the session dies before the first tool call.
    const child = spawnServer();
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    try {
      const request = (id: number, method: string, params: unknown = {}) =>
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

      child.stdin.write(request(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'raw-probe', version: '1.0.0' },
      }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(request(2, 'tools/list'));

      await waitFor(() => stdout.includes('"id":2'), START_TIMEOUT_MS);

      const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(() => JSON.parse(line), `stdout line is not JSON-RPC: ${line}`).not.toThrow();
        expect(JSON.parse(line).jsonrpc).toBe('2.0');
      }
      // The banner is not lost — it just belongs on the other stream.
      expect(stderr).toContain('MCP server running on stdio transport');
    } finally {
      child.kill('SIGKILL');
    }
  }, START_TIMEOUT_MS);

  it('runs its own shutdown on SIGTERM instead of being killed by it', async () => {
    // A stdio client kills its server with SIGTERM. Node's default handling
    // terminates the process without running any cleanup — orphaning the
    // daemon, and the device agent behind it, that the session started.
    const child = spawnServer();
    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });

    // Answering on stdout is the only readiness signal that does not depend on
    // what the banner happens to say.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-probe', version: '1.0.0' } },
    })}\n`);
    await waitFor(() => stdout.includes('"id":1'), START_TIMEOUT_MS);
    child.kill('SIGTERM');

    // Cleanup then exit(0). Without the handler the process dies to the signal
    // instead — reported as signal SIGTERM, or as code 143 through a wrapper.
    const { code, signal } = await exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, START_TIMEOUT_MS);
});

describe('tapsmith mcp-server arguments', () => {
  it('documents the flags an agent config needs, and exits', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--config');
    expect(stdout).toContain('claude mcp add tapsmith -- npx tapsmith mcp-server');
  }, START_TIMEOUT_MS);

  it('refuses an argument it does not know rather than starting anyway', async () => {
    // Starting despite a misspelled flag is worse than failing: the session
    // runs against the wrong config and nothing says so.
    const { code, stderr } = await run(['--confg', 'tapsmith.config.mjs']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('--confg');
  }, START_TIMEOUT_MS);
});

// ─── Helpers ───

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnServer(args);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
