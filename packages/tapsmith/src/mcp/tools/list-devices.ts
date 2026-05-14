import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAllDevices, getSessionDeviceSerials } from '../connection.js';

export function registerListDevicesTool(server: McpServer): void {
  server.tool(
    'tapsmith_list_devices',
    'List all connected mobile devices and emulators across all platforms. Returns serial numbers, platform (android/ios), model, and state. Use serial numbers with the device parameter on other tools (snapshot, tap, etc.) to target a specific device.',
    {},
    async () => {
      let devices = await listAllDevices();

      // In UI mode, only show devices that are part of the session
      const sessionDevices = getSessionDeviceSerials();
      if (sessionDevices) {
        devices = devices.filter(d => sessionDevices.has(d.serial));
      }

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
