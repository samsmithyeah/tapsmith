import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';

export function registerAppControlTools(server: McpServer): void {
  server.tool(
    'tapsmith_launch_app',
    'Launch an app on the device. Set clear_data=true to start fresh (clears app storage).',
    {
      package: z.string().describe('Android package name or iOS bundle ID'),
      clear_data: z.boolean().optional().describe('Clear app data before launching'),
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ package: pkg, clear_data, device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);
      const { success, errorMessage } = await client.launchApp(pkg, {
        clearData: clear_data ?? false,
      });
      if (!success && errorMessage) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: 'OK' }] };
    },
  );
}
