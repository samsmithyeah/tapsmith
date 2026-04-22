import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';

export function registerListDevicesTool(server: McpServer): void {
  server.tool(
    'pilot_list_devices',
    'List all connected mobile devices and emulators. Shows serial numbers needed for multi-device targeting.',
    {},
    async () => {
      const client = await ensureConnected();
      const { devices } = await client.listDevices();

      const result = devices.map(d => ({
        serial: d.serial,
        model: d.model,
        platform: d.platform,
        os_version: d.osVersion,
        is_emulator: d.isEmulator,
        state: d.state,
      }));

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
