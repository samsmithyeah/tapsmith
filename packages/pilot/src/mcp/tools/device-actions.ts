import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';
import { parseSelectorToInternal } from '../selector-helper.js';

function actionResult(success: boolean, errorMessage?: string) {
  if (!success && errorMessage) {
    return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: 'OK' }] };
}

export function registerDeviceActionTools(server: McpServer): void {
  server.tool(
    'pilot_tap',
    'Tap a UI element matching the given Pilot selector. Use pilot_snapshot first to find the right selector.',
    {
      selector: z.string().describe('Pilot selector, e.g. device.getByRole("button", { name: "Login" })'),
      device: z.string().optional().describe('Device serial (optional)'),
    },
    async ({ selector, device }) => {
      const client = await ensureConnected();
      if (device) await client.setDevice(device);
      const sel = parseSelectorToInternal(selector);
      const { success, errorMessage } = await client.tap(sel);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'pilot_type',
    'Type text into an element matching the selector. Set clear=true to replace existing text.',
    {
      selector: z.string().describe('Pilot selector for the text field'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing text before typing'),
      device: z.string().optional().describe('Device serial (optional)'),
    },
    async ({ selector, text, clear, device }) => {
      const client = await ensureConnected();
      if (device) await client.setDevice(device);
      const sel = parseSelectorToInternal(selector);
      if (clear) {
        await client.clearText(sel);
      }
      const { success, errorMessage } = await client.typeText(sel, text);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'pilot_swipe',
    'Swipe on the device screen in the given direction. Use to scroll or navigate between screens.',
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
      device: z.string().optional().describe('Device serial (optional)'),
    },
    async ({ direction, device }) => {
      const client = await ensureConnected();
      if (device) await client.setDevice(device);
      const { success, errorMessage } = await client.swipe(direction);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'pilot_press_key',
    'Press a device key. Common keys: back, home, enter, tab, delete.',
    {
      key: z.string().describe('Key name: back, home, enter, tab, delete, etc.'),
      device: z.string().optional().describe('Device serial (optional)'),
    },
    async ({ key, device }) => {
      const client = await ensureConnected();
      if (device) await client.setDevice(device);
      const { success, errorMessage } = await client.pressKey(key);
      return actionResult(success, errorMessage);
    },
  );
}
