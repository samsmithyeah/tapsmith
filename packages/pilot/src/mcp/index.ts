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

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'pilot',
    version: '0.1.0',
  });

  // Register tools
  registerSnapshotTool(server);
  registerScreenshotTool(server);
  registerTestSelectorTool(server);
  registerDeviceActionTools(server);
  registerAppControlTools(server);
  registerListDevicesTool(server);
  registerRunTestsTool(server);
  registerReadTraceTool(server);

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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', () => {
    closeClient();
    process.exit(0);
  });
}
