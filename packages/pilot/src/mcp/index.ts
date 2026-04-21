import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { closeClient } from './connection.js';
import { type McpEventEmitter, nextCallId, summarizeResult } from './events.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function createMcpServer(events?: McpEventEmitter): McpServer {
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
  registerRunTestsTool(server);
  registerReadTraceTool(server);

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
  // The MCP SDK exposes registered tools via the internal _registeredTools map.
  // We intercept the tool request handler to emit events.
  const originalSetToolHandler = server.server.setRequestHandler.bind(server.server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intercepting internal SDK handler
  server.server.setRequestHandler = function (schema: any, handler: any) {
    if (schema?.method === 'tools/call') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrapping the original handler
      const wrappedHandler = async (request: any, extra: any) => {
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
          const result = await handler(request, extra) as { result: CallToolResult };
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
      };
      return originalSetToolHandler(schema, wrappedHandler);
    }
    return originalSetToolHandler(schema, handler);
  };
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => {
    closeClient();
    process.exit(0);
  });
}
