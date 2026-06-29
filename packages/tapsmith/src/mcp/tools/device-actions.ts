import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';
import { resolveActionTarget } from '../selector-helper.js';

function actionResult(success: boolean, errorMessage?: string) {
  if (!success && errorMessage) {
    return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: 'OK' }] };
}

export function registerDeviceActionTools(server: McpServer): void {
  server.tool(
    'tapsmith_tap',
    'Tap a UI element matching the given Tapsmith selector. Use tapsmith_snapshot first to find the right selector.',
    {
      selector: z.string().describe('Tapsmith selector, e.g. device.getByRole("button", { name: "Login" })'),
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ selector, device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);
      // Strict mode (PILOT-226): resolve through the runtime find path so an
      // ambiguous selector errors with the match list instead of silently
      // tapping the first match.
      const target = await resolveActionTarget(client, selector);
      if (target.error) return actionResult(false, target.error);
      // Positional targets carry an elementId — act on that exact element.
      const { success, errorMessage } = await client.tap(target.elementId ? undefined : target.selector, undefined, target.elementId);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_type',
    'Type text into an element matching the selector. Set clear=true to replace existing text.',
    {
      selector: z.string().describe('Tapsmith selector for the text field'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing text before typing'),
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ selector, text, clear, device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);
      const target = await resolveActionTarget(client, selector);
      if (target.error) return actionResult(false, target.error);
      const sel = target.elementId ? undefined : target.selector;
      if (clear) {
        await client.clearText(sel, undefined, target.elementId);
      }
      const { success, errorMessage } = await client.typeText(sel, text, undefined, undefined, target.elementId);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_swipe',
    'Swipe on the device screen in the given direction. Use to scroll or navigate between screens.',
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ direction, device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);
      const { success, errorMessage } = await client.swipe(direction);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_press_key',
    'Press a device key. Common keys: back, home, enter, tab, delete.',
    {
      key: z.string().describe('Key name: back, home, enter, tab, delete, etc.'),
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ key, device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);
      const { success, errorMessage } = await client.pressKey(key);
      return actionResult(success, errorMessage);
    },
  );
}
