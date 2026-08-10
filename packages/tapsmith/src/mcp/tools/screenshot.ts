import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceClientFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerScreenshotTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_screenshot',
    'Take a screenshot of the device screen. Returns a PNG image. Use when you need to visually verify what\'s on screen or when the accessibility tree is insufficient.',
    {
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);

      const { data, errorMessage } = await client.takeScreenshot();
      if (errorMessage) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
      }

      return {
        content: [{
          type: 'image' as const,
          data: Buffer.from(data).toString('base64'),
          mimeType: 'image/png',
        }],
      };
    },
  );
}
