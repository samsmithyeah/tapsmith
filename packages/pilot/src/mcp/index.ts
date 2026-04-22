import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSnapshotTool } from './tools/snapshot.js';
import { registerScreenshotTool } from './tools/screenshot.js';
import { registerTestSelectorTool } from './tools/test-selector.js';
import { registerDeviceActionTools } from './tools/device-actions.js';
import { registerAppControlTools } from './tools/app-control.js';
import { registerListDevicesTool } from './tools/list-devices.js';
import { registerRunTestsTool } from './tools/run-tests.js';
import { registerReadTraceTool } from './tools/read-trace.js';
import { registerListResultsTool } from './tools/list-results.js';
import { registerListTestsTool } from './tools/list-tests.js';
import { registerStopTestsTool } from './tools/stop-tests.js';
import { registerSessionInfoTool } from './tools/session-info.js';
import { registerWatchTool } from './tools/watch.js';
import { closeClient } from './connection.js';
import { uiPortFilePath } from './port-file.js';
import { McpEventEmitter, nextCallId, summarizeResult } from './events.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TestDispatcher } from './test-dispatcher.js';

export type {
  TestDispatcher, TestRunResult, TestResultEntry, TestFailureDetail,
  TestTreeEntry, ProjectInfo, SessionInfo,
} from './test-dispatcher.js';

export interface McpServerOptions {
  events?: McpEventEmitter
  dispatcher?: TestDispatcher
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const { events, dispatcher } = options ?? {};

  const server = new McpServer({
    name: 'pilot',
    version: '0.1.0',
  });

  registerSnapshotTool(server);
  registerScreenshotTool(server);
  registerTestSelectorTool(server);
  registerDeviceActionTools(server);
  registerAppControlTools(server);
  registerListDevicesTool(server);
  registerRunTestsTool(server, dispatcher);
  registerReadTraceTool(server);

  if (dispatcher) {
    registerListTestsTool(server, dispatcher);
    registerListResultsTool(server, dispatcher);
    registerStopTestsTool(server, dispatcher);
    registerSessionInfoTool(server, dispatcher);
    registerWatchTool(server, dispatcher);
  }

  // Wrap tool handlers with event emission
  if (events) {
    wrapToolsWithEvents(server, events);
  }

  // Register API reference as a resource
  // __dirname points to dist/mcp/ or src/mcp/ depending on build vs tsx
  const apiRefPath = path.resolve(__dirname, '../../../docs/api-reference.md');
  if (fs.existsSync(apiRefPath)) {
    server.resource(
      'Pilot API Reference',
      'pilot://api-reference',
      { description: 'Complete API reference for the Pilot mobile testing framework. Read this to understand available methods when writing tests.', mimeType: 'text/markdown' },
      () => ({
        contents: [{
          uri: 'pilot://api-reference',
          text: fs.readFileSync(apiRefPath, 'utf-8'),
          mimeType: 'text/markdown',
        }],
      }),
    );
  }

  return server;
}

function wrapToolsWithEvents(server: McpServer, events: McpEventEmitter): void {
  // The SDK sets the tools/call handler during tool registration (before we
  // get here). Access the internal handler map and wrap the existing handler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private _requestHandlers
  const handlers = (server.server as any)._requestHandlers as Map<string, (...args: unknown[]) => unknown>;
  const original = handlers.get('tools/call');
  if (!original) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrapping internal handler
  handlers.set('tools/call', async (request: any, extra: any) => {
    const toolName = request.params?.name as string;
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const callId = nextCallId();
    const start = Date.now();

    events.emitToolCall({
      id: callId,
      tool: toolName,
      args,
      status: 'started',
      timestamp: start,
    });

    try {
      const result = await original(request, extra) as { result: CallToolResult };
      const elapsed = Date.now() - start;
      const resultText = (result.result?.content ?? [])
        .filter((c: { type: string }) => c.type === 'text')
        .map((c) => 'text' in c ? (c as { text: string }).text : '')
        .join('\n');

      events.emitToolCall({
        id: callId,
        tool: toolName,
        args,
        status: result.result?.isError ? 'error' : 'completed',
        resultSummary: summarizeResult(toolName, resultText),
        error: result.result?.isError ? resultText : undefined,
        durationMs: elapsed,
        timestamp: start,
      });

      return result;
    } catch (err) {
      events.emitToolCall({
        id: callId,
        tool: toolName,
        args,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        timestamp: start,
      });
      throw err;
    }
  });
}

export async function runMcpServer(): Promise<void> {
  // Discover UI server for event reporting
  const uiPort = discoverUiServerPort();
  const events = uiPort ? new McpEventEmitter() : undefined;

  if (uiPort) {
    const sseUrl = `http://localhost:${uiPort}/mcp`;
    process.stderr.write(
      `[pilot-mcp] UI mode detected at ${sseUrl}\n` +
      `[pilot-mcp] For shared-session mode (recommended), connect via SSE instead:\n` +
      `[pilot-mcp]   claude mcp add pilot --transport sse ${sseUrl}\n`,
    );
  }

  if (events && uiPort) {
    events.onToolCall((event) => {
      postToUiServer(uiPort, '/mcp-events', event);
    });
  }

  const server = createMcpServer({ events });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => {
    closeClient();
    process.exit(0);
  });
}

function discoverUiServerPort(): number | null {
  try {
    const portFile = uiPortFilePath();
    const content = fs.readFileSync(portFile, 'utf-8').trim();
    const port = parseInt(content, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // No UI server running
  }
  return null;
}

function postToUiServer(port: number, urlPath: string, data: unknown): void {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: urlPath,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.end(body);
}
