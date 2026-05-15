import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';

export function registerScreenshotTool(server: McpServer): void {
  server.tool(
    'tapsmith_screenshot',
    'Take a screenshot of the device screen. Returns a PNG image. Use when you need to visually verify what\'s on screen or when the accessibility tree is insufficient.',
    {
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);

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
